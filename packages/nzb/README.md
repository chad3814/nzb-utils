# @chad3814/nzb

W3C `File`-like access to the contents of an NZB. Slicing a handle downloads only the
articles that overlap the requested range.

**Status: types only.** The contracts in `src/models.ts` are complete; the
implementation has not landed yet.

## Why this shape

An NZB maps byte ranges to Usenet articles. Once you model a file as a `File`, the
useful operations fall out for free:

```ts
const head = file.slice(0, 4 * 1024 * 1024); // one 4 MiB article
const tail = file.slice(-4 * 1024 * 1024); // the last one or two
await head.arrayBuffer(); // fetches exactly those segments, nothing else
```

For a 7.91 GiB / 1971-article release, a preview costs one article. There is no need
to generate a trimmed NZB to get one — trimming is only useful when you want an
artifact to hand to something else.

## Credentials never enter this package

`ArticleSource` is a structural interface with a single method:

```ts
interface ArticleSource {
  body(messageId: string): Promise<ArticleBody>;
}
```

An authenticated `@chad3814/nntp` client satisfies it. So does a pool, a cache, or a
test fixture. Authentication belongs to the transport and stays there — this package
has no parameter that accepts a username or password.

## Slicing invariants

These are contract, enforced by tests. Each one is a bug in `nzb-file@1.1.18`, which
this package replaces:

- **`slice(0, 0)` yields an empty handle.** `nzb-file` short-circuits on `end === 0`
  and returns a full-size clone, so `slice(0, 0).arrayBuffer()` downloads the entire
  file — 1868 articles and 7.9 GiB for a typical 2160p release. Verified against a
  real NZB's geometry.
- **Nested slices clamp to their parent's window,** not to the original file's size.
- **Negative offsets are relative to this handle,** not to the original file.
- **`slice()` performs no I/O.** Only `arrayBuffer`, `bytes`, `text`, `stream`, and
  async iteration fetch.
- **Segment uniformity is never assumed.** `nzb-file` reads `=ypart end=` from
  segment 1 and multiplies, which silently returns wrong bytes for
  variable-article-size posts. `SegmentGeometry.uniform` must be proven, not guessed.
- **Single-part files must work.** Single-part yEnc posts have no `=ypart` line at
  all, so `props.part` is `undefined`. `nzb-file`'s `fromNZB()` does
  `parseInt(props!.part.end)` and throws a `TypeError` on every single-segment file —
  which is exactly the `.nfo` and `.jpg` you would want for a cheap preview.

## Integrity

yEnc's `=yend pcrc32=` covers each individual article, so a partial fetch can be
verified without touching PAR2 at all. Note that `@thaunknown/yencode`'s `fromPost`
does **not** check it — nothing in that library compares CRCs. Verification is this
package's job, and PAR2-level verification will come from `@chad3814/par2`.

## Open decisions

- **yEnc implementation.** `@thaunknown/yencode` is SIMD-accelerated with a
  verifiable upstream (`animetosho/node-yencode`), but it is a native module
  (`node-gyp-build`), which adds install friction for `@chad3814/nzb-cli` users. The
  alternative is a pure-TS decoder — roughly 20 lines for the hot loop, at some
  throughput cost. Not yet decided; the decode call site should be isolated behind an
  interface either way.
- **Connection pooling.** Whether pooling lives here, in `@chad3814/nntp`, or in a
  separate package. It is a transport concern, so probably `@chad3814/nntp` — but the
  parallel-slice fetching that makes pooling worthwhile lives here.
