# @chad3814/par2

PAR2 (Parity Volume Set Specification 2.0) parsing and verification.

**Status: implemented, not yet published.** Zero runtime dependencies —
`node:crypto` for MD5, `node:zlib` for CRC32.

**Verification only. There is no repair.** Reed-Solomon reconstruction is a much
larger job with a narrower payoff, and everything below is useful without it.
See "What repair would add".

```ts
import { parsePar2, verifyFile } from '@chad3814/par2';

const set = parsePar2(await readFile('release.par2'));
// → sliceSize, and for every protected file: name, length, md5, per-slice checksums

for (const file of set.files) {
  const result = verifyFile(file, set.sliceSize, await readFile(file.name));
  console.log(file.name, result.ok, result.damagedSlices);
}
```

## Why it earns its place

**It is the only authoritative filename.** An NZB has no filename field, and on
an obfuscated post the yEnc `=ybegin name=` is a random string that differs on
every article. PAR2's `FileDesc` packets carry the real name, the real length
and an MD5 — and the index `.par2` that holds them is a **single article**. On
the release this was built against: 5,396 bytes.

**It is an independent check on the whole stack.** Every article is already
CRC-checked on arrival, so transit corruption is caught. That says nothing about
whether the _assembly_ was right. A reassembled file matching the set's MD5
proves every offset, every `=ypart` placement check and every join was correct,
against an authority nobody here wrote.

**Verifying needs no parity.** Recovery slices exist to repair. The critical
packets — `Main`, `FileDesc`, `IFSC`, `Creator` — are duplicated into _every_
volume and are all verification needs, so this never fetches the hundreds of
megabytes of recovery data. On the audited release the parity volumes are 384
MiB and the index is 5 KB.

## What it does

- **Scans for packets by magic**, not by offset, and validates each one's MD5.
  That is what lets a damaged, truncated or interleaved volume still yield
  everything that survived — and what makes scanning safe, since without the
  hash any eight bytes of payload spelling `PAR2\0PKT` would be read as a header.
- **Merges volumes.** Critical packets repeat across every volume; they are
  keyed and merged rather than appended.
- **Ignores packets from another set.** Identity comes from the first `Main`
  packet, because that is what defines a set — not from whichever packet
  happened to be at the front of the input.
- **Verifies streamed**, so a 7.8 GiB file is checked without being held in
  memory. Length, whole-file MD5, and per-slice MD5 + CRC32 that say _which_
  slices are wrong rather than only that something is.
- **Zero-pads the final slice**, which the spec requires and which a naive
  implementation forgets — producing a phantom mismatch on the last slice of
  every file whose length is not an exact multiple of the slice size, which is
  most of them.

## What repair would add

The recovery slices are parsed and counted but their data is discarded. Using
them means Reed-Solomon over GF(2^16): log/antilog tables, matrix inversion, and
a multiply-accumulate pass over every present slice for each missing one. On the
audited release that is roughly 7.3 GiB of field arithmetic to reconstruct a
single 32 MiB slice.

Worth knowing before assuming repair is the answer to a missing article: on that
release the recovery set protects **2 files**, and the one article that had
actually expired — the `.nfo` — was not one of them. `par2` would not have saved
it. Fetching from a second provider often solves more real failures per hour of
work than reimplementing Reed-Solomon.

## Slices are not articles

A slice is the PAR2 unit; an article is the Usenet unit. On the audited release a
slice is 32 MiB and an article is 4 MiB, so **one lost article destroys a whole
slice**. Several losses inside the same slice still cost only that one slice, so
clustered damage is cheap and scattered damage is what exhausts a set's budget.

## Testing

38 unit tests over packets built byte by byte from the specification, with
offsets written as literals rather than taken from this package's own constants
— a fixture that shares its layout with the parser would agree with a wrong
parser. Hashes come from `node:crypto` and `node:zlib`.

Mutation-tested: skipping the final slice's zero padding, never checking a
packet's MD5, resuming a scan at a corrupted length instead of one byte on,
mixing packets from a foreign set, taking set identity from the first packet
rather than the first `Main`, and dropping the packet-size cost cap each fail at
least one test. Three of those survived a first pass and exposed real gaps: two
tests appended a foreign packet where only a _leading_ one bites, and the size
cap had no test at all until the limit was made injectable.

Verified against a real release end to end: the index `.par2` fetched as one
article, a downloaded JPEG confirmed against the set's MD5, and a single flipped
byte reported as one damaged slice.
