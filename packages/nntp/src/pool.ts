import { memoizeCredentials } from './auth.ts';
import type { CredentialProviders } from './auth.ts';
import { NntpClient } from './client.ts';
import { NntpCapacityError, NntpConnectionError } from './errors.ts';
import type { NntpConnectionFailure } from './errors.ts';
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

/** A caller parked until a connection frees up. */
interface Waiter {
  readonly resolve: (client: NntpClient) => void;
  readonly reject: (error: unknown) => void;
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
  /**
   * Callers parked until a connection frees up.
   *
   * Rejectable, not just resolvable: a parked caller is only ever woken by a
   * connection being released, so when the pool can no longer release one the
   * wait has to end in an error rather than never ending.
   */
  readonly #waiting: Waiter[] = [];
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

  async body(messageId: string): Promise<NntpArticleResponse> {
    const response = await this.#withConnection((client) => client.body(messageId));
    return { ...response, server: this.#endpoint.host };
  }

  async head(messageId: string): Promise<NntpArticleResponse> {
    const response = await this.#withConnection((client) => client.head(messageId));
    return { ...response, server: this.#endpoint.host };
  }

  async article(messageId: string): Promise<NntpArticleResponse> {
    const response = await this.#withConnection((client) => client.article(messageId));
    return { ...response, server: this.#endpoint.host };
  }

  async stat(messageId: string): Promise<NntpResponse> {
    const response = await this.#withConnection((client) => client.stat(messageId));
    return { ...response, server: this.#endpoint.host };
  }

  destroy(): void {
    this.#destroyed = true;
    for (const client of this.#idle.splice(0)) {
      client.destroy();
    }
    this.#open = 0;
    // Anyone parked is waiting for a release that is now never coming.
    this.#failWaiting(new NntpConnectionError('pool has been destroyed'));
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

        if (this.#open === 0 && this.#idle.length === 0) {
          // This was the last chance of a connection, so nothing remains that
          // could wake anyone parked behind it.
          this.#failWaiting(error);
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
    // Take an idle connection if one is sitting there. Parking without looking
    // is what deadlocked 200 concurrent requests against a 100-connection
    // account: every open starts before any completes, so the connections that
    // succeeded had finished their work and gone idle while the refusals were
    // still arriving, and there was nothing left running to wake the parked.
    const idle = this.#idle.pop();
    if (idle !== undefined) {
      return Promise.resolve(idle);
    }

    return new Promise<NntpClient>((resolve, reject) => {
      this.#waiting.push({ resolve, reject });
    });
  }

  /** End every parked wait with an error, because no wake-up is coming. */
  #failWaiting(error: unknown): void {
    for (const waiter of this.#waiting.splice(0)) {
      waiter.reject(error);
    }
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
    next.resolve(client);
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

  async #replaceFor(waiter: Waiter): Promise<void> {
    try {
      waiter.resolve(await this.#openConnection());
    } catch (error) {
      this.#open -= 1;
      this.#record(error);

      const idle = this.#idle.pop();
      if (idle !== undefined) {
        waiter.resolve(idle);
        return;
      }

      if (this.#open === 0) {
        // No connection is live and none can be opened, so re-queueing would
        // park this caller on a release that cannot happen.
        waiter.reject(error);
        this.#failWaiting(error);
        return;
      }

      // Something is still running and will release; the caller's own timeout
      // bounds the wait.
      this.#waiting.unshift(waiter);
    }
  }

  #record(error: unknown): void {
    this.#failures.push({
      attempt: this.#failures.length,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
