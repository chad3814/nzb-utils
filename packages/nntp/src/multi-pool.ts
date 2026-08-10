import { NntpPool } from './pool.ts';
import type { NntpPoolOptions } from './pool.ts';
import type { NntpConnectionFailure } from './errors.ts';

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
}
