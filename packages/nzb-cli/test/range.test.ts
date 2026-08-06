import { describe, expect, it } from 'vitest';

import { parseByteCount, parseRange } from '../src/range.ts';
import { CliError } from '../src/errors.ts';

describe('parseByteCount', () => {
  it('reads a plain integer', () => {
    expect(parseByteCount('4096')).toBe(4096);
  });

  it('reads binary suffixes', () => {
    expect(parseByteCount('4KiB')).toBe(4096);
    expect(parseByteCount('4MiB')).toBe(4 * 1024 ** 2);
    expect(parseByteCount('2GiB')).toBe(2 * 1024 ** 3);
  });

  it('reads decimal suffixes as powers of ten, because that is what they mean', () => {
    // A tool that silently treats MB as MiB is off by 5% and lies about it.
    expect(parseByteCount('4MB')).toBe(4_000_000);
    expect(parseByteCount('2GB')).toBe(2_000_000_000);
  });

  it('treats a bare K, M or G as binary, matching every other CLI', () => {
    expect(parseByteCount('4K')).toBe(4096);
    expect(parseByteCount('4M')).toBe(4 * 1024 ** 2);
  });

  it('is case-insensitive', () => {
    expect(parseByteCount('4mib')).toBe(4096 * 1024);
    expect(parseByteCount('4mb')).toBe(4_000_000);
  });

  it('accepts a fractional count', () => {
    expect(parseByteCount('1.5MiB')).toBe(1_572_864);
  });

  it('rejects a fractional count that is not a whole number of bytes', () => {
    expect(() => parseByteCount('1.5')).toThrow(CliError);
  });

  it('rejects a negative count', () => {
    expect(() => parseByteCount('-1')).toThrow(CliError);
  });

  it('rejects nonsense', () => {
    expect(() => parseByteCount('')).toThrow(CliError);
    expect(() => parseByteCount('lots')).toThrow(CliError);
    expect(() => parseByteCount('4XB')).toThrow(CliError);
  });
});

describe('parseRange', () => {
  it('reads a half-open start-end range', () => {
    // Half-open to match slice() and the rest of the repo. HTTP Range is
    // inclusive at the end; converting between them is off-by-one bait, so the
    // help text says which this is.
    expect(parseRange('0-4096')).toEqual({ start: 0, end: 4096 });
  });

  it('reads an open-ended range', () => {
    expect(parseRange('1024-')).toEqual({ start: 1024, end: null });
  });

  it('reads a suffix range as the last N bytes', () => {
    expect(parseRange('-4MiB')).toEqual({ start: -4194304, end: null });
  });

  it('accepts suffixes on both bounds', () => {
    expect(parseRange('1MiB-2MiB')).toEqual({ start: 1048576, end: 2097152 });
  });

  it('rejects an end before the start', () => {
    // slice() would silently return nothing; for an explicit flag that is
    // certainly a typo, and downloading zero bytes without saying so is worse
    // than refusing.
    expect(() => parseRange('4096-1024')).toThrow(CliError);
  });

  it('rejects an empty range', () => {
    expect(() => parseRange('1024-1024')).toThrow(CliError);
  });

  it('rejects a range with no dash', () => {
    expect(() => parseRange('4096')).toThrow(CliError);
  });

  it('rejects a bare dash', () => {
    expect(() => parseRange('-')).toThrow(CliError);
  });

  it('names the flag in the message, so the error is actionable', () => {
    expect(() => parseRange('nonsense')).toThrow(/--range/u);
  });
});
