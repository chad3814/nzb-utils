import { describe, expect, it } from 'vitest';

import { normalizeSlice, resolveRange } from '../src/range.ts';
import type { SegmentGeometry } from '../src/models.ts';

/** Four 10-byte segments and a 5-byte tail: 45 bytes over 5 segments. */
const GEOMETRY: SegmentGeometry = {
  segmentSize: 10,
  lastSegmentSize: 5,
  totalSize: 45,
  segmentCount: 5,
  uniform: true,
};

describe('normalizeSlice', () => {
  it('returns the whole window when given no arguments', () => {
    expect(normalizeSlice(100)).toEqual({ start: 0, end: 100 });
  });

  it('returns an empty range for slice(0, 0)', () => {
    // The reference implementation short-circuits on `end === 0` and returns a
    // full-size clone, so `slice(0, 0).arrayBuffer()` downloads the entire
    // file -- 1868 articles and 7.9 GiB for a typical 2160p release.
    expect(normalizeSlice(100, 0, 0)).toEqual({ start: 0, end: 0 });
  });

  it('returns an empty range for any slice(n, n)', () => {
    expect(normalizeSlice(100, 42, 42)).toEqual({ start: 42, end: 42 });
  });

  it('returns an empty range when end precedes start', () => {
    expect(normalizeSlice(100, 30, 10)).toEqual({ start: 30, end: 30 });
  });

  it('treats a negative start as an offset from the end', () => {
    expect(normalizeSlice(100, -10)).toEqual({ start: 90, end: 100 });
  });

  it('treats a negative end as an offset from the end', () => {
    expect(normalizeSlice(100, 10, -10)).toEqual({ start: 10, end: 90 });
  });

  it('handles both bounds negative', () => {
    expect(normalizeSlice(100, -20, -10)).toEqual({ start: 80, end: 90 });
  });

  it('clamps an over-large end to the window size', () => {
    expect(normalizeSlice(100, 0, 1_000_000)).toEqual({ start: 0, end: 100 });
  });

  it('clamps an over-negative start to zero', () => {
    expect(normalizeSlice(100, -1_000_000)).toEqual({ start: 0, end: 100 });
  });

  it('clamps a start beyond the end of the window', () => {
    expect(normalizeSlice(100, 500)).toEqual({ start: 100, end: 100 });
  });

  it('returns an empty range for a zero-length window', () => {
    expect(normalizeSlice(0)).toEqual({ start: 0, end: 0 });
  });

  it('truncates a fractional bound rather than producing a fractional offset', () => {
    expect(normalizeSlice(100, 1.9, 10.9)).toEqual({ start: 1, end: 10 });
  });

  it('treats NaN as zero, matching Blob.slice', () => {
    expect(normalizeSlice(100, Number.NaN, Number.NaN)).toEqual({ start: 0, end: 0 });
  });
});

describe('resolveRange', () => {
  it('maps a range inside one segment to that segment alone', () => {
    expect(resolveRange(GEOMETRY, { start: 2, end: 8 })).toEqual({
      range: { start: 2, end: 8 },
      segments: [{ number: 1, offsetInSegment: 2, byteLength: 6 }],
    });
  });

  it('fetches nothing for an empty range', () => {
    // This is the payoff for slice(0, 0) being empty: no articles at all.
    expect(resolveRange(GEOMETRY, { start: 0, end: 0 }).segments).toEqual([]);
  });

  it('fetches nothing for an empty range in the middle of the file', () => {
    expect(resolveRange(GEOMETRY, { start: 25, end: 25 }).segments).toEqual([]);
  });

  it('spans two segments across a boundary', () => {
    expect(resolveRange(GEOMETRY, { start: 8, end: 12 }).segments).toEqual([
      { number: 1, offsetInSegment: 8, byteLength: 2 },
      { number: 2, offsetInSegment: 0, byteLength: 2 },
    ]);
  });

  it('does not include a segment the range merely abuts', () => {
    // [0, 10) ends exactly where segment 2 begins. Fetching segment 2 here is
    // a wasted article on every aligned read.
    expect(resolveRange(GEOMETRY, { start: 0, end: 10 }).segments).toEqual([
      { number: 1, offsetInSegment: 0, byteLength: 10 },
    ]);
  });

  it('covers every segment for the whole file', () => {
    const resolved = resolveRange(GEOMETRY, { start: 0, end: 45 });

    expect(resolved.segments.map((s) => s.number)).toEqual([1, 2, 3, 4, 5]);
    expect(resolved.segments.reduce((n, s) => n + s.byteLength, 0)).toBe(45);
  });

  it('handles the short final segment', () => {
    expect(resolveRange(GEOMETRY, { start: 42, end: 45 }).segments).toEqual([
      { number: 5, offsetInSegment: 2, byteLength: 3 },
    ]);
  });

  it('never resolves past the end of the file', () => {
    const resolved = resolveRange(GEOMETRY, { start: 40, end: 45 });

    expect(resolved.segments.at(-1)?.number).toBe(5);
    expect(resolved.segments.reduce((n, s) => n + s.byteLength, 0)).toBe(5);
  });

  it('produces byte lengths summing to the range length for every sub-range', () => {
    for (let start = 0; start <= 45; start += 1) {
      for (let end = start; end <= 45; end += 7) {
        const resolved = resolveRange(GEOMETRY, { start, end });
        const total = resolved.segments.reduce((n, s) => n + s.byteLength, 0);
        expect(total, `range [${start}, ${end})`).toBe(end - start);
      }
    }
  });

  it('resolves contiguously, with no gaps or overlaps between segments', () => {
    const resolved = resolveRange(GEOMETRY, { start: 3, end: 44 });
    let expectedStart = 3;

    for (const segment of resolved.segments) {
      const absolute = (segment.number - 1) * GEOMETRY.segmentSize + segment.offsetInSegment;
      expect(absolute).toBe(expectedStart);
      expectedStart += segment.byteLength;
    }

    expect(expectedStart).toBe(44);
  });

  it('clamps a reported range that runs past the end of the file', () => {
    // resolveRange is exported, so it can be handed a range that normalizeSlice
    // never would. The segment list is already bounded by segmentCount, but the
    // echoed range has to be truthful or a caller sizing a buffer from it
    // allocates for bytes that do not exist.
    const resolved = resolveRange(GEOMETRY, { start: 40, end: 100 });

    expect(resolved.range).toEqual({ start: 40, end: 45 });
    expect(resolved.segments.reduce((n, s) => n + s.byteLength, 0)).toBe(5);
  });

  it('clamps a range that starts past the end of the file', () => {
    expect(resolveRange(GEOMETRY, { start: 100, end: 200 })).toEqual({
      range: { start: 45, end: 45 },
      segments: [],
    });
  });

  it('refuses to resolve against a geometry that is not proven uniform', () => {
    // Inferring segment size from segment 1 and multiplying is wrong for
    // variable-article-size posts and silently returns bytes from the wrong
    // offsets. Offsets must come from measurement, not arithmetic.
    const unproven: SegmentGeometry = { ...GEOMETRY, uniform: false };

    expect(() => resolveRange(unproven, { start: 0, end: 10 })).toThrow(/uniform/u);
  });

  it('resolves an empty range against a non-uniform geometry without complaint', () => {
    // Nothing to locate, so there is nothing to get wrong.
    const unproven: SegmentGeometry = { ...GEOMETRY, uniform: false };

    expect(resolveRange(unproven, { start: 5, end: 5 }).segments).toEqual([]);
  });
});
