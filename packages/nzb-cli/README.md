# @chad3814/nzb-cli

Command-line tool to inspect NZBs and download some or all of their contents.

**Status: implemented, not yet published.**

```sh
nzb inspect release.nzb                      # offline; no network at all
nzb stat    release.nzb                      # is it still retained?
nzb get     release.nzb --include '*.mkv'    # download
nzb decode  article.txt                      # decode raw articles from disk
```

## The thing it is for

```sh
nzb get release.nzb --include '*.mp4' --range 0-4MiB --range -4MiB --sparse -o out/
```

Eight mebibytes, three articles, out of a 7.29 GiB release — and the result is a
file `ffprobe` reads:

```
codec_name=h264   width=3840   height=2160   duration=2289.515000
size=7834760394   (8.0 MiB actually on disk)
```

An MP4's `moov` atom sits at the front on a faststart encode and at the back on
most CLI remuxes, and an NZB cannot tell you which. Fetching both ends into a
sparse file of the declared full length means ffmpeg finds it either way, seeks
back to zero, and decodes. The unwritten middle costs nothing: `ls` reports 7.29
GiB, `du` reports 8 MiB.

How much video you actually get is the head size divided by the bitrate. At
3.4 MB/s, a 4 MiB head is about 1.2 seconds — enough for a frame, and seeking
past it decodes from the hole and produces garbage. Ask for more head if you
want more than a thumbnail.

## Commands

### `inspect`

Offline, instant, and safe on a file from an indexer you do not trust. Reports
metadata, per-file article counts, group union, and whether numbering is
contiguous.

Every size it prints is the **encoded** size, because that is the only size an
NZB knows — 2–4% larger than the decoded file. The real size lives in a yEnc
header and costs a fetch; `stat` and `get` report it, this does not, and the
output says which it is showing.

### `stat`

Retention, for the price of a status line. `STAT` answers `223` or `430`
without transferring an article, so three scattered samples per file tell a live
set from a dead one. `--all` checks everything; the default sample is evidence,
not proof, and the output says so. Exits non-zero when anything is missing, so a
script can act on it.

### `get`

Whole files or ranges. `--range` is repeatable, and more than one requires
`--sparse` — two disjoint ranges have no meaningful contiguous layout, and
writing them end to end would silently put bytes at the wrong offsets.

`--range` is **half-open**: `0-4MiB` means `[0, 4MiB)`, matching `slice()`.
HTTP's `Range` is inclusive. `-4MiB` is the last 4 MiB. Suffixes are honoured as
written: `MiB` is 2^20, `MB` is 10^6.

### `decode`

Raw articles already on disk — a socket capture, a file another tool saved.
`--dot-stuffed` says the input still carries NNTP's stuffing, which yEnc
decoders do not remove. Parts of one file go into a sparse file at their true
offsets, so decoding articles 1 and 1868 yields a correctly-sized file with both
pieces in place rather than 8 MiB of concatenation.

## Credentials are never command-line arguments

argv is readable by every process on the machine through `ps`, and lands in
shell history. With no flags, the password is looked for in three places, in
order:

```ts
chain(
  fromEnv('NNTP_PASSWORD'),
  fromFile('/run/secret/nntp_password'),
  fromPrompt('NNTP Password: '),
);
```

An environment variable is what a `op run --` wrapper or a systemd unit sets.
`/run/secret/nntp_password` is where Docker and Kubernetes mount one. The prompt
is the interactive last resort — echo suppressed, written to stderr so piped
output stays clean, and **skipped entirely when there is no terminal**, which is
what makes the same chain correct in CI, behind a pipe and in a daemon. When
nothing answers, the error names all three.

The username works the same way, from `$NNTP_USERNAME` then
`/run/secret/nntp_username`, but is never prompted for: the prompt hides what you
type, which is right for a secret and unusable for a name.

To name one source instead:

```sh
--pass-env NAME       # an environment variable
--pass-file PATH      # a file, e.g. a Docker or Kubernetes secret mount
```

Either **replaces** the chain rather than adding to it. Having said where the
password is, quietly falling back to an environment variable or a prompt could
log you in as an account you did not choose.

There is no run-a-command option. Spawning an arbitrary program named by a flag
or a config file is a lot of danger for something `op run -- nzb …` already
does, and vault access belongs in dedicated provider packages rather than in a
shell-out.

Each source becomes a `@chad3814/secret-provider` provider, so the value is
fetched at the moment `AUTHINFO PASS` is built and never written anywhere. The
pool memoizes it, so a prompt is asked once per run — do not combine a prompt
with `--credential-ttl`, or an expiry will ask again mid-download.

## Config file

`~/.config/nzb/config.json`, or `--config PATH`. It holds where the server is
and _where the credentials come from_ — never a credential:

```json
{
  "host": "news.example.com",
  "port": 563,
  "security": "implicit",
  "connections": 8,
  "user": "someone",
  "password": { "file": "/run/secret/nntp_password" }
}
```

Omit `password` to use the default chain. Naming one pins it, exactly as the
flags do. An inline password is **rejected**, not merely discouraged: accepting
one would make the easy path the unsafe one. Every flag overrides the file.

A config that is writable by group or others is refused. Not about secrecy — it
holds references, not secrets, so being readable is fine and is not flagged.
It is about what a writer could do: change `host`, and your next run
authenticates against their server and hands them the password.

## Names on obfuscated posts

The yEnc header is authoritative and the subject is a guess, so the header
should win. Real posts complicate that: obfuscated releases randomise
`=ybegin name=` per article, and the "authoritative" name of a 7.5 GiB feature
comes back as `sGxlgomUUnf2DJFts7f8MxYZgurfWfu`.

So:

- **`--include` matches the header name _and_ the subject's guess.** Matching
  only the header would make the flag useless on exactly the releases people
  reach for it with. Verified against a real post where it matched nothing.
- **The output filename is the header's, unless the header has no extension and
  the subject offers one that does.** Writing an extensionless random string to
  disk gives a file nothing can open.

## Behaviour worth knowing

- **Opening a file costs one article.** That is where the real name and decoded
  size live, so `--include` is matched after every file in the document has been
  probed. Eight files, eight articles, before anything is downloaded.
- **A file that cannot be opened is skipped, not fatal.** Articles expire; a
  dead `.nfo` must not make the rest of a release unfetchable. Each skip is
  reported. With no `--include` every file was requested, so a skip makes the
  run exit non-zero; with `--include` it may well be a file nobody wanted, and
  its real name is unknowable precisely because it could not be opened.
- **Progress goes to stderr, the report to stdout,** so `--json | jq` and
  `> file` both work.
- **Articles are fetched one at a time.** Ordered output means concurrency would
  require buffering the range. A bounded prefetch window is the obvious next
  step; until then a large `get` runs at one article at a time regardless of
  `--connections`, which still governs the pool.

## Testing

154 unit tests. The network ones run against a real TCP server rather than a
mocked socket, over synthetic posts whose CRCs come from `node:zlib` so a
fixture cannot agree with a broken decoder by construction.

Verified end to end against a live provider and a real 1971-article post:
`inspect` offline, `stat` sampling and finding the one genuinely expired
article, a whole single-article JPEG (`file` confirms 850×815 JPEG), and the
head+tail sparse preview above.
