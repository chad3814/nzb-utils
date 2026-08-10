import { NntpPool } from './pool.ts';
import type { NntpPoolOptions } from './pool.ts';
import { NntpProtocolError } from './errors.ts';
import type { NntpConnectionFailure } from './errors.ts';
import type { NntpArticleResponse, NntpResponse } from './models.ts';

/**
 * One server in an ordered list.
 *
 * Extends {@link NntpPoolOptions} so a server is configured exactly as a single
 * pool is today — same endpoint, credentials, connection count and timeouts.
 */
export interface NntpServerOptions extends NntpPoolOptions {
  /** Stable name for failure reports and exclusions. Defaults to the host. */
  readonly name?: string;
  /**
   * May this server take work an earlier one could have served, when that one
   * is at its connection cap?
   *
   * Defaults to false. A metered block account should pay for gaps, not for
   * overflow the primary would have covered a moment later.
   */
  readonly spillover?: boolean;
}

export interface NntpMultiPoolOptions {
  /** Tried in order. The first is the primary. */
  readonly servers: readonly NntpServerOptions[];
}

/** Narrowing a request away from servers already tried for this article. */
export interface ArticleFetchOptions {
  /** Server names already tried. */
  readonly exclude?: readonly string[];
}

export interface NntpServerStatus {
  readonly name: string;
  readonly state: 'ready' | 'down';
  /** Why it went down. Null while ready. */
  readonly downReason: Error | null;
  /** Learned connection limit, which may be below the configured one. */
  readonly limit: number;
  readonly failures: readonly NntpConnectionFailure[];
}

/** Mutable per-server state. Deliberately holds no credential — see below. */
interface ServerEntry {
  readonly name: string;
  readonly spillover: boolean;
  readonly pool: NntpPool;
  state: 'ready' | 'down';
  downReason: Error | null;
  consecutiveFailures: number;
}

/**
 * An ordered list of servers, tried in turn.
 *
 * The purpose is filling gaps, not aggregating bandwidth: a later server is
 * reached only when an earlier one cannot supply the article. That is why
 * candidates are tried sequentially, and why taking overflow from a saturated
 * server is opt-in per server.
 *
 * Composes one {@link NntpPool} per server rather than teaching one pool about
 * several endpoints, because the learned connection cap, the credential and the
 * up/down state are all per-server. This class manages no sockets.
 */
export class NntpMultiPool {
  readonly #servers: ServerEntry[];

  constructor(options: NntpMultiPoolOptions) {
    if (options.servers.length === 0) {
      throw new TypeError('NntpMultiPool needs at least one server');
    }

    const seen = new Set<string>();
    // Destructured, not retained: `options.servers` entries carry `credentials`,
    // and keeping one on a field would put a credential -- or a provider closure
    // -- on an instance, which hard rule 3 forbids and client.test.ts scans for.
    // The credential ends up only inside its own pool's memoized providers.
    this.#servers = options.servers.map((server): ServerEntry => {
      const name = server.name ?? server.endpoint.host;
      if (seen.has(name)) {
        throw new TypeError(
          `duplicate server name ${JSON.stringify(name)}; names must be unique because exclusions are by name`,
        );
      }
      seen.add(name);

      return {
        name,
        spillover: server.spillover ?? false,
        pool: new NntpPool(server),
        state: 'ready',
        downReason: null,
        consecutiveFailures: 0,
      };
    });
  }

  get servers(): readonly NntpServerStatus[] {
    return this.#servers.map((entry) => ({
      name: entry.name,
      state: entry.state,
      downReason: entry.downReason,
      limit: entry.pool.limit,
      failures: entry.pool.failures,
    }));
  }

  destroy(): void {
    for (const entry of this.#servers) {
      entry.pool.destroy();
    }
  }

  async body(messageId: string, options?: ArticleFetchOptions): Promise<NntpArticleResponse> {
    const { response, server } = await this.#run(options, (pool) => pool.body(messageId));
    return { ...response, server };
  }

  async head(messageId: string, options?: ArticleFetchOptions): Promise<NntpArticleResponse> {
    const { response, server } = await this.#run(options, (pool) => pool.head(messageId));
    return { ...response, server };
  }

  async article(messageId: string, options?: ArticleFetchOptions): Promise<NntpArticleResponse> {
    const { response, server } = await this.#run(options, (pool) => pool.article(messageId));
    return { ...response, server };
  }

  async stat(messageId: string, options?: ArticleFetchOptions): Promise<NntpResponse> {
    const { response, server } = await this.#run(options, (pool) => pool.stat(messageId));
    return { ...response, server };
  }

  /**
   * Walk the candidates in order until one answers.
   *
   * Returns the raw response alongside the name rather than merging them here:
   * spreading a generic `T` does not typecheck as `T`, and each caller knows its
   * own concrete response type.
   */
  async #run<T extends NntpResponse>(
    options: ArticleFetchOptions | undefined,
    call: (pool: NntpPool) => Promise<T>,
  ): Promise<{ response: T; server: string }> {
    const excluded = new Set(options?.exclude ?? []);

    for (const entry of this.#servers) {
      if (entry.state === 'down' || excluded.has(entry.name)) {
        continue;
      }

      try {
        /* oxlint-disable-next-line no-await-in-loop -- sequential is the point:
           asking every server at once would spend backup bytes on every article */
        const response = await call(entry.pool);
        entry.consecutiveFailures = 0;
        return { response, server: entry.name };
      } catch (error) {
        if (error instanceof NntpProtocolError && error.code === 430) {
          // A gap, not a fault: this server does not have this article, which
          // says nothing about its health.
          continue;
        }
        throw error;
      }
    }

    throw new NntpProtocolError(430, 'No Such Article on any configured server');
  }
}
