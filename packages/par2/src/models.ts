/**
 * PAR2 wire-format model — Parity Volume Set Specification 2.0.
 *
 * A `.par2` file is not a structured document; it is a bag of self-contained,
 * self-identifying, self-checksumming packets that may appear in any order, be
 * duplicated freely, and be located by scanning for {@link PAR2_PACKET_MAGIC}
 * even when surrounding bytes are damaged.
 *
 * All integers are little-endian. Every packet and every variable-length field is
 * padded to a multiple of 4 bytes.
 *
 * Namespace reserved; no implementation yet. See README.md.
 */

/** 8-byte packet magic. */
export const PAR2_PACKET_MAGIC = 'PAR2\0PKT';

/** Fixed packet header size, in bytes. */
export const PAR2_HEADER_SIZE = 64;

/**
 * 16-byte ASCII packet type tags.
 *
 * The first five are required by the spec; the rest are optional and unevenly
 * implemented by real clients.
 */
export const PAR2_PACKET_TYPES = {
  main: 'PAR 2.0\0Main\0\0\0\0',
  fileDescription: 'PAR 2.0\0FileDesc',
  inputFileSliceChecksum: 'PAR 2.0\0IFSC\0\0\0\0',
  recoverySlice: 'PAR 2.0\0RecvSlic',
  creator: 'PAR 2.0\0Creator\0',
  unicodeFilename: 'PAR 2.0\0UniFileN',
  asciiComment: 'PAR 2.0\0CommASCI',
  unicodeComment: 'PAR 2.0\0CommUni\0',
} as const;

export type Par2PacketType = (typeof PAR2_PACKET_TYPES)[keyof typeof PAR2_PACKET_TYPES];

/**
 * Reed-Solomon parameters over GF(2^16).
 *
 * Base constants are powers of 2 whose logarithms are *not* divisible by any
 * prime factor of 65535 (= 3 x 5 x 17 x 257). That guarantees each base has full
 * multiplicative order, so any k recovery slices are linearly independent —
 * yielding 32768 usable bases.
 */
export const PAR2_GALOIS = {
  generatorPolynomial: 0x1100b,
  fieldOrder: 65535,
  excludedLogFactors: [3, 5, 17, 257],
} as const;

/**
 * The 64-byte header prefixing every packet.
 *
 * {@link Par2PacketHeader.packetHash} is an MD5 computed from byte offset 32
 * (the first byte of the recovery set ID) through the last byte of the body —
 * deliberately excluding the magic, the length, and the hash itself, so a
 * corrupted length cannot forge a valid packet.
 */
export interface Par2PacketHeader {
  /** Total packet length including this header. Always a multiple of 4. */
  readonly length: number;
  readonly packetHash: Buffer;
  /** Shared by every packet in a set; the MD5 of the Main packet's body. */
  readonly recoverySetId: Buffer;
  readonly type: string;
}

/** Set definition: slice geometry and file membership. */
export interface Par2MainPacket {
  /** Slice ("block") size in bytes. Always a multiple of 4. */
  readonly sliceSize: number;
  /** File IDs of protected files, ascending. */
  readonly recoverySetFileIds: readonly Buffer[];
  /** File IDs known to the set but not protected by it. */
  readonly nonRecoverySetFileIds: readonly Buffer[];
}

/**
 * Per-file identity — the metadata an NZB lacks entirely.
 *
 * {@link Par2FileDescriptionPacket.fileId} is content-derived: the MD5 of
 * `md5_16k ++ length ++ name`, so identity never depends on assignment order.
 */
export interface Par2FileDescriptionPacket {
  readonly fileId: Buffer;
  /** MD5 of the entire file. */
  readonly fileHash: Buffer;
  /** MD5 of the first 16 KiB — a cheap identity probe for large files. */
  readonly first16kHash: Buffer;
  readonly length: number;
  readonly name: string;
}

/**
 * Per-slice verification data. The CRC32 is what lets a client *locate* intact
 * slices in a damaged or misaligned file by sliding a window, rather than merely
 * verifying ones it already found.
 */
export interface Par2SliceChecksum {
  readonly md5: Buffer;
  readonly crc32: number;
}

export interface Par2InputFileSliceChecksumPacket {
  readonly fileId: Buffer;
  readonly slices: readonly Par2SliceChecksum[];
}

export interface Par2RecoverySlicePacket {
  /** Identifies which parity row this slice is. */
  readonly exponent: number;
  /** Exactly `sliceSize` bytes of parity data. */
  readonly data: Buffer;
}

/** Free ASCII text naming the client that generated the set. */
export interface Par2CreatorPacket {
  readonly creator: string;
}
