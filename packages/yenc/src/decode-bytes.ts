import { YencDecodeError } from './errors.ts';

const ESCAPE = 0x3d;
const CR = 0x0d;
const LF = 0x0a;

/**
 * Decode raw yEnc payload bytes.
 *
 * The whole algorithm: every byte is `(byte - 42) & 0xFF`, except that `=`
 * escapes the following byte as `(next - 106) & 0xFF`, and unescaped CR and LF
 * are line structure rather than data.
 *
 * This takes *payload only* — no `=ybegin` / `=ypart` / `=yend` lines. Use
 * {@link decodeArticle} for a complete article.
 *
 * Dot-unstuffing is **not** done here and must already have happened in the
 * transport. NNTP sends a body line beginning with `.` as `..`; a decoder that
 * assumes otherwise silently corrupts roughly one article in a few hundred.
 */
export function decodeBytes(encoded: Uint8Array): Buffer {
  // The decoded form is never longer than the encoded form, so one allocation
  // sized to the input is enough and is then sliced down.
  const out = Buffer.allocUnsafe(encoded.length);
  let length = 0;
  let index = 0;

  while (index < encoded.length) {
    const byte = encoded[index];
    index += 1;

    if (byte === undefined || byte === CR || byte === LF) {
      continue;
    }

    if (byte === ESCAPE) {
      const escaped = encoded[index];
      if (escaped === undefined) {
        throw new YencDecodeError('input ends with an escape character');
      }
      index += 1;
      out[length] = (escaped - 106) & 0xff;
      length += 1;
      continue;
    }

    out[length] = (byte - 42) & 0xff;
    length += 1;
  }

  return out.subarray(0, length);
}
