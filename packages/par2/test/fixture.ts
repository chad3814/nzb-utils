import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

/**
 * Hand-built PAR2 packets, written from the specification rather than from the
 * parser's own constants where it matters.
 *
 * Offsets are literals here on purpose: a fixture that derives its layout from
 * the same module the parser uses would agree with a wrong parser. Hashes come
 * from `node:crypto` and `node:zlib`, which are independent of anything in this
 * repo.
 */

const MAGIC = Buffer.from('PAR2\0PKT', 'latin1');

function md5(...parts: readonly Uint8Array[]): Buffer {
  const hash = createHash('md5');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
}

/** Pad to a multiple of four, as every packet and variable field must be. */
function pad4(data: Buffer): Buffer {
  const remainder = data.length % 4;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(4 - remainder)]);
}

/**
 * Wrap a body in the 64-byte header.
 *
 * The header hash covers offset 32 to the end — the recovery set ID and the
 * type included, the magic, length and hash itself excluded.
 */
export function packet(type: string, recoverySetId: Buffer, body: Buffer): Buffer {
  const out = Buffer.alloc(64 + body.length);
  MAGIC.copy(out, 0);
  out.writeBigUInt64LE(BigInt(64 + body.length), 8);
  recoverySetId.copy(out, 32);
  Buffer.from(type.padEnd(16, '\0'), 'latin1').copy(out, 48);
  body.copy(out, 64);

  md5(out.subarray(32)).copy(out, 16);
  return out;
}

export interface FileSpec {
  readonly name: string;
  readonly data: Buffer;
}

export interface SetSpec {
  readonly sliceSize: number;
  readonly files: readonly FileSpec[];
  /** Files listed in the Main packet as known but not protected. */
  readonly unprotected?: readonly Buffer[];
  readonly creator?: string;
}

export interface BuiltSet {
  readonly bytes: Buffer;
  readonly recoverySetId: Buffer;
  readonly fileIds: ReadonlyMap<string, Buffer>;
}

/** The MD5 of the first 16 KiB, or of the whole file when it is shorter. */
export function hash16k(data: Buffer): Buffer {
  return md5(data.subarray(0, 16_384));
}

/** File ID is content-derived: MD5 of md5-16k ++ length ++ name. */
export function fileId(spec: FileSpec): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(spec.data.length));
  return md5(hash16k(spec.data), length, Buffer.from(spec.name, 'latin1'));
}

/**
 * Slice checksums, with the final short slice zero-padded to the full slice
 * size — which the spec requires and a naive implementation forgets, producing
 * a mismatch on the last slice of every file that is not an exact multiple.
 */
export function sliceChecksums(
  data: Buffer,
  sliceSize: number,
): readonly { md5: Buffer; crc: number }[] {
  const out: { md5: Buffer; crc: number }[] = [];

  for (let at = 0; at < Math.max(data.length, 1); at += sliceSize) {
    const slice = Buffer.alloc(sliceSize);
    data.copy(slice, 0, at, Math.min(at + sliceSize, data.length));
    out.push({ md5: md5(slice), crc: crc32(slice) });
  }

  return out;
}

export function buildSet(spec: SetSpec): BuiltSet {
  const ids = new Map<string, Buffer>();
  for (const file of spec.files) {
    ids.set(file.name, fileId(file));
  }

  const sorted = spec.files.toSorted((a, b) => {
    const left = ids.get(a.name) ?? Buffer.alloc(0);
    const right = ids.get(b.name) ?? Buffer.alloc(0);
    return Buffer.compare(left, right);
  });

  // Main body: slice size (8), recovery file count (4), then IDs.
  const mainBody = Buffer.concat([
    bigint(spec.sliceSize),
    uint32(sorted.length),
    ...sorted.map((file) => ids.get(file.name) ?? Buffer.alloc(16)),
    ...(spec.unprotected ?? []),
  ]);
  // The recovery set ID is the MD5 of the Main packet's body.
  const recoverySetId = md5(mainBody);

  const packets: Buffer[] = [packet('PAR 2.0\0Main\0\0\0\0', recoverySetId, mainBody)];

  for (const file of sorted) {
    const id = ids.get(file.name) ?? Buffer.alloc(16);

    packets.push(
      packet(
        'PAR 2.0\0FileDesc',
        recoverySetId,
        Buffer.concat([
          id,
          md5(file.data),
          hash16k(file.data),
          bigint(file.data.length),
          pad4(Buffer.from(file.name, 'latin1')),
        ]),
      ),
      packet(
        'PAR 2.0\0IFSC\0\0\0\0',
        recoverySetId,
        Buffer.concat([
          id,
          ...sliceChecksums(file.data, spec.sliceSize).flatMap((slice) => [
            slice.md5,
            uint32(slice.crc),
          ]),
        ]),
      ),
    );
  }

  if (spec.creator !== undefined) {
    packets.push(
      packet('PAR 2.0\0Creator\0', recoverySetId, pad4(Buffer.from(spec.creator, 'latin1'))),
    );
  }

  return { bytes: Buffer.concat(packets), recoverySetId, fileIds: ids };
}

/** A recovery slice packet, which this package parses but never uses. */
export function recoverySlice(recoverySetId: Buffer, exponent: number, sliceSize: number): Buffer {
  return packet(
    'PAR 2.0\0RecvSlic',
    recoverySetId,
    Buffer.concat([uint32(exponent), Buffer.alloc(sliceSize, 0xab)]),
  );
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

function bigint(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}
