# nzb-utils

An open, strictly-typed Usenet toolkit: NZB parsing, NNTP transport, `File`-like
access to NZB contents, and a CLI. Written because the existing npm packages in this
space are either abandoned or subtly wrong, and because none of them keep credentials
out of the libraries that don't need them.

**Status: in progress.** Two packages are implemented and tested; the rest ship
complete type definitions and no implementation yet. All packages are `private`
until they have working code and tests.

## Packages

| Package                | Purpose                                             | Status             |
| ---------------------- | --------------------------------------------------- | ------------------ |
| `@chad3814/nzb-parser` | NZB 1.1 XML → typed, immutable object graph         | implemented        |
| `@chad3814/yenc`       | yEnc decode, header parsing, CRC32 verification     | implemented        |
| `@chad3814/nntp`       | NNTP client (RFC 3977), TLS, `AUTHINFO`, unstuffing | types only         |
| `@chad3814/par2`       | PAR2 verification and repair                        | namespace reserved |
| `@chad3814/nzb`        | `File`-like handles with range-accurate fetching    | types only         |
| `@chad3814/nzb-cli`    | `nzb inspect` / `stat` / `get` / `decode`           | option types only  |

Dependency direction, strictly one-way:

```
nzb-cli ──> nzb ──> nzb-parser
              ├───> yenc
              └───> par2 (planned)
nzb-cli ──> nntp        (constructs the transport, injects it into nzb)
```

`@chad3814/nzb` does **not** depend on `@chad3814/nntp`. It accepts an
`ArticleSource` — a structural interface with a single `body(messageId)` method — so
the transport is injected and credentials never reach it.

## Design commitments

**Credentials live in exactly one package.** `NntpCredentials` is accepted by
`@chad3814/nntp`'s `authenticate()` and nowhere else. Never stored, never logged,
never in an error message, never a CLI argument.

**Dot-unstuffing happens in the transport.** NNTP multi-line responses are
dot-stuffed; yEnc decoders do not undo it. Every `Buffer` leaving `@chad3814/nntp` is
already unstuffed, and that is documented as load-bearing because nothing downstream
would catch the omission.

**Nothing in an NZB is authoritative.** No filename, no decoded size, no checksum.
Filenames come from the yEnc `=ybegin name=` header at fetch time; the parser's
subject-derived guesses are namespaced under `subjectHints` so they can't be mistaken
for facts.

**Slicing is a contract, not an implementation detail.** `slice()` does no I/O;
`slice(0, 0)` is empty; nested slices clamp to their parent; segment uniformity is
proven rather than assumed. Each of those is a bug in the package this replaces.

**Strict TypeScript, no escape hatches.** `any` is banned by lint, as are non-null
assertions — the reference implementation used `props!.part.end` to defeat a
`| null` type and crashed on every single-part file as a result.

## Development

```sh
npm install
npm run check     # typecheck, lint, format:check, test
npm run build     # tsc -b across all project references
```

`typecheck` and `build` are the same command: with composite project references, the
declaration emit _is_ the type check.

## Layout

This repo uses the bare-repo + worktrees layout. Code lives in
`worktrees/<branch>/`; there is no working tree at the project root.

## License

MIT
