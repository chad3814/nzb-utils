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
 * An NZB carries no decoded sizes, so this is *predicted* from segment 1 and
 * the declared file size, then *verified* against each article's own `=ypart`
 * header as it is fetched. Reading segment 1 and multiplying is what
 * `@thaunknown/yencode`-based implementations do; the difference here is the
 * second half, without which a variable-article-size post silently returns
 * bytes from the wrong offsets.
 *
 * A prediction is therefore never load-bearing on its own. Nothing in this
 * package copies bytes out of an article that has not been confirmed to hold
 * the range the geometry claimed for it.
 */
export interface SegmentGeometry {
  /** Decoded size of every segment except possibly the last. */
  readonly segmentSize: number;
  /** Decoded size of the final segment. */
  readonly lastSegmentSize: number;
  /** Total decoded size of the file, from the yEnc `=ybegin size=` header. */
  readonly totalSize: number;
  readonly segmentCount: number;
  /**
   * Whether segment offsets can be computed arithmetically at all.
   *
   * False when the declared file size and segment 1's length cannot both be
   * right about a uniformly-segmented post — detectable from the probe alone.
   * When false, {@link SegmentGeometry.segmentSize} and
   * {@link SegmentGeometry.lastSegmentSize} are the rejected prediction, kept
   * for diagnostics, and must not be used to locate bytes.
   */
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
 * Receives decoded bytes and the absolute offset in the file they belong at.
 *
 * Never called concurrently: {@link NzbFileHandle.writeTo} serialises the
 * handovers, so an implementation can write, hash or forward without any
 * locking of its own.
 */
export type ByteSink = (offset: number, chunk: Uint8Array) => void | Promise<void>;

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
  /**
   * Fetch this window and hand each article to `sink` at its true offset.
   *
   * Unlike the reading methods, this does **not** wait for order. A consumer
   * that writes at an offset does not need it, and insisting on it means a slow
   * article holds up every finished article behind it while the connections
   * that fetched them idle. Articles are handed over as they arrive.
   *
   * Offsets are absolute within the whole file, not relative to this window, so
   * a sliced handle writes into the right part of a sparse file without the
   * caller tracking where it started.
   *
   * @returns how many bytes were handed over.
   */
  writeTo(sink: ByteSink): Promise<number>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  stream(): ReadableStream<Uint8Array>;
}
