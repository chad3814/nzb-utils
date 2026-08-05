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
4. **Never commit or push without explicit approval.** Never publish to npm without
   explicit approval. All packages are `private: true` until they have a working
   implementation _and_ tests; clearing that flag is a publish decision.
5. **Prefer async APIs.** `fs.promises` over `fs.*Sync`, and so on — a CLI's
   top-level config load is the only place a sync call is defensible, and it should
   say why.
6. **Tests are part of the feature.** No package clears `private` without unit tests.

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
  `@chad3814/nntp` fails on any `this.x = credentials` assignment in the package
  instead.

- **Segment geometry is predicted, then verified (settled 2026-08-05).** The
  alternative — proving uniformity up front — means fetching every article's header,
  which is the whole file. The common case is uniform, so `@chad3814/nzb` predicts
  from segment 1 and checks each article against the prediction as it arrives. A
  failed prediction throws rather than silently switching to sequential measurement,
  because turning a 4 MiB read into a multi-gigabyte one unasked is the same class of
  surprise as `slice(0, 0)` downloading everything.

Still open:

- **`@chad3814/par2` scope.** Verification is genuinely useful on its own;
  Reed-Solomon repair is a much larger job. Verification first.

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
  normal and must not be treated as a client bug.

Credentials for these runs come from 1Password via
`op run --env-file=... -- node ...`, so they never enter a transcript, a file, or
a shell history. Never read them any other way.

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
