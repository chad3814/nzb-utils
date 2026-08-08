import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { crc32 } from 'node:zlib';

import type { Par2File } from './parse.ts';

/**
 * Checking a file's bytes against what the set says they should be.
 *
 * Three independent answers, in increasing cost:
 *
 * - the length, which is free;
 * - the 16 KiB hash, which identifies a large file without reading it all;
 * - the whole-file MD5, plus per-slice MD5 and CRC32 that say *which* parts are
 *   wrong rather than only that something is.
 *
 * Streamed, because the files this exists for are measured in gigabytes and a
 * verifier that needs the file in memory is no use on the one that matters.
 */

export interface Par2FileVerification {
  readonly name: string;
  /** Everything agreed: length, whole-file MD5, and every slice. */
  readonly ok: boolean;
  readonly lengthMatches: boolean;
  readonly md5Matches: boolean;
  /** 0-based indices of slices that did not match. */
  readonly damagedSlices: readonly number[];
  /** How many slices were checked. Zero when the set carried no IFSC packet. */
  readonly checkedSlices: number;
  readonly actualLength: number;
}

/**
 * The final slice of a file is zero-padded to the full slice size before its
 * checksums are taken. Forgetting that makes the last slice of every file whose
 * length is not an exact multiple look damaged — and since that is most files,
 * a verifier with this bug reports near-universal corruption.
 */
export class Par2FileVerifier {
  readonly #file: Par2File;
  readonly #sliceSize: number;
  readonly #whole: Hash = createHash('md5');
  readonly #first16k: Buffer;

  #slice: Buffer;
  #inSlice = 0;
  #sliceIndex = 0;
  #length = 0;
  readonly #damaged: number[] = [];

  constructor(file: Par2File, sliceSize: number) {
    this.#file = file;
    this.#sliceSize = sliceSize;
    this.#slice = Buffer.alloc(sliceSize);
    this.#first16k = Buffer.alloc(16_384);
  }

  update(chunk: Uint8Array): void {
    this.#whole.update(chunk);

    if (this.#length < this.#first16k.length) {
      const room = this.#first16k.length - this.#length;
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(
        this.#first16k,
        this.#length,
        0,
        Math.min(room, chunk.byteLength),
      );
    }
    this.#length += chunk.byteLength;

    let at = 0;
    while (at < chunk.byteLength) {
      const room = this.#sliceSize - this.#inSlice;
      const take = Math.min(room, chunk.byteLength - at);

      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(
        this.#slice,
        this.#inSlice,
        at,
        at + take,
      );
      this.#inSlice += take;
      at += take;

      if (this.#inSlice === this.#sliceSize) {
        this.#closeSlice();
      }
    }
  }

  finish(): Par2FileVerification {
    if (this.#inSlice > 0 || this.#sliceIndex === 0) {
      // Zero the tail rather than hashing a short buffer, and emit a slice even
      // for an empty file, which the set still describes as one.
      this.#slice.fill(0, this.#inSlice);
      this.#closeSlice();
    }

    const md5Matches = this.#whole.digest().equals(this.#file.md5);
    const lengthMatches = this.#length === this.#file.length;
    const checkedSlices = Math.min(this.#sliceIndex, this.#file.slices.length);

    return {
      name: this.#file.name,
      ok: md5Matches && lengthMatches && this.#damaged.length === 0,
      lengthMatches,
      md5Matches,
      damagedSlices: this.#damaged,
      checkedSlices,
      actualLength: this.#length,
    };
  }

  #closeSlice(): void {
    const expected = this.#file.slices[this.#sliceIndex];

    // A slice the set does not describe is not a mismatch: an index-only PAR2
    // carries no IFSC packets at all, and a file longer than the set expects is
    // already caught by the length and the whole-file hash.
    if (expected !== undefined) {
      const sameCrc = crc32(this.#slice) === expected.crc32;
      // CRC32 first: it is far cheaper than MD5 and rejects almost everything,
      // so the hash only runs on slices that already look right.
      if (!sameCrc || !createHash('md5').update(this.#slice).digest().equals(expected.md5)) {
        this.#damaged.push(this.#sliceIndex);
      }
    }

    this.#sliceIndex += 1;
    this.#inSlice = 0;
    this.#slice = Buffer.alloc(this.#sliceSize);
  }
}

/** Verify a file already held in memory. */
export function verifyFile(
  file: Par2File,
  sliceSize: number,
  data: Uint8Array,
): Par2FileVerification {
  const verifier = new Par2FileVerifier(file, sliceSize);
  verifier.update(data);
  return verifier.finish();
}

/**
 * Does this file look like the one the set describes, without reading it all?
 *
 * Length plus the first 16 KiB. Enough to pair a file on disk with a
 * description before committing to hashing gigabytes, and the reason the set
 * carries a 16k hash at all.
 */
export function looksLike(file: Par2File, length: number, first16k: Uint8Array): boolean {
  return (
    length === file.length &&
    createHash('md5').update(first16k.subarray(0, 16_384)).digest().equals(file.md5_16k)
  );
}
