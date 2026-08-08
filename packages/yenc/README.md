# @chad3814/yenc

Pure-TypeScript yEnc decoder with header parsing and CRC32 verification.

**Status: 1.0.0.** Zero runtime dependencies, no native
build step.

```ts
import { decodeArticle } from '@chad3814/yenc';

const article = decodeArticle(body, { verify: true });

article.header.name; // authoritative filename — the NZB has no filename field
article.header.size; // authoritative decoded size of the complete file
article.part; // { begin, end } within the file, or null for a single-part post
article.data; // decoded bytes
```

## Why pure TypeScript

`@thaunknown/yencode` is SIMD-accelerated and has a verifiable upstream, but it is
a native module built through `node-gyp-build`. Decoding runs at hundreds of MB/s
in plain JavaScript against a Usenet connection that tops out far below that, so
the work is network-bound and the SIMD buys nothing here — while the native build
costs every CLI user an install that can fail.

## What this does that the reference stack does not

- **Single-part posts work.** Single-part yEnc has no `=ypart` line at all.
  `nzb-file@1.1.18` reads `props!.part.end` unconditionally and throws a
  `TypeError` on every single-segment file — in practice, on exactly the `.nfo`
  and thumbnail you want for a cheap preview. `YencArticle.part` is nullable so
  the case cannot be ignored.
- **CRC32 is actually checked.** `@thaunknown/yencode` exposes no comparison and
  `nzb-file`'s `fromPost` never reads the trailer, so a "verified" download
  verified nothing. Every article carries a `pcrc32` covering itself, which makes
  articles integrity-checkable without PAR2.
- **The right checksum is used.** On a multipart article `pcrc32` covers that
  part while `crc32`, present on the final part, covers the whole reassembled
  file. Comparing the whole-file value against one part's bytes fails a perfectly
  good article.
- **Offsets are converted.** `=ypart begin=1 end=16` is 1-based and inclusive on
  the wire. `YencPartRange` is 0-based half-open, matching `Blob.slice` and the
  rest of this repo. Getting this wrong writes every part one byte off.
- **`matches` is nullable.** A trailer with no checksum yields `null`, not
  `false` — "nothing to check" and "check failed" are different answers.

## What this deliberately does not do

- **Dot-unstuffing.** NNTP transmits a body line beginning with `.` as `..`, and
  removing that is the transport's job — `@chad3814/nntp` hands out bytes that
  are already unstuffed. A decoder fed stuffed bytes corrupts them silently. How
  often that matters depends on the encoder: yEnc recommends escaping `.` at the
  start of a line, and a real post measured 0 stuffed lines in 66,563, so this is
  a correctness requirement rather than a frequent event.
- **Encoding.** Decoding is what a downloader needs. An encoder will land when
  there is a reason to post.

## Testing

38 unit tests, including a round trip over all 256 byte values against a reference
encoder kept in the test file. The decoder is also mutation-tested: reverting the
1-based offset conversion, swapping `pcrc32` for `crc32`, assuming `=ypart` is
always present, or perturbing either decode offset each fail multiple tests.
