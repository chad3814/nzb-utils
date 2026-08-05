# @chad3814/nzb

W3C `File`-like access to the contents of an NZB. Slicing a handle downloads only the
articles that overlap the requested range.

**Status: implemented, not yet published.** Depends on `@chad3814/nzb-parser` and
`@chad3814/yenc`, and on nothing else.

## Why this shape

An NZB maps byte ranges to Usenet articles. Once you model a file as a `File`, the
useful operations fall out for free:

```ts
import { openNzbFile } from '@chad3814/nzb';

const file = await openNzbFile(nzb.files[0], source); // one article
const head = file.slice(0, 4 * 1024 * 1024); // no I/O
await head.arrayBuffer(); // fetches exactly the overlapping segments
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

## Geometry: predict, then verify

An NZB carries no decoded sizes. It says how many bytes each _article_ occupies on
the wire, which is 2–4% larger than its payload and varies with escape density. The
only authoritative statement of where a segment sits is the `=ypart begin=/end=`
line inside the article itself — and reading all of them means downloading the file.

`nzb-file@1.1.18` resolves this by reading `=ypart end=` from segment 1 and
multiplying. That is right for most posts and silently wrong for the rest: a
variable-article-size post returns bytes from the wrong offsets, with no error at
any layer.

This package takes the same cheap prediction and then checks it:

1. `openNzbFile` fetches segment 1 alone. It yields the authoritative filename and
   total size, and predicts that every segment is that length with a shorter tail.
   A prediction that cannot be right — a tail that is empty, negative, or longer
   than a full segment — sets `geometry.uniform` to `false` immediately, and
   `resolveRange` then refuses to compute offsets at all.
2. Every article is checked against that prediction as it arrives, before a single
   byte of it is copied out: its `=ypart` range must be exactly the range the
   geometry claimed, and its `=ybegin name=` and `size=` must match segment 1's.
   A mismatch throws `NzbGeometryError`.

So a uniform post costs one probe article, and a non-uniform one fails loudly at the
first article that proves it. What does not happen is the third option, which is the
one the reference implementation picks.

Recovering from a failed prediction would mean measuring — fetching articles from
the start until the requested range is covered. That is not done automatically,
because turning a 4 MiB read into a multi-gigabyte one without being asked is the
same class of surprise as `slice(0, 0)` downloading the whole file.

## Slicing invariants

These are contract, enforced by tests. Each one is a bug in `nzb-file@1.1.18`, which
this package replaces:

- **`slice(0, 0)` yields an empty handle.** `nzb-file` short-circuits on `end === 0`
  and returns a full-size clone, so `slice(0, 0).arrayBuffer()` downloads the entire
  file — 1868 articles and 7.9 GiB for a typical 2160p release.
- **Nested slices clamp to their parent's window,** not to the original file's size.
  Bounds are resolved against the handle they are called on, then translated into
  the file's coordinates, so a slice can only ever shrink.
- **Negative offsets are relative to this handle,** not to the original file.
- **`slice()` performs no I/O.** Only `arrayBuffer`, `bytes`, `text`, `stream`, and
  async iteration fetch.
- **Single-part files work.** Single-part yEnc posts have no `=ypart` line at all,
  so `props.part` is `undefined`. `nzb-file`'s `fromNZB()` does
  `parseInt(props!.part.end)` and throws a `TypeError` on every single-segment file —
  which is exactly the `.nfo` and `.jpg` you would want for a cheap preview.

## Integrity

yEnc's `=yend pcrc32=` covers each individual article, so a partial fetch can be
verified without touching PAR2 at all. Checking it is the default here, because it
costs nothing next to the fetch it accompanies; `{ verify: false }` opts out for
posts with trailers known to be wrong. Note that `@thaunknown/yencode`'s `fromPost`
does **not** check it — nothing in that library compares CRCs, so a "verified"
download verified nothing. PAR2-level verification will come from `@chad3814/par2`.

## Layout

| Module        | Role                                                    |
| ------------- | ------------------------------------------------------- |
| `range.ts`    | Slice and range arithmetic. Pure, no document, no I/O   |
| `geometry.ts` | Probing segment 1, and verifying every article after it |
| `handle.ts`   | The `File`-like handle: windows, fetching, streaming    |
| `mime.ts`     | Filename to MIME type                                   |

`range.ts` is deliberately free of NZB identifiers and transports: given sizes and a
range, it returns which segments to fetch and how to trim each. That is the part
most worth testing exhaustively, and it can be tested with neither a document nor a
network.

## Verified against a live provider

Run against a real 8-file / 1971-article post (7.91 GiB) over TLS, outside the
test suite:

- The two retained single-segment files — a par2 index and a thumbnail — opened
  and read whole. These are the files `nzb-file` throws a `TypeError` on.
- The 1868-article file opened on **one** article. Its authoritative decoded size
  (7,834,760,394 B) is 3.17% below the NZB's summed encoded bytes, which is the
  yEnc overhead the NZB cannot tell you about. Predicted segment size came out at
  exactly 4 MiB with a 3,994,826 B tail, and 1867 × 4 MiB + tail reproduces the
  declared total exactly.
- Every probed article — 1, 2, 3, 500, 1000, 1867, 1868 — sat precisely where
  uniform arithmetic predicted, so the prediction held across the whole span.
- `slice(0, 0)` fetched nothing. A 4 MiB head slice came back with `ftyp` at
  offset 4, an actual MP4 signature. A 4 MiB tail slice fetched one article.
- A 2 MiB window straddling the segment 2|3 boundary was byte-identical to the
  two articles fetched separately and joined by hand.

Two things this surfaced that the synthetic fixtures had not:

- **Obfuscated posts randomise `=ybegin name=` per article.** All seven probed
  articles carried different names alongside an identical `size=`. An earlier
  version of `verifyPlacement` compared names across articles and rejected the
  tail slice outright. That check is gone; `size=` and the `=ypart` range cover
  what it was reaching for. It also means `NzbFileHandle.name` is noise on posts
  like this one, and the subject is the only human-readable name available.
- **One article of the post is simply gone** — the `.nfo` returns `430`, while
  `STAT` confirms every other file is fully retained. Not a bug, but it is what
  attributable errors are for: the failure names the article and the reason.

## Known limits

- **Articles are fetched sequentially.** Chunks have to be emitted in file order, so
  fetching a range concurrently would mean buffering it — which is what `stream()`
  exists to avoid. A bounded prefetch window is the obvious next step; until then,
  a large read runs at one article at a time regardless of the pool's size.
- **Only segment 1 is cached**, since opening already paid for it. Re-reading any
  other range re-fetches.

## Testing

109 unit tests over synthetic posts built by `test/post.ts`, which assembles real
yEnc articles — CRCs from `node:zlib`, so a fixture cannot agree with a broken
decoder by construction — and wraps them in a recording `ArticleSource` that makes
"which articles did that cost?" a plain assertion.

Mutation-tested. Skipping placement verification, clamping a nested slice to the file
instead of its parent, restoring the `end === 0` short-circuit, assuming geometry is
always uniform, dropping the filename check, misindexing segments, disabling CRC
checks, resolving the whole file instead of the window, and failing to advance the
write offset each fail at least one test. Two mutants survived the first pass and
both were real gaps: `=ypart end=` was only ever checked by a test that a length
check caught first, and yielded chunks aliased the retained article closely enough
that a consumer writing in place could corrupt a later read. Both now have tests.
