import type { NzbFile } from '@chad3814/nzb-parser';

/**
 * W3C `File`-like access to the contents of an NZB, with range-accurate segment
 * fetching: slicing a handle downloads only the articles that overlap the
 * requested range.
 *
 * This package never accepts credentials. It takes an {@link ArticleSource} —
 * a structural interface satisfied by an already-authenticated
 * `@chad3814/nntp` client, or by any test double. Authentication is the
 * transport's concern and stays there.
 */

/** A fetched article body. */
export interface ArticleBody {
  /**
   * Raw article bytes, CRLF preserved and **already dot-unstuffed**. yEnc
   * decoding does not remove dot-stuffing, so a source that skips it produces
   * silently corrupt output.
   */
  readonly body: Buffer;
}

/**
 * The transport seam: anything that can fetch one article by Message-ID.
 *
 * Structural on purpose. `@chad3814/nntp`'s client satisfies it, as does a
 * pool, a cache, or a fixture. Credentials never cross this boundary.
 */
export interface ArticleSource {
  /** @param messageId Message-ID **without** angle brackets, as stored in the NZB. */
  body(messageId: string): Promise<ArticleBody>;
}

/**
 * Decoded-byte geometry of a file's segments.
 *
 * Do not assume uniformity from a single article. `@thaunknown/yencode`-based
 * implementations commonly read `=ypart end=` from segment 1 and apply it to
 * every segment; that is wrong for variable-article-size posts and silently
 * returns bytes from the wrong offsets. Where per-segment sizes are not known,
 * {@link SegmentGeometry.uniform} must be `false` and offsets must be resolved
 * by fetching, not by multiplication.
 */
export interface SegmentGeometry {
  /** Decoded size of every segment except possibly the last. */
  readonly segmentSize: number;
  /** Decoded size of the final segment. */
  readonly lastSegmentSize: number;
  /** Total decoded size of the file, from the yEnc `=ybegin size=` header. */
  readonly totalSize: number;
  readonly segmentCount: number;
  /** False when per-segment sizes have not been proven equal. */
  readonly uniform: boolean;
}

/**
 * A half-open byte range, `[start, end)`.
 *
 * Half-open to match `Blob.slice` and the W3C `File` API. Note that HTTP `Range`
 * and Node's stream offsets are inclusive at the end — converting between them
 * is off-by-one bait.
 */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Which segments overlap a range, and how each must be trimmed.
 *
 * Resolving this is the core of the package and the thing most worth unit
 * testing: given a geometry and a range, the set of segments fetched must be
 * exactly those that overlap, and the concatenated output must be
 * byte-identical to slicing the whole file.
 */
export interface ResolvedRange {
  readonly range: ByteRange;
  readonly segments: readonly SegmentSlice[];
}

/**
 * Which part of one segment a range needs, derived from geometry alone.
 *
 * Deliberately carries no Message-ID: geometry is arithmetic over sizes, and
 * keeping it free of NZB identifiers is what makes it testable without a
 * document or a network.
 */
export interface SegmentSlice {
  /** 1-based segment number, matching the NZB. */
  readonly number: number;
  /** Offset within this segment's decoded bytes at which to begin copying. */
  readonly offsetInSegment: number;
  /** Number of bytes to copy from this segment. */
  readonly byteLength: number;
}

/** A {@link SegmentSlice} joined to the article that backs it. */
export interface ResolvedSegment extends SegmentSlice {
  readonly messageId: string;
}

/**
 * Handle for one file inside an NZB. Structurally compatible with W3C `File`.
 *
 * Slicing invariants, all of which the reference implementation
 * (`nzb-file@1.1.18`) gets wrong and which exist here to be enforced by tests:
 *
 * - `slice(n, n)` and `slice(0, 0)` yield an **empty** handle. `nzb-file`
 *   short-circuits on `end === 0` and returns a full-size clone, so
 *   `slice(0, 0).arrayBuffer()` downloads the entire file — 7.9 GiB for a
 *   typical 2160p release.
 * - Negative `start` / `end` are relative to the end of **this** handle.
 * - A nested slice is clamped to its parent's window, never to the original
 *   file's size. `nzb-file` clamps to the original, so a sub-slice can read past
 *   the range it was derived from.
 * - `slice()` performs no I/O. Only `arrayBuffer`, `bytes`, `text`, `stream`,
 *   and async iteration fetch articles.
 * - `arrayBuffer()` buffers the whole range in memory. For multi-gigabyte
 *   ranges use `stream()`; a 7.3 GiB `Uint8Array` allocation succeeds on Node
 *   24 and then costs 7.3 GiB of RSS.
 */
export interface NzbFileHandle extends AsyncIterable<Uint8Array> {
  /** Authoritative filename from the yEnc `=ybegin name=` header. */
  readonly name: string;
  /** Decoded byte length of this handle's range. */
  readonly size: number;
  /** MIME type inferred from {@link NzbFileHandle.name}. */
  readonly type: string;
  /** Article posting time, in epoch milliseconds. */
  readonly lastModified: number;
  readonly geometry: SegmentGeometry;
  /** The parsed NZB entry this handle was built from. */
  readonly source: NzbFile;

  slice(start?: number, end?: number, contentType?: string): NzbFileHandle;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  stream(): ReadableStream<Uint8Array>;
}
