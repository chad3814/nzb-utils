import { Par2ParseError } from './errors.ts';
import { PAR2_PACKET_TYPES } from './models.ts';
import type { Par2SliceChecksum } from './models.ts';
import { scanPackets } from './packets.ts';
import type { Par2Packet } from './packets.ts';

/**
 * Reading a PAR2 set out of one or more volumes.
 *
 * Critical packets (Main, FileDesc, IFSC, Creator) are duplicated into every
 * volume of a set, which is what lets a set survive losing arbitrary members —
 * and means the same packet arrives many times. Everything here is keyed and
 * merged rather than appended.
 *
 * Recovery slices are counted and discarded. This package verifies; it does not
 * repair, and holding hundreds of megabytes of parity to answer a question
 * nobody asked would be the wrong trade.
 */

/** One protected file, as the set describes it. */
export interface Par2File {
  readonly id: Buffer;
  /**
   * The authoritative filename.
   *
   * Worth more than it looks: an NZB has no filename field, and on an
   * obfuscated post the yEnc header's name is a random string. This is often
   * the only place the real name exists.
   */
  readonly name: string;
  readonly length: number;
  /** MD5 of the whole file. */
  readonly md5: Buffer;
  /** MD5 of the first 16 KiB — a cheap identity probe for a large file. */
  readonly md5_16k: Buffer;
  /** Empty when the set carried no IFSC packet for this file. */
  readonly slices: readonly Par2SliceChecksum[];
}

export interface Par2Set {
  readonly recoverySetId: Buffer;
  /** Slice size in bytes. Every slice checksum covers exactly this much. */
  readonly sliceSize: number;
  readonly files: readonly Par2File[];
  /** Files the set knows of but does not protect. */
  readonly unprotectedFileIds: readonly Buffer[];
  readonly creator: string | null;
  /** How many recovery slices were present across the inputs. */
  readonly recoverySlices: number;
}

interface Collected {
  descriptions: Map<string, Description>;
  slices: Map<string, readonly Par2SliceChecksum[]>;
  main: Main | null;
  creator: string | null;
  recoverySlices: number;
  recoverySetId: Buffer | null;
}

function collect(volumes: readonly Buffer[]): Collected {
  const found: Collected = {
    descriptions: new Map(),
    slices: new Map(),
    main: null,
    creator: null,
    recoverySlices: 0,
    recoverySetId: null,
  };

  // The *Main* packet defines the set, so it is what fixes the identity — not
  // whichever packet happened to come first. Two sets sharing a directory is
  // normal, and locking onto a stray Creator packet from the other one would
  // then reject every packet of the set actually being read.
  const packets = volumes.flatMap((volume) => [...scanPackets(volume)]);
  const main = packets.find((packet) => packet.type === PAR2_PACKET_TYPES.main);
  if (main === undefined) {
    return found;
  }
  found.recoverySetId = main.recoverySetId;

  for (const packet of packets) {
    // Anything carrying a different recovery set ID belongs to another set, and
    // mixing them would describe a file that does not exist.
    if (packet.recoverySetId.equals(main.recoverySetId)) {
      absorb(found, packet);
    }
  }

  return found;
}

function absorb(found: Collected, packet: Par2Packet): void {
  switch (packet.type) {
    case PAR2_PACKET_TYPES.main: {
      found.main ??= readMain(packet);
      break;
    }
    case PAR2_PACKET_TYPES.fileDescription: {
      const description = readDescription(packet);
      if (description !== null) {
        found.descriptions.set(description.id.toString('hex'), description);
      }
      break;
    }
    case PAR2_PACKET_TYPES.inputFileSliceChecksum: {
      const checksums = readSliceChecksums(packet);
      if (checksums !== null) {
        found.slices.set(checksums.id.toString('hex'), checksums.slices);
      }
      break;
    }
    case PAR2_PACKET_TYPES.creator: {
      found.creator ??= trimNulls(packet.body.toString('latin1'));
      break;
    }
    case PAR2_PACKET_TYPES.recoverySlice: {
      found.recoverySlices += 1;
      break;
    }
    default:
      break;
  }
}

export function parsePar2(...volumes: readonly Buffer[]): Par2Set {
  const { descriptions, slices, main, creator, recoverySlices, recoverySetId } = collect(volumes);

  if (main === null || recoverySetId === null) {
    throw new Par2ParseError(
      'no valid Main packet found: without it there is no slice size and no file list, ' +
        'so nothing else in the input can be trusted to describe a set',
    );
  }

  // Ordered by the Main packet's file list rather than by discovery, so the
  // result does not depend on which volume was read first.
  const files: Par2File[] = [];
  for (const id of main.recoverySetFileIds) {
    const description = descriptions.get(id.toString('hex'));
    if (description !== undefined) {
      files.push({ ...description, slices: slices.get(id.toString('hex')) ?? [] });
    }
  }

  return {
    recoverySetId,
    sliceSize: main.sliceSize,
    files,
    unprotectedFileIds: main.nonRecoverySetFileIds,
    creator,
    recoverySlices,
  };
}

interface Main {
  readonly sliceSize: number;
  readonly recoverySetFileIds: readonly Buffer[];
  readonly nonRecoverySetFileIds: readonly Buffer[];
}

function readMain(packet: Par2Packet): Main | null {
  const { body } = packet;
  if (body.length < 12) {
    return null;
  }

  const sliceSize = Number(body.readBigUInt64LE(0));
  const count = body.readUInt32LE(8);
  const ids = idsFrom(body.subarray(12));

  if (!Number.isSafeInteger(sliceSize) || sliceSize <= 0 || sliceSize % 4 !== 0) {
    return null;
  }
  if (count > ids.length) {
    return null;
  }

  return {
    sliceSize,
    recoverySetFileIds: ids.slice(0, count),
    nonRecoverySetFileIds: ids.slice(count),
  };
}

function idsFrom(body: Buffer): readonly Buffer[] {
  const ids: Buffer[] = [];
  for (let at = 0; at + 16 <= body.length; at += 16) {
    ids.push(Buffer.from(body.subarray(at, at + 16)));
  }
  return ids;
}

type Description = Omit<Par2File, 'slices'>;

function readDescription(packet: Par2Packet): Description | null {
  const { body } = packet;
  if (body.length < 56) {
    return null;
  }

  const length = Number(body.readBigUInt64LE(48));
  if (!Number.isSafeInteger(length) || length < 0) {
    return null;
  }

  return {
    id: Buffer.from(body.subarray(0, 16)),
    md5: Buffer.from(body.subarray(16, 32)),
    md5_16k: Buffer.from(body.subarray(32, 48)),
    length,
    // The name runs to the end of the packet, zero-padded to a multiple of
    // four. It is not NUL-terminated, so only trailing padding comes off.
    name: trimNulls(body.toString('utf8', 56)),
  };
}

function readSliceChecksums(
  packet: Par2Packet,
): { readonly id: Buffer; readonly slices: readonly Par2SliceChecksum[] } | null {
  const { body } = packet;
  if (body.length < 16) {
    return null;
  }

  const slices: Par2SliceChecksum[] = [];
  for (let at = 16; at + 20 <= body.length; at += 20) {
    slices.push({
      md5: Buffer.from(body.subarray(at, at + 16)),
      crc32: body.readUInt32LE(at + 16),
    });
  }

  return { id: Buffer.from(body.subarray(0, 16)), slices };
}

function trimNulls(text: string): string {
  return text.replace(/\0+$/u, '');
}
