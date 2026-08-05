import { describe, expect, it } from 'vitest';

import { YencDecodeError } from '../src/errors.ts';
import { decodeBytes } from '../src/decode-bytes.ts';

function encoded(text: string): Buffer {
  return Buffer.from(text, 'latin1');
}

/**
 * A reference yEnc encoder, kept in the test so the decoder can be checked as a
 * round trip over every byte value rather than only against hand-picked
 * vectors. Escapes exactly the four characters the spec requires.
 */
function referenceEncode(data: Uint8Array): Buffer {
  const out: number[] = [];
  for (const byte of data) {
    const value = (byte + 42) % 256;
    if (value === 0x00 || value === 0x0a || value === 0x0d || value === 0x3d) {
      out.push(0x3d, (value + 64) % 256);
    } else {
      out.push(value);
    }
  }
  return Buffer.from(out);
}

describe('decodeBytes', () => {
  it('subtracts 42 from unescaped bytes', () => {
    expect([...decodeBytes(encoded('*+,'))]).toEqual([0, 1, 2]);
  });

  it('decodes an escaped NUL', () => {
    // 0xD6 + 42 wraps to 0x00, which must be escaped, so it travels as "=@".
    expect([...decodeBytes(encoded('=@'))]).toEqual([0xd6]);
  });

  it('decodes an escaped LF', () => {
    // 0xE0 + 42 wraps to 0x0A.
    expect([...decodeBytes(encoded('=J'))]).toEqual([0xe0]);
  });

  it('decodes an escaped equals sign', () => {
    // 0x13 + 42 is 0x3D, the escape character itself.
    expect([...decodeBytes(encoded('=}'))]).toEqual([0x13]);
  });

  it('treats CR and LF as line structure, not data', () => {
    expect([...decodeBytes(encoded('*+\r\n,-'))]).toEqual([0, 1, 2, 3]);
  });

  it('keeps an escaped byte that decodes to CR or LF', () => {
    // The point of the escape: these are payload bytes, not line breaks.
    expect([...decodeBytes(encoded('=M=J'))]).toEqual([0xe3, 0xe0]);
  });

  it('round-trips every possible byte value', () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    expect([...decodeBytes(referenceEncode(all))]).toEqual([...all]);
  });

  it('rejects a trailing escape character with nothing to escape', () => {
    expect(() => decodeBytes(encoded('*+='))).toThrow(YencDecodeError);
  });

  it('returns empty output for empty input', () => {
    expect(decodeBytes(Buffer.alloc(0))).toHaveLength(0);
  });
});
