import type { YencArticle } from '@chad3814/yenc';
import type { NzbFile } from '@chad3814/nzb-parser';

import { NzbGeometryError } from './errors.ts';
import { fetchArticle } from './fetch.ts';
import type { ArticleSource, SegmentGeometry } from './models.ts';

/**
 * Working out where each segment sits in the decoded file.
 *
 * An NZB says nothing about decoded sizes — only how many bytes each *article*
 * takes on the wire, which is 2–4% larger and varies with escape density. The
 * only authoritative statement of layout is the `=ypart begin=/end=` line
 * inside each article, and reading all of them means downloading the file.
 *
 * So this module predicts, then verifies:
 *
 * 1. {@link probeGeometry} fetches segment 1 alone and predicts that every
 *    segment is the same decoded size, with a shorter tail.
 * 2. {@link verifyPlacement} checks that prediction against each article's own
 *    header as it arrives, before a single byte of it is copied out.
 *
 * The prediction is right for essentially every real post, and costs one
 * article instead of all of them. When it is wrong, step 2 throws rather than
 * returning bytes from the wrong offsets — which is what `nzb-file@1.1.18`
 * does, silently, having taken step 1 and skipped step 2.
 */

/** The parts of the yEnc header that must be identical across a post's articles. */
export interface FileHeader {
  readonly name: string;
  readonly size: number;
}

export interface FileProbe {
  /** Authoritative filename, from `=ybegin name=`. The NZB has no such field. */
  readonly name: string;
  readonly geometry: SegmentGeometry;
  /** Segment 1, already decoded. Keeping it saves re-fetching it on a head read. */
  readonly first: YencArticle;
}

export interface ProbeOptions {
  /** Verify the article's CRC32 while decoding. Defaults to true. */
  readonly verify?: boolean;
}

export async function probeGeometry(
  file: NzbFile,
  source: ArticleSource,
  options: ProbeOptions = {},
): Promise<FileProbe> {
  const first = file.segments[0];
  if (first === undefined) {
    throw new NzbGeometryError('cannot open a file with no segments');
  }

  const article = await fetchArticle(source, first.messageId, { verify: options.verify ?? true });

  return {
    name: article.header.name,
    first: article,
    geometry: predict(article, file.segments.length),
  };
}

function predict(article: YencArticle, segmentCount: number): SegmentGeometry {
  const totalSize = article.header.size;
  const name = article.header.name;

  if (segmentCount === 1) {
    // One segment is the whole file, so there is nothing to predict. This is
    // also the case that has no `=ypart` line at all, which the reference
    // implementation reads unconditionally and crashes on.
    return {
      segmentSize: totalSize,
      lastSegmentSize: totalSize,
      totalSize,
      segmentCount: 1,
      uniform: true,
    };
  }

  if (article.part === null) {
    throw new NzbGeometryError(
      `segment 1 of ${name} has no =ypart line, but the file has ${String(segmentCount)} segments; ` +
        'nothing states where the part sits and guessing is not an option',
    );
  }
  if (article.part.begin !== 0) {
    throw new NzbGeometryError(
      `segment 1 of ${name} declares =ypart begin=${String(article.part.begin + 1)}, not 1; ` +
        'the first segment must start at the beginning of the file',
    );
  }

  const segmentSize = article.part.end - article.part.begin;
  const lastSegmentSize = totalSize - (segmentCount - 1) * segmentSize;

  return {
    segmentSize,
    lastSegmentSize,
    totalSize,
    segmentCount,
    // A tail that is empty, negative, or longer than a full segment means the
    // declared file size and segment 1's length cannot both be right about a
    // uniform post -- so the segments are not uniform, and this is detectable
    // before fetching anything else.
    uniform: segmentSize > 0 && lastSegmentSize > 0 && lastSegmentSize <= segmentSize,
  };
}

/**
 * Check one article against the geometry that caused it to be fetched.
 *
 * @param number 1-based segment number, matching the NZB.
 * @throws {NzbGeometryError} If the article is not the predicted part of the
 *   predicted file. Callers must run this before copying out of
 *   {@link YencArticle.data}; skipping it is exactly the reference
 *   implementation's bug.
 */
export function verifyPlacement(
  article: YencArticle,
  number: number,
  geometry: SegmentGeometry,
  expected: FileHeader,
): void {
  // `=ybegin name=` is deliberately not compared. Obfuscated posts randomise it
  // per article -- on the 1868-article post this was tested against, seven
  // probed articles carried seven different names alongside an identical
  // `size=` and exactly the predicted `=ypart` ranges. Requiring the names to
  // agree rejects most of Usenet, and what that check was reaching for --
  // "is this the article we asked for?" -- is covered better by the two below:
  // a substituted article would have to declare both the same whole-file size
  // and the exact byte range predicted for this segment.
  if (article.header.size !== expected.size) {
    throw new NzbGeometryError(
      `segment ${String(number)} of ${expected.name} declares a file size of ` +
        `${String(article.header.size)}, but segment 1 declared ${String(expected.size)}`,
    );
  }

  const index = number - 1;
  const start = index * geometry.segmentSize;
  const end =
    start + (index === geometry.segmentCount - 1 ? geometry.lastSegmentSize : geometry.segmentSize);

  if (article.part === null) {
    if (geometry.segmentCount !== 1) {
      throw new NzbGeometryError(
        `segment ${String(number)} of ${expected.name} has no =ypart line, so there is ` +
          'nothing to confirm it holds the bytes the geometry expects of it',
      );
    }
  } else if (article.part.begin !== start || article.part.end !== end) {
    throw new NzbGeometryError(
      `segment ${String(number)} of ${expected.name} is not where the geometry predicts: ` +
        `expected bytes [${String(start)}, ${String(end)}) but =ypart declares ` +
        `[${String(article.part.begin)}, ${String(article.part.end)}). ` +
        'This post is not uniformly segmented; its offsets cannot be computed.',
    );
  }

  if (article.data.length < end - start) {
    throw new NzbGeometryError(
      `segment ${String(number)} of ${expected.name} decoded to ${String(article.data.length)} ` +
        `bytes, short of the ${String(end - start)} its range claims`,
    );
  }
}
