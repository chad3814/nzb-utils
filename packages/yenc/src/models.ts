/**
 * yEnc article model.
 *
 * A complete article looks like this, with CRLF line endings throughout:
 *
 * ```
 * =ybegin part=1 total=2 line=128 size=32 name=split.bin
 * =ypart begin=1 end=16
 * ...encoded payload lines...
 * =yend size=16 part=1 pcrc32=9da599ae
 * ```
 *
 * Single-part posts have **no `=ypart` line at all** — not an empty one. The
 * reference implementation reads `props.part.end` unconditionally and throws a
 * `TypeError` on every single-segment file, which in practice means every `.nfo`
 * and thumbnail in a release. {@link YencArticle.part} is nullable to make that
 * case impossible to ignore.
 */

/** Parsed `=ybegin` line. */
export interface YencHeader {
  /** 1-based part number, or null for a single-part post. */
  readonly part: number | null;
  /** Total part count, when the poster included it. */
  readonly total: number | null;
  /** Encoded line length. Advisory; decoding does not depend on it. */
  readonly line: number | null;
  /**
   * Decoded size of the **complete file**, not of this part. This is the
   * authoritative size the NZB could only estimate by summing encoded segment
   * byte counts and guessing at overhead.
   */
  readonly size: number;
  /** Authoritative filename. The NZB has no filename field at all. */
  readonly name: string;
}

/**
 * Where this part sits within the complete file, as a **0-based half-open**
 * range, matching `Blob.slice` and the rest of this repo.
 *
 * The wire format is neither: `=ypart begin=1 end=16` is 1-based and inclusive.
 * Converting is `begin - 1` and `end` unchanged, and getting it wrong writes
 * every part one byte off.
 */
export interface YencPartRange {
  readonly begin: number;
  readonly end: number;
}

/** Parsed `=yend` line. */
export interface YencTrailer {
  /** Decoded byte count the poster claims for this part. */
  readonly size: number;
  readonly part: number | null;
  /** CRC32 of the complete file, when present. */
  readonly crc32: number | null;
  /** CRC32 of this part alone, when present. */
  readonly pcrc32: number | null;
}

/**
 * Outcome of checking decoded bytes against the trailer.
 *
 * `matches` is `null`, not `false`, when the trailer carried no applicable
 * checksum — "nothing to check" and "check failed" are different answers and
 * collapsing them makes `--verify` meaningless on posts that omit the field.
 */
export interface YencChecksum {
  readonly expected: number | null;
  readonly actual: number;
  readonly matches: boolean | null;
}

export interface YencArticle {
  readonly header: YencHeader;
  /** Null for single-part posts. */
  readonly part: YencPartRange | null;
  readonly trailer: YencTrailer;
  readonly data: Buffer;
  readonly checksum: YencChecksum;
  /** Whether the decoded byte count agrees with the trailer's `size=`. */
  readonly sizeMatches: boolean;
}

export interface DecodeArticleOptions {
  /**
   * Throw {@link YencChecksumError} when the trailer's checksum disagrees with
   * the decoded bytes. A trailer with no checksum is not a failure.
   */
  readonly verify?: boolean;
}
