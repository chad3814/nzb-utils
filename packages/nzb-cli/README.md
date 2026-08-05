# @chad3814/nzb-cli

Command-line tool to inspect NZBs and download some or all of their contents.

**Status: option types only.** `src/options.ts` defines the command surface; no
implementation, and no `bin` entry until there is something to point it at.

## Planned commands

```
nzb inspect <file.nzb>            # parse and report; no network access
nzb stat    <file.nzb>            # STAT sampled articles; transfers no payload
nzb get     <file.nzb> [options]  # download whole files or byte ranges
nzb decode  <article...>          # decode raw articles already on disk
```

### `inspect`

Offline. Reports `<head>` metadata, per-file segment counts, encoded totals, group
union, poster spread, and whether each file's segment numbering is contiguous.
Deliberately does no network I/O — it should be safe and instant on any file.

### `stat`

Answers "is this release still retained?" for a few cents of bandwidth. `STAT`
returns `223` or `430` without transferring an article, so sampling scattered
Message-IDs is enough to tell a live set from a dead one.

### `get`

Whole files, or `--range` within them. `--sparse` writes ranges at their true
offsets into a file of the declared full length, which is what makes a head+tail
fetch readable: an MP4's `moov` atom may sit at either end, and a sparse file lets
ffmpeg find it wherever it is and seek back to offset 0 without downloading the
middle. APFS never allocates the hole.

### `decode`

Standalone yEnc decoding for articles captured out of band. `--dot-stuffed` controls
whether NNTP dot-unstuffing still needs to happen — raw socket captures need it,
anything that came through `@chad3814/nntp` does not.

## Credentials are never command-line arguments

argv is world-readable via `ps` and lands in shell history. Credentials come from
one of:

- `NZB_NNTP_USER` / `NZB_NNTP_PASS` in the environment,
- a user-owned config file, mode 0600, via `--config`,
- `--credential-command`, whose stdout is read directly — e.g.
  `op read op://vault/news/password`, keeping the secret out of both argv and disk.
