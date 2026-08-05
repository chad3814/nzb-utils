import type { ByteRange, ResolvedRange, SegmentGeometry, SegmentSlice } from './models.ts';

/**
 * Range arithmetic for slicing an NZB-backed file.
 *
 * Pure functions over sizes, with no document and no network, because this is
 * where the reference implementation went wrong and the failures are silent:
 * a bad range does not throw, it downloads the wrong bytes, or 7.9 GiB of the
 * right ones when you asked for none.
 */

/**
 * Resolve `Blob.slice`-style arguments against a window of `size` bytes.
 *
 * Semantics follow the W3C `File` API exactly:
 *
 * - Omitted `start` is 0; omitted `end` is `size`.
 * - A negative bound counts back from the end of the window.
 * - Both bounds clamp into `[0, size]`.
 * - `end <= start` yields an **empty** range. `nzb-file@1.1.18` instead
 *   short-circuits on `end === 0` and returns a full-size clone, turning a
 *   computed empty slice into a download of the entire file.
 *
 * Bounds are truncated toward zero, so a fractional argument cannot produce a
 * fractional offset that later lands mid-byte.
 */
export function normalizeSlice(size: number, start?: number, end?: number): ByteRange {
  const from = clamp(resolve(start, 0, size), size);
  const to = clamp(resolve(end, size, size), size);

  return to <= from ? { start: from, end: from } : { start: from, end: to };
}

function resolve(value: number | undefined, fallback: number, size: number): number {
  if (value === undefined || Number.isNaN(value)) {
    return Number.isNaN(value) ? 0 : fallback;
  }
  const truncated = Math.trunc(value);
  return truncated < 0 ? size + truncated : truncated;
}

function clamp(value: number, size: number): number {
  return Math.min(Math.max(value, 0), size);
}

/**
 * Work out which segments a byte range touches, and how much of each.
 *
 * @throws If the geometry is not proven uniform and the range is non-empty.
 *   Reading `=ypart end=` from segment 1 and multiplying is correct only for
 *   uniformly-sized posts; on a variable-article-size post it silently returns
 *   bytes from the wrong offsets, which is worse than refusing. An empty range
 *   is always safe, since it locates nothing.
 */
export function resolveRange(geometry: SegmentGeometry, range: ByteRange): ResolvedRange {
  const clamped = clampToFile(geometry, range);

  if (clamped.end <= clamped.start) {
    return { range: { start: clamped.start, end: clamped.start }, segments: [] };
  }

  if (!geometry.uniform) {
    throw new RangeError(
      'cannot resolve a byte range against a geometry that is not proven uniform; ' +
        'segment offsets must be measured, not inferred from segment 1',
    );
  }

  const segments: SegmentSlice[] = [];
  const first = Math.floor(clamped.start / geometry.segmentSize);
  const last = Math.floor((clamped.end - 1) / geometry.segmentSize);

  for (let index = first; index <= last && index < geometry.segmentCount; index += 1) {
    const segmentStart = index * geometry.segmentSize;
    const segmentEnd = segmentStart + sizeOf(geometry, index);

    const from = Math.max(clamped.start, segmentStart);
    const to = Math.min(clamped.end, segmentEnd);
    if (to <= from) {
      continue;
    }

    segments.push({
      number: index + 1,
      offsetInSegment: from - segmentStart,
      byteLength: to - from,
    });
  }

  return { range: clamped, segments };
}

function sizeOf(geometry: SegmentGeometry, index: number): number {
  return index === geometry.segmentCount - 1 ? geometry.lastSegmentSize : geometry.segmentSize;
}

function clampToFile(geometry: SegmentGeometry, range: ByteRange): ByteRange {
  const start = clamp(range.start, geometry.totalSize);
  const end = clamp(range.end, geometry.totalSize);
  return { start, end: Math.max(start, end) };
}
