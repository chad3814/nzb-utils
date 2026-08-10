import { NntpPool } from './pool.ts';
import { NntpProtocolError, NntpUnavailableError } from './errors.ts';
import type { NntpArticleResponse, NntpResponse } from './models.ts';
import type {
  ArticleFetchOptions,
  NntpMultiPoolOptions,
  NntpServerStat,
  NntpServerStatus,
} from './multi-pool-models.ts';
import { rule } from './multi-pool-failure.ts';
import type { ServerEntry, WalkState } from './multi-pool-failure.ts';

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
        down: null,
        consecutiveFailures: 0,
      };
    });
  }

  get servers(): readonly NntpServerStatus[] {
    return this.#servers.map((entry): NntpServerStatus => {
      // `state` and `downReason` are two views of one field. See ServerEntry
      // for why the entry does not carry them separately.
      const { down } = entry;
      return {
        name: entry.name,
        state: down === null ? 'ready' : 'down',
        downReason: down,
        limit: entry.pool.limit,
        failures: entry.pool.failures,
      };
    });
  }

  destroy(): void {
    for (const entry of this.#servers) {
      entry.pool.destroy();
    }
  }

  /**
   * Apply `rule`'s verdict for one candidate's failure. `rule` decides, this
   * method acts: it is the one place with access to `#fatal` and the
   * authority to fail every walk, not just this one.
   */
  #applyRuling(entry: ServerEntry, error: unknown, walk: WalkState): void {
    const ruling = rule(entry, error, walk, entry === this.#servers[0]);
    if (ruling.kind === 'fatal') {
      this.#fatal = ruling.error;
      throw ruling.error;
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
   * Ask every server whether it has the article.
   *
   * Concurrent, because STAT transfers no body: it costs a round trip and no
   * meaningful bytes, so it is not gated by the `spillover` option the way a
   * download is. Purely diagnostic -- it never marks a server down and never
   * counts toward the failure threshold. A server already marked down is
   * still reported, as `unknown` with its recorded reason, rather than
   * omitted -- the caller asked about every server.
   */
  async statAll(messageId: string): Promise<readonly NntpServerStat[]> {
    if (this.#fatal !== null) {
      throw this.#fatal;
    }

    return await Promise.all(
      this.#servers.map(async (entry): Promise<NntpServerStat> => {
        if (entry.down !== null) {
          return { server: entry.name, status: 'unknown', reason: entry.down };
        }

        try {
          await entry.pool.stat(messageId);
          return { server: entry.name, status: 'present' };
        } catch (error) {
          if (error instanceof NntpProtocolError && error.code === 430) {
            return { server: entry.name, status: 'absent' };
          }
          return {
            server: entry.name,
            status: 'unknown',
            reason: error instanceof Error ? error : new Error(String(error)),
          };
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
   * classification itself lives in {@link rule}, in multi-pool-failure.ts.
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
      if (entry.down !== null || excluded.has(entry.name)) {
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
        this.#applyRuling(entry, error, walk);
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
