# nzb-utils — project instructions

An npm workspaces monorepo of Usenet tooling. Read this before writing code here.

## Layout

Bare-repo + worktrees. Code lives in `worktrees/<branch>/`; there is no working tree
at the project root. Use the `add-worktree` skill to start a branch.

`CLAUDE-LOG.md` at the **project root** (`/Users/cwalker/Projects/nzb-utils/`, beside
`git/` and `worktrees/`) is the transcript of the design conversation that produced
this repo. It is deliberately outside every worktree so it cannot be committed to what
is a public repository. Read it for the reasoning behind the decisions below; it also
contains the full NZB / PAR2 / NNTP / yEnc format notes and the `nzb-file@1.1.18`
audit.

## Toolchain

- npm workspaces, ESM only (`"type": "module"`), Node >= 22.
- TypeScript 7 with composite project references. `tsc -b` at the root builds
  everything in dependency order. `typecheck` and `build` are the same command — with
  composite projects the declaration emit _is_ the type check.
- vitest for tests, oxlint (`.oxlintrc.json`) for lint, prettier for format.
  oxlint's syntax-only rules cover the bans below; strict _type_ checking is tsc's
  job. Type-aware oxlint rules are available via the optional `oxlint-tsgolint`
  peer if we ever want them. Note that `typescript-eslint` does not support
  TypeScript 7 yet (it peer-caps at `<6.1.0`), which is part of why oxlint.
- `npm run check` = typecheck + lint + format:check + test. Per the global rules, a
  change is not done until that passes.

## Hard rules

1. **`any` is banned.** Enforced by lint. Prefer a precise type or a discriminated
   union over widening to `unknown`.
2. **Non-null assertions are banned.** Enforced by lint. `nzb-file@1.1.18` used
   `props!.part.end` to silence a `| null` and threw a `TypeError` on every
   single-part file; that class of bug is exactly what this repo exists to avoid.
3. **Credentials live only in `@chad3814/nntp`.** `NntpCredentials` is accepted by
   `authenticate()` and nowhere else. Never store it on an instance, log it, include
   it in an error message, or accept it as a CLI argument. `@chad3814/nzb` takes an
   injected `ArticleSource` instead and has no credential-shaped parameter at all.
   A field is `NntpSecret` — `string | Provider<string>` from
   `@chad3814/secret-provider`, which is `@chad3814/nntp`'s one runtime
   dependency. Follow that package's "accepting a provider in your own library"
   guidance: normalise and `memoize` once at the boundary, resolve at each point
   of use, and let `ProviderError` propagate rather than wrapping it — wrapping
   destroys `tryNextLink` and the aggregated list of sources tried.

   **`NntpPool` therefore does retain a resolved credential**, inside its
   memoized providers' closures, bounded by `credentialTtlMs`. That is a
   deliberate exception to "never store it", taken so a pool of eight makes one
   trip to the vault rather than eight; do not describe the pool as retaining
   nothing. `NntpClient` still retains nothing, and the source-level test
   enforces that no field is assigned `credentials` or a `resolveSecret(...)`
   result anywhere in the package.

4. **Never commit or push without explicit approval.** Never publish to npm without
   explicit approval. All packages are `private: true` until they have a working
   implementation _and_ tests; clearing that flag is a publish decision.
5. **Prefer async APIs.** `fs.promises` over `fs.*Sync`, and so on — a CLI's
   top-level config load is the only place a sync call is defensible, and it should
   say why.
6. **Tests are part of the feature.** No package clears `private` without unit tests.
7. **No spawning a program named by configuration.** `@chad3814/nzb-cli` has no
   run-a-command credential source, by decision: `op run -- nzb …` already covers
   it, and vault access belongs in dedicated `@chad3814/secret-provider-*`
   packages. Do not reintroduce one.

## Correctness requirements carried over from the audit

These are the specific defects in `nzb-file@1.1.18` / `@thaunknown/yencode` that
motivated the rewrite. Each needs a test that would fail against the original.

- **`slice(0, 0)` must be empty.** The original short-circuits on `end === 0` and
  returns a full-size clone, so `slice(0, 0).arrayBuffer()` downloads all 1868
  articles / 7.9 GiB of a typical 2160p release. Verified against a real NZB.
- **Nested slices clamp to the parent window,** not to the original file size.
- **Single-part files must work.** Single-part yEnc has no `=ypart` line, so
  `props.part` is `undefined`. The original does `parseInt(props!.part.end)` and
  throws on every single-segment file — i.e. on exactly the `.nfo` and `.jpg` you
  want for a cheap preview.
- **Never infer segment size from segment 1 and multiply _and leave it at that_.**
  Inferring is fine and cheap; the bug is not checking. `@chad3814/nzb` predicts
  from segment 1, then verifies each article's `=ypart` range before copying any of
  its bytes, and throws `NzbGeometryError` on a mismatch.
- **Dot-unstuffing must happen in the transport.** yEnc decoders do not do it;
  `@thaunknown/yencode` calls its decoder with `stripDots = false`. Note the
  frequency claim carried over from the design log ("one article in a few
  hundred") did not survive measurement: a real post had 0 stuffed lines in
  66,563, because its encoder escaped `.` at line start as yEnc recommends. Still
  required for correctness; not a common event.
- **CRC verification is ours.** `fromPost` never compares `pcrc32`; nothing in
  yencode checks a CRC. If `--verify` is to mean anything, this package does it.
- **Connection failures must stay individually attributable.** The original's pool
  swallows every per-connection error, so a wrong password and a provider connection
  cap both surface as one generic "failed to establish any connections".

## Decisions (settled 2026-08-05)

- **yEnc is pure TypeScript, in its own package `@chad3814/yenc`.** No native
  module, so `npx @chad3814/nzb-cli` works with no build toolchain. The throughput
  argument for `@thaunknown/yencode`'s SIMD does not apply: decode runs at hundreds
  of MB/s in JS against a Usenet connection that tops out far below that, so the
  work is network-bound. Owning the decoder is also what lets us own `=ypart`
  handling and `pcrc32` verification — the two places `nzb-file` was wrong.
- **`nzb-parser` uses a hand-written scanner.** Zero runtime dependencies. The NZB
  grammar is four element types deep, and NZBs arrive from untrusted indexers, so
  a small parser we fully control beats a general-purpose one with a much larger
  attack surface. `src/scanner.ts` deliberately skips DTD internal subsets rather
  than interpreting them — that is what closes off XXE and billion-laughs.
- **Pooling lives in `@chad3814/nntp`.** Forced by hard rule 3: a pool has to
  authenticate N connections, and credentials never leave that package.
  `@chad3814/nzb` consumes the pool through the structural `ArticleSource` seam.
- **Credential retention is enforced against the source, not at runtime.** A
  `#private` field is invisible to `JSON.stringify`, `Reflect.ownKeys` and
  `util.inspect({ showHidden: true })` alike — all three were checked. A test in
  `@chad3814/nntp` fails on any `this.x = credentials` or
  `this.x = resolveSecret(...)` assignment in the package instead. Note this
  constrains where a credential is _written_, and says nothing about what a
  memoized provider's closure holds — see hard rule 3 for what `NntpPool`
  deliberately retains.

- **Segment geometry is predicted, then verified (settled 2026-08-05).** The
  alternative — proving uniformity up front — means fetching every article's header,
  which is the whole file. The common case is uniform, so `@chad3814/nzb` predicts
  from segment 1 and checks each article against the prediction as it arrives. A
  failed prediction throws rather than silently switching to sequential measurement,
  because turning a 4 MiB read into a multi-gigabyte one unasked is the same class of
  surprise as `slice(0, 0)` downloading everything.

- **`@chad3814/par2` is verification only (settled 2026-08-05).** Parsing,
  packet/file/slice checking and authoritative filenames; no Reed-Solomon. The
  decision rested on measured facts about a real release: the index `.par2` is
  one article and carries every name, length and MD5, while repair needs
  gigabytes of GF(2^16) arithmetic — and on that release the recovery set
  protected 2 files, not including the one article that had actually expired.
  A second provider fixes more real failures than repair would. Do not add
  repair without revisiting that trade.

- **Downloads are written at offsets, not in order (settled 2026-08-10).**
  `NzbFileHandle.writeTo(sink)` hands each article to a sink with its absolute
  offset in the file, as it arrives. The reading methods (`bytes`, `stream`,
  async iteration) still emit in file order and always will — a caller
  concatenating needs that. A caller writing to a file does not, and making it
  wait means a slow article holds up every finished article behind it while the
  connections that fetched them idle. `@chad3814/nzb-cli`'s `get` uses
  `writeTo`; its output is byte-identical either way, which is the property the
  tests pin.

  Two guarantees hold the sink contract together, both in `src/write.ts`:
  the sink is never entered twice at once (a `Mutex`, because Node documents
  concurrent `write()` on one handle as unsafe even though positional writes are
  `pwrite`), and at most two chunks are held (one running, one queued, then the
  loop waits). The second is the backpressure — without it a sink slower than
  the network queues the whole range in memory, which is 7.8 GiB on a real
  release. Do not "simplify" either away; both have mutation tests that fail
  when they are removed.

## Real-world findings (2026-08-05, live run against Newshosting)

Things a synthetic fixture cannot tell you, learned by pointing the stack at a
real 1971-article post. Do not re-derive these.

- **Obfuscated posts randomise `=ybegin name=` per article.** Seven probed
  articles of one file carried seven different names with an identical `size=`.
  Never cross-check filenames between articles; `size=` and `=ypart` are the
  fields that hold. `NzbFileHandle.name` is therefore often noise, and
  `subjectHints.name` is the only human-readable name for such posts.
- **Uniform geometry is the real common case.** Segment size came out at exactly
  4 MiB, and articles 1, 2, 3, 500, 1000, 1867 and 1868 all sat exactly where
  the prediction put them.
- **yEnc overhead measured 3.17%** on that post — the gap between the NZB's
  summed encoded bytes and the authoritative `=ybegin size=`.
- **Individual articles do go missing.** One file's only article returned `430`
  while every other file in the post was fully retained. Partial availability is
  normal and must not be treated as a client bug — a command that walks a whole
  document has to skip and report, not abort.
- **Obfuscation defeats filename matching on the header alone.** `nzb get
--include '*.mp4'` matched nothing on a real post, because every yEnc name was
  a random extensionless string. `@chad3814/nzb-cli` matches the header name
  _and_ `subjectHints.name`, and falls back to the subject for the output
  filename when the header has no extension. The header stays authoritative
  about bytes; it is often useless about names.
- **A sparse head+tail preview works, and is cheap.** 3 articles / 8 MiB of a
  7.29 GiB file produced a sparse file `ffprobe` read as h264 3840x2160, 38m09s,
  and `ffmpeg` extracted a full-resolution frame from. `ls` showed the declared
  7,834,760,394 bytes; `du` showed 8 MiB. How much video you get is head size
  over bitrate — at 3.4 MB/s a 4 MiB head is ~1.2 seconds, and seeking past it
  decodes from the hole.

Credentials for these runs come from 1Password via
`op run --env-file=... -- node ...`, so they never enter a transcript, a file, or
a shell history. Never read them any other way.

## Real-world findings (2026-08-08, Linux Journal Aug 2017 post)

A second live post, deliberately small enough to fetch whole — 8 files, 27
articles, 7.2 MiB, non-obfuscated names, posted 2017.

- **26 of 27 articles survived nine years.** Retention is better than assumed;
  the one gone article is a `.nfo` whose posting date differs from the rest.
- **A complete download verified against par2**: 20 articles reassembled into a
  6,588,808-byte PDF, all 100 slices and the whole-file MD5 matching what
  par2cmdline computed in 2017. That is the whole stack checked against a
  third-party authority, which the 7.9 GiB fixture made impractical.
- **`502 Too many connections` is not an auth failure.** Newshosting returns it
  at the account's connection cap. It was being reported as `NntpAuthError`,
  which sends people to rotate a working password; there is now
  `NntpCapacityError`, and the pool shrinks to the cap rather than failing.
- **Concurrency is worth ~1.9x, plateauing at 4 connections** on a real link —
  far less than an isolated latency benchmark suggests, because real fetching
  becomes bandwidth-bound once a few requests overlap. Do not quote the
  synthetic figure.
- **Segment sizes vary by orders of magnitude**: 4 MiB on the 2160p release,
  337 KB here. Anything that assumes a segment is at least 1 MiB is wrong —
  `scripts/checks.ts` had exactly that bug and compared unrelated stretches of
  file because a negative `subarray` index counts from the end.

## Real-world findings (2026-08-10, saturating the connection cap)

Found by deliberately setting `NNTP_CONNECTIONS=200` on a 100-connection
Newshosting account and firing every request in one tick.

- **The account cap is 100.** `NntpPool` takes ~100 × `502 Too many
connections`, shrinks its limit, and completes all 200 requests in ~12 s.
- **A connection count is a ceiling, not an allocation.** Setting it to 200
  changed nothing about a normal run: the pool opens only what concurrent work
  demands, and this NZB has 27 articles with the library's prefetch capped at 4.
  Reaching the cap needs work that is genuinely that wide.
- **Saturation deadlocked the pool, and nothing smaller found it.** Every open
  starts before any completes, so the successful connections finished and went
  idle while refusals were still arriving; the refusal path parked its caller
  without checking the idle list, and no work remained to wake it. 200 requests
  hung with no error. 40 requests against a cap of 10 pass — the interleaving
  does not happen at that size. Parked callers now check for an idle connection
  first, and are rejectable so the pool can fail them when it provably cannot
  serve them (no live connections, none openable, or destroyed). Do not
  reintroduce a wait that has only a `resolve`.
- **The shrunk limit is approximate.** It is set to `#open` at the moment of a
  refusal, which counts in-flight opens, so it can settle just above the true
  cap (101 against a cap of 100). The next refusal corrects it. Not worth making
  exact; do not write a test that asserts it equals the cap.
- **`NntpConnectionFailure.at` is an attempt index, not a timestamp.**
  `scripts/smoke.ts` printed it through `new Date()` and reported every refusal
  as 1970. The name is poor; the field is an ordinal.

## Test fixtures

Synthetic only, for now. Fixtures are hand-authored NZB documents covering one
behaviour each; real-world numbers from the audited release are kept as assertion
constants where they prove something, but no real filenames or Message-IDs go into
this public repo.

**Planned:** post a small file to Usenet ourselves and build a fixture NZB from it.
That gives integration tests real, retained articles we own, with no third party's
content involved. Until then, transport tests run against a local fake server.

## Test type-checking

`tsconfig.test.json` at the root type-checks `packages/*/test/**` with `noEmit`. It
is deliberately **not** composite — `tsc -b` builds `src`, and this checks the tests
that would otherwise never be type-checked at all. `npm run typecheck` runs both.

## Reference values worth not re-deriving

- NZB namespace: `http://www.newzbin.com/DTD/2003/nzb`.
- PAR2 packet magic `PAR2\0PKT`; 64-byte header; packet MD5 runs from offset 32 to end
  of body. GF(2^16) generator `0x1100B`; base logs exclude multiples of 3, 5, 17, 257
  (the prime factors of 65535).
- NNTP: Message-IDs are stored in NZB without angle brackets and must be wrapped for
  the wire. Message-ID lookup needs no `GROUP` (RFC 3977 §6.2.1). `222` body follows,
  `223` stat ok, `430` no such article, `480` auth required, `502` denied / at
  connection limit.
- yEnc: `(byte - 42) & 0xFF`, with `=` escaping the next byte as
  `(next - 106) & 0xFF`; CR/LF are line structure, not data.
- yEnc header line is `=ybegin line= size= name=`; multipart adds
  `=ypart begin= end=`; the trailer is `=yend size= [part=] pcrc32=`.
  Single-part posts have **no** `=ypart` line at all.
