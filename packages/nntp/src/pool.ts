import { memoizeCredentials } from './auth.ts';
import type { CredentialProviders } from './auth.ts';
import { NntpClient } from './client.ts';
import { NntpCapacityError, NntpConnectionError } from './errors.ts';
import type { NntpArticleResponse, NntpCredentials, NntpEndpoint, NntpResponse } from './models.ts';

export interface NntpPoolOptions {
  readonly endpoint: NntpEndpoint;
  /**
   * Used to authenticate each connection as it is opened. Never readable back
   * off the pool, never logged, never included in an error.
   *
   * Literals and providers are both accepted; both are normalised to a provider
   * and memoized once here, so a pool of eight connections makes one trip to the
   * underlying source rather than eight. See
   * {@link NntpPoolOptions.credentialTtlMs} for the expiry that goes with that.
   */
  readonly credentials: NntpCredentials;
  /**
   * How long a resolved credential stays cached, in milliseconds.
   *
   * Set this when the credential comes from something that issues them with a
   * lifetime. Without it the value is cached for the life of the pool, and a
   * pool outliving its token keeps presenting an expired one — which the server
   * reports as an authentication failure, indistinguishable from a wrong
   * password.
   *
   * The clock starts when the value arrives, not when it was requested.
   */
  readonly credentialTtlMs?: number;
  /**
   * Maximum simultaneous connections. Usenet providers cap this; respect their
   * cap.
   */
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
  #limit: number;
  readonly #timeoutMs: number | undefined;
  /**
   * Held to authenticate new connections; never exposed.
   *
   * These are memoized providers, so their closures retain the resolved
   * credential until it expires. That is a deliberate trade for not making a
   * vault round-trip per connection, and `credentialTtlMs` is what bounds it.
   */
  readonly #login: CredentialProviders;

  readonly #idle: NntpClient[] = [];
  readonly #waiting: ((client: NntpClient) => void)[] = [];
  readonly #failures: NntpConnectionFailure[] = [];

  #open = 0;
  #destroyed = false;

  constructor(options: NntpPoolOptions) {
    this.#endpoint = options.endpoint;
    this.#limit = Math.max(1, options.connections);
    this.#timeoutMs = options.timeoutMs;
    this.#login = memoizeCredentials(options.credentials, options.credentialTtlMs);
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

        if (error instanceof NntpCapacityError && this.#open > 0) {
          // The provider's cap is lower than the one configured. That is a fact
          // about the account, not a failure of this request: shrink to what
          // the server will actually give us and wait for a live connection
          // rather than failing work that is perfectly fetchable. Propagating
          // here is what turned "-c 8 on a 4-connection account" into six of
          // eight files reported unavailable.
          this.#limit = this.#open;
          return this.#waitForConnection();
        }

        throw error;
      }
    }

    return this.#waitForConnection();
  }

  /** Effective connection limit, which may be below the configured one. */
  get limit(): number {
    return this.#limit;
  }

  #waitForConnection(): Promise<NntpClient> {
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
