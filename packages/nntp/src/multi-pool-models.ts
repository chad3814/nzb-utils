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
