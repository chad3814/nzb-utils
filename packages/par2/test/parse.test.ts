import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Par2ParseError } from '../src/errors.ts';
import { scanPackets } from '../src/packets.ts';
import { parsePar2 } from '../src/parse.ts';
import { buildSet, packet, recoverySlice } from './fixture.ts';

const ALPHA = Buffer.from('the quick brown fox jumps over the lazy dog, repeatedly. '.repeat(20));
const BETA = Buffer.from('a second protected file, shorter.');

const SPEC = {
  sliceSize: 64,
  files: [
    { name: 'alpha.bin', data: ALPHA },
    { name: 'beta.txt', data: BETA },
  ],
  creator: 'test-suite v1',
};

describe('parsePar2', () => {
  it('reads the slice size from the Main packet', () => {
    const set = parsePar2(buildSet(SPEC).bytes);

    expect(set.sliceSize).toBe(64);
  });

  it('reads every protected file', () => {
    const set = parsePar2(buildSet(SPEC).bytes);

    expect(set.files.map((file) => file.name).toSorted()).toEqual(['alpha.bin', 'beta.txt']);
  });

  it('recovers the authoritative filename, which an NZB does not carry', () => {
    // The reason this package earns its place: on an obfuscated post the yEnc
    // header name is a random string, and this is the only authoritative one.
    const set = parsePar2(buildSet(SPEC).bytes);

    expect(set.files.find((file) => file.name === 'alpha.bin')).toBeDefined();
  });

  it('reads each file length and whole-file MD5', () => {
    const set = parsePar2(buildSet(SPEC).bytes);
    const alpha = set.files.find((file) => file.name === 'alpha.bin');

    expect(alpha?.length).toBe(ALPHA.length);
    expect(alpha?.md5).toEqual(createHash('md5').update(ALPHA).digest());
  });

  it('reads the 16 KiB identity hash', () => {
    const set = parsePar2(buildSet(SPEC).bytes);
    const beta = set.files.find((file) => file.name === 'beta.txt');

    // Shorter than 16 KiB, so it hashes the whole file.
    expect(beta?.md5_16k).toEqual(createHash('md5').update(BETA).digest());
  });

  it('reads per-slice checksums', () => {
    const set = parsePar2(buildSet(SPEC).bytes);
    const alpha = set.files.find((file) => file.name === 'alpha.bin');

    expect(alpha?.slices.length).toBe(Math.ceil(ALPHA.length / 64));
  });

  it('reads the creator', () => {
    expect(parsePar2(buildSet(SPEC).bytes).creator).toBe('test-suite v1');
  });

  it('reports no creator rather than inventing one', () => {
    const { creator, ...rest } = SPEC;
    void creator;

    expect(parsePar2(buildSet(rest).bytes).creator).toBeNull();
  });

  it('exposes the recovery set id', () => {
    const built = buildSet(SPEC);

    expect(parsePar2(built.bytes).recoverySetId).toEqual(built.recoverySetId);
  });

  it('counts recovery slices without holding their data', () => {
    // This package verifies and does not repair, so the parity bytes are of no
    // use to it. Counting them still answers "how much redundancy is here?".
    const built = buildSet(SPEC);
    const withParity = Buffer.concat([
      built.bytes,
      recoverySlice(built.recoverySetId, 0, 64),
      recoverySlice(built.recoverySetId, 1, 64),
    ]);

    const set = parsePar2(withParity);

    expect(set.recoverySlices).toBe(2);
    expect(JSON.stringify(set)).not.toContain('abababab');
  });

  it('reads a set split across several volumes', () => {
    // Critical packets are duplicated into every volume, which is what makes a
    // set survive losing members. Feeding two overlapping files must not
    // produce two copies of everything.
    const built = buildSet(SPEC);

    const set = parsePar2(built.bytes, built.bytes);

    expect(set.files.length).toBe(2);
  });

  it('skips a packet whose hash does not match its body', () => {
    // Locating packets by magic means garbage can look like a packet header.
    // The MD5 is what makes scanning safe.
    const built = buildSet(SPEC);
    const corrupted = Buffer.from(built.bytes);
    const at = corrupted.indexOf(Buffer.from('PAR 2.0\0Creator\0', 'latin1'));
    corrupted[at + 20] = (corrupted[at + 20] ?? 0) ^ 0xff;

    expect(parsePar2(corrupted).creator).toBeNull();
  });

  it('finds packets after leading garbage, rather than trusting offset zero', () => {
    const built = buildSet(SPEC);
    const noisy = Buffer.concat([Buffer.alloc(999, 0x5a), built.bytes]);

    expect(parsePar2(noisy).files.length).toBe(2);
  });

  it('finds packets after a truncated one', () => {
    // A volume cut short mid-packet must not cost the packets behind it.
    const built = buildSet(SPEC);
    const half = built.bytes.subarray(0, 40);

    expect(parsePar2(Buffer.concat([half, built.bytes])).files.length).toBe(2);
  });

  it('ignores a packet claiming an impossible length', () => {
    const built = buildSet(SPEC);
    const bad = Buffer.from(built.bytes);
    bad.writeBigUInt64LE(BigInt(2) ** BigInt(40), 8);

    // The Main packet is destroyed, so there is no set to read.
    expect(() => parsePar2(bad)).toThrow(Par2ParseError);
  });

  it('ignores a packet from a different recovery set', () => {
    // Two sets in one directory is normal; mixing their packets is not.
    const built = buildSet(SPEC);
    const foreign = packet(
      'PAR 2.0\0Creator\0',
      Buffer.alloc(16, 0x11),
      Buffer.from('other\0\0\0'),
    );

    expect(parsePar2(Buffer.concat([built.bytes, foreign])).creator).toBe('test-suite v1');
  });

  it('ignores a foreign packet that arrives first', () => {
    // Order must not decide identity. Appending the foreign packet, as the test
    // above does, cannot catch a parser that mixes sets: `creator ??=` already
    // keeps the first one either way. Putting it in front is what bites.
    const built = buildSet(SPEC);
    const foreign = packet(
      'PAR 2.0\0Creator\0',
      Buffer.alloc(16, 0x11),
      Buffer.from('other\0\0\0'),
    );

    const set = parsePar2(Buffer.concat([foreign, built.bytes]));

    expect(set.creator).toBe('test-suite v1');
    expect(set.files.length).toBe(2);
  });

  it('takes the slice size from its own Main packet, not a foreign one', () => {
    // The Main packet defines the set. Fixing identity from whichever packet
    // came first would read this set's files with the other set's geometry.
    const built = buildSet(SPEC);
    const other = buildSet({
      sliceSize: 1024,
      files: [{ name: 'x.bin', data: Buffer.alloc(50) }],
    });

    const set = parsePar2(Buffer.concat([other.bytes, built.bytes]));

    expect(set.sliceSize).toBe(1024);
    expect(set.files.map((file) => file.name)).toEqual(['x.bin']);
  });

  it('refuses input with no Main packet, since nothing else can be trusted', () => {
    expect(() => parsePar2(Buffer.alloc(500))).toThrow(Par2ParseError);
  });

  it('names what was missing when it refuses', () => {
    expect(() => parsePar2(Buffer.alloc(500))).toThrow(/Main/u);
  });

  it('tolerates a file described but never sliced', () => {
    // IFSC is a separate packet and can be absent from an index while the
    // FileDesc is present. That is a set with no slice detail, not a broken one.
    const built = buildSet(SPEC);
    const at = built.bytes.indexOf(Buffer.from('PAR 2.0\0IFSC\0\0\0\0', 'latin1'));
    const trimmed = Buffer.concat([
      built.bytes.subarray(0, at - 48),
      built.bytes.subarray(at + 40),
    ]);

    const set = parsePar2(trimmed);

    expect(set.files.some((file) => file.slices.length === 0)).toBe(true);
  });
});

describe('scanPackets cost guard', () => {
  it('rejects a packet larger than the cap even when it is in bounds', () => {
    // A corrupted length pointing most of the way through a 170 MB volume is
    // still in bounds. MD5-ing a hundred megabytes to discover it is garbage is
    // how a scan becomes quadratic, so there is a cap independent of bounds.
    const built = buildSet(SPEC);

    const seen = [...scanPackets(built.bytes, { maxPacket: 80 })];

    // Only packets under the cap survive; the file descriptions are larger.
    expect(seen.every((found) => found.body.length <= 80 - 64)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('reads every packet at the default cap', () => {
    expect([...scanPackets(buildSet(SPEC).bytes)].length).toBe(6);
  });
});
