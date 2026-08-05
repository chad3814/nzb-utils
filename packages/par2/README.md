# @chad3814/par2

PAR2 (Parity Volume Set Specification 2.0) verification and repair.

**Status: namespace reserved, not implemented.** `src/models.ts` holds the wire-format
constants and packet types; there is no parser, verifier, or Reed-Solomon
implementation yet. The package is `private` and will not publish.

## Why it exists as a placeholder

PAR2 is the integrity layer for NZB. An NZB carries no hashes and no authoritative
filenames, so everything about verifying a reconstituted file comes from the PAR2
set's `FileDesc` and `IFSC` packets. Reserving the namespace now keeps the
dependency direction honest: `@chad3814/nzb` will depend on this, never the reverse.

## Planned scope

1. **Packet scanner** — locate packets by magic rather than by offset, so a damaged
   or interleaved file still yields whatever survived. Validate each packet's MD5
   (computed from offset 32 through the body, excluding magic/length/hash).
2. **Set assembly** — group by recovery set ID, deduplicate the critical packets
   that are intentionally repeated across every volume.
3. **Verification** — per-slice MD5 and CRC32 against `IFSC`, with the sliding-window
   search that lets CRC32 _locate_ intact slices in a misaligned file.
4. **Repair** — Reed-Solomon over GF(2^16), generator `0x1100B`. Deferred; verification
   alone covers the read-only use cases.

## Format notes

- A `.par2` is a bag of independent packets, not a structured document. Any order,
  arbitrary duplication, locate-by-magic.
- Critical packets (Main, FileDesc, IFSC, Creator) are duplicated into _every_
  volume, which is why a set survives losing arbitrary members.
- `name.par2` is the index: critical packets only, zero recovery slices. Cheap to
  fetch just to verify.
- Volume naming is not standardized. `name.vol000+01.par2` is start+count;
  `name.volNN-MM.par2` (as emitted by ParPar/nyuu) is start and exclusive-end. The
  parser must handle both, and must not trust either — read the exponents from the
  `RecvSlic` packets.
