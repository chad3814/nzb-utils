import { describe, expect, it } from 'vitest';

import { crc32 } from '../src/crc32.ts';

/**
 * yEnc trailers carry a CRC-32 in the same flavour zip and gzip use: reflected,
 * polynomial 0xEDB88320, initial and final xor of 0xFFFFFFFF. These are the
 * standard published check values for that algorithm.
 */
describe('crc32', () => {
  it('returns 0 for empty input', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('matches the standard check value for "123456789"', () => {
    expect(crc32(Buffer.from('123456789', 'latin1'))).toBe(0xcbf43926);
  });

  it('matches the published value for a single byte', () => {
    expect(crc32(Buffer.from('a', 'latin1'))).toBe(0xe8b7be43);
  });

  it('matches the published value for a longer ASCII string', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    expect(crc32(Buffer.from(text, 'latin1'))).toBe(0x414fa339);
  });

  it('is 8-bit clean across the full byte range', () => {
    // Usenet is 8-bit clean and yEnc output spans all 256 values, so a table
    // built only against ASCII would pass the checks above and still be wrong.
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    expect(crc32(all)).toBe(0x29058c73);
  });

  it('produces an unsigned 32-bit value, never a negative number', () => {
    // A CRC implementation that forgets the final `>>> 0` returns a negative
    // int32 for roughly half of all inputs, which then fails every ===
    // comparison against a value parsed out of a yEnc trailer.
    const value = crc32(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
  });
});
