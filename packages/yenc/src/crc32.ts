/**
 * CRC-32 as used by yEnc trailers — the same reflected, polynomial-0xEDB88320
 * variant that zip and gzip use.
 *
 * yEnc puts a `pcrc32` on every article, so an article can be integrity-checked
 * on its own without PAR2. Nothing in the reference stack actually does that
 * check: `@thaunknown/yencode` exposes no comparison and `nzb-file`'s `fromPost`
 * never looks at the trailer. It is done here so `--verify` can mean something.
 */

const POLYNOMIAL = 0xedb88320;

const TABLE: Uint32Array = buildTable();

function buildTable(): Uint32Array {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ POLYNOMIAL : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
}

/**
 * @returns The checksum as an unsigned 32-bit integer. Always unsigned — the
 *   usual bug here is returning a negative int32, which then compares unequal
 *   to every value parsed out of a `pcrc32=` field.
 */
export function crc32(data: Uint8Array): number {
  return (update(0xffffffff, data) ^ 0xffffffff) >>> 0;
}

function update(seed: number, data: Uint8Array): number {
  let value = seed;

  for (const byte of data) {
    // `& 0xff` keeps the table index in range; `>>> 8` is a logical shift so the
    // running value stays unsigned.
    value = (TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  }

  return value >>> 0;
}
