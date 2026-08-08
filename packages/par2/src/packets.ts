import { createHash } from 'node:crypto';

import { PAR2_HEADER_SIZE, PAR2_PACKET_MAGIC } from './models.ts';

/**
 * Locating packets in a PAR2 file.
 *
 * The format is designed to be *scanned*, not parsed from offset zero: packets
 * are found by their magic, each carries its own length and MD5, and any that
 * fails is skipped. That is what lets a damaged or truncated volume still yield
 * everything that survived, and it is why this returns whatever it found rather
 * than throwing on the first thing it does not like.
 *
 * The hash covers offset 32 through the end of the body — the recovery set ID
 * and type included, the magic, length and hash excluded. Checking it is what
 * makes scanning safe: without it, any 8 bytes of payload that happen to spell
 * `PAR2\0PKT` would be read as a header.
 */

const MAGIC = Buffer.from(PAR2_PACKET_MAGIC, 'latin1');

/**
 * Refuse a length no real packet has.
 *
 * Not a correctness guard — the bounds check below already rejects a length
 * that runs past the input. This is a *cost* guard: on a 170 MB volume, a
 * corrupted length pointing most of the way through the file is still in
 * bounds, and MD5-ing a hundred megabytes to discover it is garbage is a fine
 * way to make a scan quadratic. 64 MiB is far beyond the largest real packet,
 * which is a recovery slice at the slice size.
 */
const MAX_PACKET = 64 * 1024 * 1024;

export interface ScanOptions {
  /** Overrides the packet size cap. Exposed so the guard can be tested cheaply. */
  readonly maxPacket?: number;
}

export interface Par2Packet {
  readonly type: string;
  readonly recoverySetId: Buffer;
  /** Everything after the 64-byte header. */
  readonly body: Buffer;
}

export function* scanPackets(data: Buffer, options: ScanOptions = {}): Generator<Par2Packet> {
  const maxPacket = options.maxPacket ?? MAX_PACKET;
  let at = 0;

  for (;;) {
    const found = data.indexOf(MAGIC, at);
    if (found < 0) {
      return;
    }

    const packet = readPacket(data, found, maxPacket);
    if (packet === null) {
      // Resume one byte in, not past the claimed length: the length is exactly
      // what is untrustworthy about a packet that failed to verify.
      at = found + 1;
      continue;
    }

    yield packet.packet;
    at = found + packet.length;
  }
}

function readPacket(
  data: Buffer,
  at: number,
  maxPacket: number,
): { readonly packet: Par2Packet; readonly length: number } | null {
  if (at + PAR2_HEADER_SIZE > data.length) {
    return null;
  }

  const length = Number(data.readBigUInt64LE(at + 8));
  if (
    !Number.isSafeInteger(length) ||
    length < PAR2_HEADER_SIZE ||
    length > maxPacket ||
    length % 4 !== 0 ||
    at + length > data.length
  ) {
    return null;
  }

  const whole = data.subarray(at, at + length);
  const expected = whole.subarray(16, 32);
  const actual = createHash('md5').update(whole.subarray(32)).digest();
  if (!expected.equals(actual)) {
    return null;
  }

  return {
    length,
    packet: {
      type: whole.toString('latin1', 48, 64),
      recoverySetId: Buffer.from(whole.subarray(32, 48)),
      body: whole.subarray(PAR2_HEADER_SIZE),
    },
  };
}
