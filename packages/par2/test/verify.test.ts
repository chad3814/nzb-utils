import { describe, expect, it } from 'vitest';

import { parsePar2 } from '../src/parse.ts';
import type { Par2File } from '../src/parse.ts';
import { Par2FileVerifier, looksLike, verifyFile } from '../src/verify.ts';
import { buildSet } from './fixture.ts';

/** Flip a byte. Indexed access is `| undefined` under noUncheckedIndexedAccess. */
function flip(data: Buffer, at: number): void {
  data[at] = (data[at] ?? 0) ^ 0xff;
}

const SLICE = 64;

/** 210 bytes: three full slices and an 18-byte tail that must be zero-padded. */
const RAGGED = Buffer.from(Array.from({ length: 210 }, (_, index) => (index * 37 + 11) % 256));
/** Exactly two slices, so the padding path is never taken. */
const EXACT = Buffer.from(Array.from({ length: 128 }, (_, index) => index % 256));

function setFor(data: Buffer, name = 'ragged.bin'): { file: Par2File; sliceSize: number } {
  const set = parsePar2(buildSet({ sliceSize: SLICE, files: [{ name, data }] }).bytes);
  const file = set.files[0];
  if (file === undefined) {
    throw new Error('fixture produced no file');
  }
  return { file, sliceSize: set.sliceSize };
}

describe('verifyFile', () => {
  it('accepts the bytes the set describes', () => {
    const { file, sliceSize } = setFor(RAGGED);

    const result = verifyFile(file, sliceSize, RAGGED);

    expect(result.ok).toBe(true);
    expect(result.md5Matches).toBe(true);
    expect(result.damagedSlices).toEqual([]);
  });

  it('zero-pads the final short slice, as the spec requires', () => {
    // Hashing the 18-byte tail as-is instead of padding it to 64 makes the last
    // slice of nearly every real file look damaged.
    const { file, sliceSize } = setFor(RAGGED);

    const result = verifyFile(file, sliceSize, RAGGED);

    expect(result.checkedSlices).toBe(4);
    expect(result.damagedSlices).toEqual([]);
  });

  it('handles a file that is an exact multiple of the slice size', () => {
    const { file, sliceSize } = setFor(EXACT, 'exact.bin');

    const result = verifyFile(file, sliceSize, EXACT);

    expect(result.ok).toBe(true);
    expect(result.checkedSlices).toBe(2);
  });

  it('handles an empty file, which the set still describes as one slice', () => {
    const { file, sliceSize } = setFor(Buffer.alloc(0), 'empty.bin');

    const result = verifyFile(file, sliceSize, Buffer.alloc(0));

    expect(result.ok).toBe(true);
  });

  it('names the damaged slice rather than only failing', () => {
    // The whole point of per-slice checksums: "slice 2 is wrong" is actionable,
    // "the file is wrong" is not.
    const { file, sliceSize } = setFor(RAGGED);
    const corrupted = Buffer.from(RAGGED);
    flip(corrupted, 130);

    const result = verifyFile(file, sliceSize, corrupted);

    expect(result.ok).toBe(false);
    expect(result.damagedSlices).toEqual([2]);
  });

  it('catches damage in the padded final slice', () => {
    const { file, sliceSize } = setFor(RAGGED);
    const corrupted = Buffer.from(RAGGED);
    flip(corrupted, 205);

    expect(verifyFile(file, sliceSize, corrupted).damagedSlices).toEqual([3]);
  });

  it('reports several damaged slices', () => {
    const { file, sliceSize } = setFor(RAGGED);
    const corrupted = Buffer.from(RAGGED);
    flip(corrupted, 10);
    flip(corrupted, 200);

    expect(verifyFile(file, sliceSize, corrupted).damagedSlices).toEqual([0, 3]);
  });

  it('fails a file of the wrong length', () => {
    const { file, sliceSize } = setFor(RAGGED);

    const result = verifyFile(file, sliceSize, RAGGED.subarray(0, 200));

    expect(result.lengthMatches).toBe(false);
    expect(result.actualLength).toBe(200);
    expect(result.ok).toBe(false);
  });

  it('fails a file that is longer than described', () => {
    const { file, sliceSize } = setFor(RAGGED);

    const result = verifyFile(file, sliceSize, Buffer.concat([RAGGED, Buffer.alloc(64)]));

    expect(result.ok).toBe(false);
    expect(result.lengthMatches).toBe(false);
  });

  it('reports no slice detail when the set carried none', () => {
    // An index-only .par2 has FileDesc but no IFSC. That is a set with no slice
    // detail, and the whole-file hash still works.
    const { file, sliceSize } = setFor(RAGGED);
    const withoutSlices: Par2File = { ...file, slices: [] };

    const result = verifyFile(withoutSlices, sliceSize, RAGGED);

    expect(result.checkedSlices).toBe(0);
    expect(result.ok).toBe(true);
  });
});

describe('Par2FileVerifier streaming', () => {
  it('agrees with the one-shot result however the chunks fall', () => {
    // A verifier that only works when chunks align to slices is no use against
    // a network stream, where they never do.
    const { file, sliceSize } = setFor(RAGGED);

    for (const size of [1, 7, 63, 64, 65, 100, 210, 1000]) {
      const verifier = new Par2FileVerifier(file, sliceSize);
      for (let at = 0; at < RAGGED.length; at += size) {
        verifier.update(RAGGED.subarray(at, Math.min(at + size, RAGGED.length)));
      }

      expect(verifier.finish().ok, `chunk size ${String(size)}`).toBe(true);
    }
  });

  it('locates damage the same way when streamed one byte at a time', () => {
    const { file, sliceSize } = setFor(RAGGED);
    const corrupted = Buffer.from(RAGGED);
    flip(corrupted, 130);

    const verifier = new Par2FileVerifier(file, sliceSize);
    for (const byte of corrupted) {
      verifier.update(Uint8Array.of(byte));
    }

    expect(verifier.finish().damagedSlices).toEqual([2]);
  });
});

describe('looksLike', () => {
  it('pairs a file with its description without reading it all', () => {
    const { file } = setFor(RAGGED);

    expect(looksLike(file, RAGGED.length, RAGGED)).toBe(true);
  });

  it('rejects a file of a different length', () => {
    const { file } = setFor(RAGGED);

    expect(looksLike(file, 209, RAGGED)).toBe(false);
  });

  it('rejects a file whose opening bytes differ', () => {
    const { file } = setFor(RAGGED);
    const other = Buffer.from(RAGGED);
    flip(other, 0);

    expect(looksLike(file, other.length, other)).toBe(false);
  });
});
