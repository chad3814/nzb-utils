import { decodeArticle, YencChecksumError } from '@chad3814/yenc';
import type { YencArticle } from '@chad3814/yenc';

import type { ArticleBody, ArticleSource } from './models.ts';

export interface FetchArticleOptions {
  /** Check the article against the CRC32 in its own `=yend` trailer. */
  readonly verify: boolean;
}

/** Record what went wrong underneath an error and hand it back, so a rethrow stays one expression. */
function causedBy(error: YencChecksumError, cause: unknown): YencChecksumError {
  error.cause = cause;
  return error;
}

/**
 * Fetch one article and decode it, trying another server if the CRC fails.
 *
 * A `pcrc32` mismatch means the bytes are wrong, and another provider is the
 * only fix — which is why this lives here rather than in the transport: yEnc
 * is decoded above it, so the pool cannot see the failure.
 *
 * It needs no retry counter. Each attempt adds the serving source to the
 * exclusion list, so a multi-server source runs out of candidates and throws.
 * Two guards cover sources that are not multi-server: one that reports no
 * server has nothing to exclude, and one that ignores the exclusion is stopped
 * the moment it repeats itself.
 *
 * That termination is an assumption on the source, not a proof internal to
 * this loop: it holds because a source draws `server` from a fixed, finite set
 * of names. A source that invented a fresh name every call — a counter, a UUID
 * — would never repeat and would never run out. That is worse than a slow
 * test: the loop is pure microtasks against a source that resolves
 * synchronously, so the event loop never reaches the timer phase, a test
 * timeout never fires, and the suite wedges rather than failing. Nothing here
 * checks for that; it is a contract on {@link ArticleSource}, not a case this
 * function defends against.
 */
export async function fetchArticle(
  source: ArticleSource,
  messageId: string,
  options: FetchArticleOptions,
): Promise<YencArticle> {
  const tried: string[] = [];
  /** The mismatch that sent us looking elsewhere, kept in case nowhere else has it. */
  let mismatch: YencChecksumError | null = null;

  for (;;) {
    let response: ArticleBody;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each attempt depends on the last
      response = await source.body(messageId, tried.length === 0 ? undefined : { exclude: tried });
    } catch (error) {
      if (mismatch === null) {
        throw error;
      }
      // A retry that cannot even be attempted must not erase what provoked it.
      // The realistic shape is a multi-server source with one server left to
      // exclude: excluding it leaves no candidate, and the source reports that
      // nothing was available -- the exact opposite of what happened, which is
      // that a server answered and its bytes were wrong. Report the mismatch,
      // and keep the source's own account of the walk as the cause. A plain
      // single pool never reaches here; it is the multi-server composition
      // that loses the error, because there the exclusion is what empties the
      // candidate list.
      throw causedBy(mismatch, error);
    }

    try {
      return decodeArticle(response.body, { verify: options.verify });
    } catch (error) {
      const { server } = response;
      // Only a checksum failure is worth another server. A malformed article is
      // malformed everywhere, and retrying it just spends someone's bytes.
      if (!(error instanceof YencChecksumError) || server === undefined || tried.includes(server)) {
        throw error;
      }
      mismatch = error;
      tried.push(server);
    }
  }
}
