import { runAuthInfo } from './auth.ts';
import { NntpConnectionError, NntpProtocolError, NntpTimeoutError } from './errors.ts';
import { NNTP_STATUS } from './models.ts';
import type { NntpArticleResponse, NntpCredentials, NntpEndpoint, NntpResponse } from './models.ts';
import { ResponseBuffer } from './response-buffer.ts';
import { openSocket, upgradeToTls } from './socket.ts';
import { redact, wrapMessageId } from './wire.ts';
import type { NntpSocket } from './socket.ts';

export interface NntpClientOptions extends NntpEndpoint {
  /** Per-command deadline. A stalled provider is common enough to plan for. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const STATUS_LINE = /^(\d{3})[ -]?(.*)$/u;

/** Settles the command lock without caring how the command turned out. */
const ignore = (): void => {};

interface Waiter {
  readonly kind: 'line' | 'block';
  readonly resolve: (value: string | Buffer) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * NNTP client (RFC 3977, AUTHINFO from RFC 4643).
 *
 * Message-IDs are passed **without** angle brackets — the form an NZB stores —
 * and wrapped on the wire here. Passing a bare ID to a server is a `430` on
 * every article.
 *
 * Credentials are accepted only by {@link authenticate}, used to build one
 * command, and then dropped. They are never assigned to a field, logged, or
 * included in an error.
 */
export class NntpClient {
  readonly #endpoint: NntpEndpoint;
  readonly #timeoutMs: number;
  readonly #buffer = new ResponseBuffer();

  #socket: NntpSocket | null = null;
  #waiter: Waiter | null = null;
  #failure: Error | null = null;
  /** Serializes commands so two in-flight requests cannot interleave. */
  #lock: Promise<unknown> = Promise.resolve();

  constructor(options: NntpClientOptions) {
    this.#endpoint = {
      host: options.host,
      port: options.port,
      security: options.security,
    };
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async connect(): Promise<NntpResponse> {
    const socket = await openSocket(this.#endpoint);
    this.#attach(socket);

    const greeting = this.#parse(await this.#expectLine('greeting'));
    if (
      greeting.code !== NNTP_STATUS.readyPostingAllowed &&
      greeting.code !== NNTP_STATUS.readyPostingProhibited
    ) {
      throw new NntpProtocolError(greeting.code, greeting.message);
    }

    if (this.#endpoint.security === 'starttls') {
      await this.#startTls();
    }

    return greeting;
  }

  /**
   * @param credentials Either literals or providers. Resolved here, used to
   *   build one command each, and never retained — a resolved secret exists
   *   only as a local. Do not log the argument at a call site either; that
   *   defeats the point.
   *
   *   Resolution happens inside the command lock so nothing can interleave
   *   between obtaining a credential and sending it, and the password is
   *   resolved only if the server asks for one.
   */
  authenticate(credentials: NntpCredentials): Promise<NntpResponse> {
    // Held inside the command lock for the whole exchange, resolution included,
    // so nothing can interleave between obtaining a credential and sending it.
    return this.#serialize(() =>
      runAuthInfo(credentials, async (line, label) =>
        this.#parse(await this.#command(line, label)),
      ),
    );
  }

  group(name: string): Promise<NntpResponse> {
    return this.#simple(`GROUP ${name}`, 211);
  }

  /** Existence check that transfers no payload. */
  stat(messageId: string): Promise<NntpResponse> {
    return this.#simple(`STAT ${wrapMessageId(messageId)}`, NNTP_STATUS.articleExists);
  }

  head(messageId: string): Promise<NntpArticleResponse> {
    return this.#multiline(`HEAD ${wrapMessageId(messageId)}`, NNTP_STATUS.headFollows);
  }

  body(messageId: string): Promise<NntpArticleResponse> {
    return this.#multiline(`BODY ${wrapMessageId(messageId)}`, NNTP_STATUS.bodyFollows);
  }

  article(messageId: string): Promise<NntpArticleResponse> {
    return this.#multiline(`ARTICLE ${wrapMessageId(messageId)}`, NNTP_STATUS.articleFollows);
  }

  async quit(): Promise<void> {
    if (this.#socket === null) {
      return;
    }
    try {
      await this.#simple('QUIT', NNTP_STATUS.closing);
    } finally {
      this.destroy();
    }
  }

  /** Tear down the socket without a protocol handshake. */
  destroy(): void {
    this.#socket?.destroy();
    this.#socket = null;
    this.#settleWaiter(new NntpConnectionError('connection destroyed'));
  }

  #simple(command: string, expected: number): Promise<NntpResponse> {
    return this.#serialize(async () => {
      const response = this.#parse(await this.#command(command, command));
      if (response.code !== expected) {
        throw new NntpProtocolError(response.code, response.message);
      }
      return response;
    });
  }

  #multiline(command: string, expected: number): Promise<NntpArticleResponse> {
    return this.#serialize(async () => {
      const response = this.#parse(await this.#command(command, command));
      // Read the block only on success. Waiting for a body after a 430 stalls
      // until the timeout, because no body is coming.
      if (response.code !== expected) {
        throw new NntpProtocolError(response.code, response.message);
      }

      const body = await this.#expectBlock(command);
      return { ...response, body };
    });
  }

  #command(command: string, label: string): Promise<string> {
    this.#requireSocket().write(`${command}\r\n`);
    return this.#expectLine(label);
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.#lock;
    const current = previous.then(run, run);
    this.#lock = current.then(ignore, ignore);
    return current;
  }

  #expectLine(label: string): Promise<string> {
    return this.#wait('line', label).then((value) =>
      typeof value === 'string' ? value : value.toString('latin1'),
    );
  }

  #expectBlock(label: string): Promise<Buffer> {
    return this.#wait('block', label).then((value) =>
      typeof value === 'string' ? Buffer.from(value, 'latin1') : value,
    );
  }

  #wait(kind: 'line' | 'block', label: string): Promise<string | Buffer> {
    if (this.#failure !== null) {
      return Promise.reject(this.#failure);
    }
    if (this.#waiter !== null) {
      return Promise.reject(new NntpConnectionError('a command is already awaiting a response'));
    }

    return new Promise<string | Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new NntpTimeoutError(redact(label), this.#timeoutMs));
      }, this.#timeoutMs);
      // A pending read must never hold the process open on its own.
      timer.unref?.();

      this.#waiter = { kind, resolve, reject, timer };
      this.#drain();
    });
  }

  #drain(): void {
    const waiter = this.#waiter;
    if (waiter === null) {
      return;
    }

    const value = waiter.kind === 'line' ? this.#buffer.takeLine() : this.#buffer.takeBlock();
    if (value === null) {
      return;
    }

    clearTimeout(waiter.timer);
    this.#waiter = null;
    waiter.resolve(value);
  }

  #attach(socket: NntpSocket): void {
    this.#socket = socket;
    this.#failure = null;

    socket.on('data', (chunk: Buffer) => {
      this.#buffer.push(chunk);
      this.#drain();
    });

    socket.on('error', (error: Error) => {
      this.#fail(new NntpConnectionError(`socket error: ${error.message}`, { cause: error }));
    });

    socket.on('close', () => {
      this.#fail(new NntpConnectionError('connection closed by peer'));
    });
  }

  #fail(error: Error): void {
    this.#failure = error;
    this.#settleWaiter(error);
  }

  #settleWaiter(error: Error): void {
    const waiter = this.#waiter;
    if (waiter === null) {
      return;
    }
    clearTimeout(waiter.timer);
    this.#waiter = null;
    waiter.reject(error);
  }

  /** Negotiate STARTTLS, then re-attach to the upgraded socket. */
  async #startTls(): Promise<void> {
    const plain = this.#requireSocket();
    const response = this.#parse(await this.#command('STARTTLS', 'STARTTLS'));
    if (response.code !== 382) {
      throw new NntpProtocolError(response.code, response.message);
    }
    this.#attach(await upgradeToTls(plain, this.#endpoint.host));
  }

  #requireSocket(): NntpSocket {
    if (this.#socket === null) {
      throw new NntpConnectionError('not connected');
    }
    return this.#socket;
  }

  #parse(line: string): NntpResponse {
    const match = STATUS_LINE.exec(line);
    if (match === null) {
      throw new NntpProtocolError(0, `unparsable status line: "${redact(line)}"`);
    }
    const [, code, message] = match;
    return { code: Number(code ?? '0'), message: message ?? '' };
  }
}
