import { NntpPool } from './pool.ts';
import {
  NntpAuthError,
  NntpCapacityError,
  NntpConnectionError,
  NntpProtocolError,
  NntpUnavailableError,
} from './errors.ts';
import type { NntpServerAttempt } from './errors.ts';
import type { NntpArticleResponse, NntpResponse } from './models.ts';
import type {
  ArticleFetchOptions,
  NntpMultiPoolOptions,
  NntpServerStat,
  NntpServerStatus,
} from './multi-pool-models.ts';

/**
 * Consecutive connection-level failures before a server leaves the rotation.
 *
 * Three, not one: a timeout on a single article is a bad moment, not a dead
 * provider. An auth failure bypasses this entirely -- it is deterministic.
 */
const DOWN_AFTER = 3;

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
 * State threaded through one `#run` walk, bundled so it can be passed to the
 * failure-classification helper instead of living as several loop locals.
 */
interface WalkState {
  requireSpillover: boolean;
  firstCapacityError: NntpCapacityError | null;
  /** Every server actually tried this walk, in order, with why it failed. */
  attempts: NntpServerAttempt[];
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
  /** Set when the primary cannot authenticate. Sticky, and rethrown to everyone. */
  #fatal: Error | null = null;

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

  #markDown(entry: ServerEntry, reason: Error): void {
    entry.state = 'down';
    entry.downReason = reason;
  }

  /**
   * Split out of `#run` to stay under the file's max-lines-per-function limit,
   * not for reuse -- there is exactly one call site.
   */
  #handleAuthFailure(entry: ServerEntry, error: NntpAuthError): void {
    if (entry === this.#servers[0]) {
      // The server you always use must be right. Failing over would run
      // the whole job on a backup because of a typo.
      this.#fatal = error;
      throw error;
    }
    // A backup that cannot log in is treated like one that is unreachable,
    // so a stale token does not abort a nearly-finished download. One
    // strike, because the outcome is deterministic.
    this.#markDown(entry, error);
  }

  /** Timeout, connection loss, or an unexpected status: transient until it is not. */
  #recordConnectionFailure(entry: ServerEntry, reason: Error): void {
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= DOWN_AFTER) {
      this.#markDown(entry, reason);
    }
  }

  /**
   * Classify one candidate's failure and update the walk's shared state.
   * Split out of `#run` to stay under the file's max-lines-per-function limit.
   *
   * Records the attempt before classifying, and unconditionally -- including
   * the 430 branch -- so that `walk.attempts` reflects every server actually
   * tried this walk, not just the ones that failed for a reason worth acting
   * on. That is what lets `#run` tell "every server said 430" from "we could
   * not find out" once the walk ends, and what stops an error type
   * `#handleFailure` has never seen before (a bug, not a protocol response)
   * from being silently folded into that same fallback. The fatal
   * primary-auth throw below also records first, but not for that reason --
   * the throw leaves `#run` immediately and nothing ever reads
   * `walk.attempts` on that path. It records first anyway, purely so this
   * stays one push instead of four call sites each doing their own.
   *
   * May throw: an auth failure on the primary is fatal, see
   * {@link #handleAuthFailure}. Everything else is recorded and swallowed so
   * the walk can move on to the next candidate.
   */
  #handleFailure(entry: ServerEntry, error: unknown, walk: WalkState): void {
    const reason = error instanceof Error ? error : new Error(String(error));
    walk.attempts.push({ server: entry.name, reason });

    if (reason instanceof NntpProtocolError && reason.code === 430) {
      // A gap, not a fault: this server does not have this article, which
      // says nothing about its health.
      return;
    }
    if (reason instanceof NntpCapacityError) {
      // Only reaches here when the pool could open no connection at all; a
      // partial cap is absorbed by the pool shrinking and queueing.
      walk.requireSpillover = true;
      if (walk.firstCapacityError === null) {
        walk.firstCapacityError = reason;
      }
      return;
    }
    if (reason instanceof NntpAuthError) {
      this.#handleAuthFailure(entry, reason);
      return;
    }
    this.#recordConnectionFailure(entry, reason);
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
   * Ask every server whether it has the article. Concurrent, unlike `#run`:
   * STAT costs a round trip and no meaningful bytes, so spillover need not
   * gate it. Diagnostic only -- never marks a server down or touches
   * `consecutiveFailures`; a server already `down` is reported `unknown`
   * with its recorded reason, not omitted.
   */
  async statAll(messageId: string): Promise<readonly NntpServerStat[]> {
    if (this.#fatal !== null) throw this.#fatal;

    return await Promise.all(
      this.#servers.map(async (entry): Promise<NntpServerStat> => {
        if (entry.state === 'down') {
          const reason = entry.downReason ?? new NntpConnectionError(`${entry.name} is down`);
          return { server: entry.name, status: 'unknown', reason };
        }
        try {
          await entry.pool.stat(messageId);
          return { server: entry.name, status: 'present' };
        } catch (error) {
          if (error instanceof NntpProtocolError && error.code === 430) {
            return { server: entry.name, status: 'absent' };
          }
          const reason = error instanceof Error ? error : new Error(String(error));
          return { server: entry.name, status: 'unknown', reason };
        }
      }),
    );
  }

  /**
   * Walk the candidates in order until one answers.
   *
   * Returns the raw response alongside the name rather than merging them here:
   * spreading a generic `T` does not typecheck as `T`, and each caller knows its
   * own concrete response type.
   *
   * `walk.requireSpillover` is sticky: once a server has been skipped because it
   * was full, everything after it is serving overflow rather than filling a gap,
   * and overflow is opt-in. `walk.firstCapacityError` keeps only the earliest
   * saturated server's error, because that account is the actionable one -- a
   * later server's cap (typically a backup/block account) is downstream noise
   * once the walk is already in overflow, and must never overwrite it. Failure
   * classification itself lives in {@link #handleFailure}.
   */
  async #run<T extends NntpResponse>(
    options: ArticleFetchOptions | undefined,
    call: (pool: NntpPool) => Promise<T>,
  ): Promise<{ response: T; server: string }> {
    if (this.#fatal !== null) {
      throw this.#fatal;
    }

    const excluded = new Set(options?.exclude ?? []);
    const walk: WalkState = { requireSpillover: false, firstCapacityError: null, attempts: [] };

    for (const entry of this.#servers) {
      if (entry.state === 'down' || excluded.has(entry.name)) {
        continue;
      }
      if (walk.requireSpillover && !entry.spillover) {
        continue;
      }

      try {
        // Sequential is the point: asking every server at once would spend a
        // metered account's bytes on every article.
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        const response = await call(entry.pool);
        entry.consecutiveFailures = 0;
        return { response, server: entry.name };
      } catch (error) {
        this.#handleFailure(entry, error, walk);
      }
    }

    if (walk.firstCapacityError !== null) {
      throw walk.firstCapacityError;
    }

    // Every candidate tried, and every one of them said 430: the article is
    // genuinely gone, not merely un-askable. `nzb get` depends on that
    // distinction to skip one missing file and keep going -- see
    // NntpUnavailableError's doc comment for why a mixed outcome throws that
    // instead.
    const allGone =
      walk.attempts.length > 0 &&
      walk.attempts.every(
        (attempt) => attempt.reason instanceof NntpProtocolError && attempt.reason.code === 430,
      );
    throw allGone
      ? new NntpProtocolError(430, 'No Such Article on any configured server')
      : new NntpUnavailableError(walk.attempts);
  }
}
