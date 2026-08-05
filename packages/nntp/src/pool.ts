import { NntpClient } from './client.ts';
import { NntpConnectionError } from './errors.ts';
import type { NntpArticleResponse, NntpCredentials, NntpEndpoint, NntpResponse } from './models.ts';

export interface NntpPoolOptions {
  readonly endpoint: NntpEndpoint;
  /**
   * Used to authenticate each connection as it is opened, then dropped. Not
   * stored on the pool, not readable back off it, and never included in an
   * error.
   */
  readonly credentials: NntpCredentials;
  /** Maximum simultaneous connections. Providers cap this; respect their cap. */
  readonly connections: number;
  readonly timeoutMs?: number;
}

/** Why one connection attempt failed, kept per attempt rather than merged. */
export interface NntpConnectionFailure {
  readonly at: number;
  readonly reason: string;
}

/**
 * A lazily-filled pool of authenticated connections.
 *
 * Two deliberate departures from the reference implementation:
 *
 * 1. **Connections open on demand,** not in the constructor. Opening 24
 *    sockets, doing 24 TLS handshakes and 24 logins to fetch a two-article,
 *    172 KB preview is pure latency.
 * 2. **Failures stay attributable.** The reference pool catches every
 *    per-connection error bare and reports one generic "failed to establish
 *    any NNTP connections", so a wrong password, a provider connection cap and
 *    a DNS failure are indistinguishable. Here the originating error
 *    propagates and {@link failures} keeps the history.
 */
export class NntpPool {
  readonly #endpoint: NntpEndpoint;
  readonly #limit: number;
  readonly #timeoutMs: number | undefined;
  /** Held to authenticate new connections; never exposed. */
  readonly #login: NntpCredentials;

  readonly #idle: NntpClient[] = [];
  readonly #waiting: ((client: NntpClient) => void)[] = [];
  readonly #failures: NntpConnectionFailure[] = [];

  #open = 0;
  #destroyed = false;

  constructor(options: NntpPoolOptions) {
    this.#endpoint = options.endpoint;
    this.#limit = Math.max(1, options.connections);
    this.#timeoutMs = options.timeoutMs;
    this.#login = { user: options.credentials.user, pass: options.credentials.pass };
  }

  /** Per-attempt connection failures, most recent last. */
  get failures(): readonly NntpConnectionFailure[] {
    return this.#failures;
  }

  body(messageId: string): Promise<NntpArticleResponse> {
    return this.#withConnection((client) => client.body(messageId));
  }

  head(messageId: string): Promise<NntpArticleResponse> {
    return this.#withConnection((client) => client.head(messageId));
  }

  article(messageId: string): Promise<NntpArticleResponse> {
    return this.#withConnection((client) => client.article(messageId));
  }

  stat(messageId: string): Promise<NntpResponse> {
    return this.#withConnection((client) => client.stat(messageId));
  }

  destroy(): void {
    this.#destroyed = true;
    for (const client of this.#idle.splice(0)) {
      client.destroy();
    }
    this.#open = 0;
  }

  async #withConnection<T>(run: (client: NntpClient) => Promise<T>): Promise<T> {
    if (this.#destroyed) {
      throw new NntpConnectionError('pool has been destroyed');
    }

    const client = await this.#acquire();

    try {
      const result = await run(client);
      this.#release(client);
      return result;
    } catch (error) {
      // A failed command may have left the socket mid-response, so the
      // connection is discarded rather than handed to the next caller. The
      // reference pool re-enqueues in a `finally` with no health check and
      // then serves the same dead socket repeatedly.
      this.#discard(client);
      throw error;
    }
  }

  async #acquire(): Promise<NntpClient> {
    const idle = this.#idle.pop();
    if (idle !== undefined) {
      return idle;
    }

    if (this.#open < this.#limit) {
      this.#open += 1;
      try {
        return await this.#openConnection();
      } catch (error) {
        this.#open -= 1;
        this.#record(error);
        throw error;
      }
    }

    return new Promise<NntpClient>((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  async #openConnection(): Promise<NntpClient> {
    const client = new NntpClient({
      host: this.#endpoint.host,
      port: this.#endpoint.port,
      security: this.#endpoint.security,
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
    });

    try {
      await client.connect();
      await client.authenticate(this.#login);
      return client;
    } catch (error) {
      client.destroy();
      throw error;
    }
  }

  #release(client: NntpClient): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#idle.push(client);
      return;
    }
    next(client);
  }

  #discard(client: NntpClient): void {
    client.destroy();
    this.#open -= 1;

    // Someone may be blocked waiting for a connection that just died. Open a
    // replacement rather than leaving them parked forever.
    const next = this.#waiting.shift();
    if (next === undefined) {
      return;
    }

    this.#open += 1;
    void this.#replaceFor(next);
  }

  async #replaceFor(waiter: (client: NntpClient) => void): Promise<void> {
    try {
      waiter(await this.#openConnection());
    } catch (error) {
      this.#open -= 1;
      this.#record(error);
      // Re-queue the waiter so a later successful acquire can serve it; the
      // caller's own timeout bounds the wait.
      this.#waiting.unshift(waiter);
    }
  }

  #record(error: unknown): void {
    this.#failures.push({
      at: this.#failures.length,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
