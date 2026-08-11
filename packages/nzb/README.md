# @chad3814/nzb

W3C `File`-like access to the contents of an NZB. Slicing a handle downloads only the
articles that overlap the requested range.

**Status: 2.0.0.** Depends on `@chad3814/nzb-parser` and
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
  body(messageId: string, options?: ArticleFetchOptions): Promise<ArticleBody>;
}

interface ArticleFetchOptions {
  /** Names of sources already tried, from `ArticleBody.server`. */
  readonly exclude?: readonly string[];
}

interface ArticleBody {
  /** Raw article bytes, CRLF preserved and already dot-unstuffed. */
  readonly body: Buffer;
  /** Which server supplied this, for sources that have more than one. */
  readonly server?: string;
}
```

An authenticated `@chad3814/nntp` client satisfies it. So does a pool, a cache, or a
test fixture. Authentication belongs to the transport and stays there — this package
has no parameter that accepts a username or password.

`options` and `server` are the whole of what multi-server support costs this
package: a name attached to an answer, and a list of names not to ask again. Both
are optional, so a single-server source that ignores them is still an
`ArticleSource`. Nothing here knows what a server _is_ — the type is declared here
rather than imported from `@chad3814/nntp` precisely so a cache or a fixture can
satisfy the seam without depending on the transport.

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
   geometry claimed, and its `=ybegin size=` must match segment 1's. Names are
   deliberately not compared — obfuscated posts randomise them per article, as
   the live run below found. A mismatch throws `NzbGeometryError`.

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

### A failed CRC is retried on another server

A `pcrc32` mismatch means the bytes arrived wrong, and the only fix is a different
provider. That retry lives here rather than in the transport, because yEnc is
decoded above the transport: a pool hands over a well-formed `222` response and
cannot see that its payload is corrupt.

So every fetch goes through `fetchArticle`, which decodes, and on a
`YencChecksumError` — and only that error — asks again with the serving server
added to `exclude`. A `YencDecodeError` is not retried: a malformed article is
malformed everywhere, and asking again just spends someone's bytes.

The loop needs no attempt counter. Each pass adds a name to the exclusion list, so
a multi-server source runs out of candidates and says so; a source that reports no
server at all has nothing to exclude and fails on the first try; a source that
ignores `exclude` is stopped the moment it repeats a name. That termination is a
contract on `ArticleSource` — it holds because names come from a fixed, finite set.

When no server has an intact copy, the error is the `YencChecksumError`, with the
source's own "nothing left to try" error attached as `cause`. Reporting the latter
alone would say every server was available and none answered, which is the exact
opposite of what happened.

### `fetchArticle` is exported directly

`openNzbFile` calls `fetchArticle` for every segment; it is also a root export
on its own, for a caller building directly on the `ArticleSource` seam who
wants one decoded article and not a whole `File`-like handle:

```ts
import { fetchArticle } from '@chad3814/nzb';

const article = await fetchArticle(source, messageId, { verify: true });
```

It fetches the article by Message-ID, decodes it, and runs the same retry
described above, not a smaller version of it: a `YencChecksumError` sends it
back to `source` with the serving server added to `exclude`; a
`YencDecodeError` does not, because a malformed article is malformed
everywhere and retrying it only spends someone's bytes. A source whose
`ArticleBody` reports no `server` has nothing to exclude and gets exactly one
attempt.

This was not part of the original design — the plan was for `openNzbFile` to
be the only way in. It stayed exported because a caller working against
`ArticleSource` directly has a real use for one decoded article and no use
for a handle, and an unexported version of the same function would still be
the retry logic a caller needs, just unreachable. An undocumented export
would have been worse than either choice, so it is documented here.

## Layout

| Module        | Role                                                      |
| ------------- | --------------------------------------------------------- |
| `range.ts`    | Slice and range arithmetic. Pure, no document, no I/O     |
| `geometry.ts` | Probing segment 1, and verifying every article after it   |
| `handle.ts`   | The `File`-like handle: windows, fetching, streaming      |
| `fetch.ts`    | One article, decoded, retried elsewhere on a CRC failure  |
| `write.ts`    | Offset-addressed handover: unordered, serialised, bounded |
| `mutex.ts`    | Runs queued tasks one at a time                           |
| `mime.ts`     | Filename to MIME type                                     |

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

## Fetching is concurrent, and bounded

Chunks must reach the caller in file order, so the obvious way to go faster —
`Promise.all` over the range — is wrong twice: it buffers the whole read, and on
a 7.3 GiB file that is 7.3 GiB of RSS. Instead `prefetch` articles are kept in
flight, results are handed over strictly in order, and a new fetch starts only
as an old one is consumed.

```ts
await openNzbFile(file, pool, { prefetch: 8 });
```

The cost of a read is therefore `prefetch × geometry.segmentSize` — 32 MiB for
eight articles of a 4 MiB post — **whatever the size of the range**. Backpressure
falls out of it being a generator: nothing beyond the window starts until the
consumer pulls, so a slow disk throttles the network instead of filling memory.

Setting it above the transport's connection count does not help. The surplus
requests queue in the pool while still holding their decoded articles.

Measured against a real provider, fetching a 6.28 MiB / 20-article file:

| depth | wall clock | throughput |
| ----- | ---------- | ---------- |
| 1     | 12.85 s    | 0.49 MiB/s |
| 2     | 7.58 s     | 0.83 MiB/s |
| 4     | 6.70 s     | 0.94 MiB/s |
| 8     | 6.87 s     | 0.91 MiB/s |

**About 1.9x, and it stops improving at 4.** Worth stating plainly, because an
isolated benchmark flatters this: against a source with a simulated 40 ms round
trip and no bandwidth limit, the same code scales nearly linearly to 16. Real
fetching stops being latency-bound once a few requests overlap and becomes
bandwidth-bound, and going deeper then buys nothing — it only holds more
articles in memory. Depth beyond the provider's connection cap buys less than
nothing.

The output is byte-identical at every depth, which is the part that matters.

Errors stay ordered too: with several requests in flight a later article can
fail sooner, but what surfaces is the first failure _in the file_, because that
is where reading actually stops being possible.

## `writeTo` does not wait for order

Order is a cost the reading methods have to pay: `bytes()` and `stream()` hand
back one contiguous run, so a slow article holds up every finished article
behind it while the connections that fetched them sit idle.

A consumer writing to a file does not need order at all — it needs to know
_where_ each run goes. `writeTo` gives it that, and hands articles over as they
arrive:

```ts
const handle = await openNzbFile(file, pool);
const target = await open('out.bin', 'w');
await handle.writeTo((offset, chunk) => target.write(chunk, 0, chunk.byteLength, offset));
```

Offsets are absolute within the whole file, not relative to the handle's window,
so a sliced handle writes into the right part of a sparse file without the
caller tracking where it started:

```ts
// Head and tail, written into one sparse file at their true offsets.
await handle.slice(0, 4 << 20).writeTo(write);
await handle.slice(-(4 << 20)).writeTo(write);
```

Two guarantees make a sink simple to write:

- **The sink is never entered twice at once.** Positional writes are `pwrite`
  and share no seek pointer, so they are safe in principle — but Node documents
  concurrent `write()` on one handle as unsafe, and serialising the handover
  costs nothing against a fetch three orders of magnitude slower. A sink can
  write, hash or forward without locking of its own.
- **At most two chunks are held.** One write runs while the next is queued
  behind it; the loop then waits. A sink slower than the network throttles it
  rather than filling memory, exactly as the read path's window does.

The chunk handed over is a copy, so a sink may retain or transform it in place.
That matters because segment 1's decoded article is kept for the life of the
handle, and a view into it would be shared state.

## Known limits

- **Only segment 1 is cached**, since opening already paid for it. Re-reading any
  other range re-fetches.
- **An abandoned read cannot cancel in-flight fetches.** `ArticleSource` has no
  abort signal, so requests already started settle and are discarded.

## Testing

142 unit tests over synthetic posts built by `test/post.ts`, which assembles real
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
