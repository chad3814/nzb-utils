/**
 * Usage text.
 *
 * Kept apart from the parser because it is prose, and because the two things a
 * reader most needs to be told up front -- that `--range` is half-open unlike
 * HTTP's, and that no flag ever takes a password -- belong somewhere they can
 * be read and revised as writing.
 */
export const VERSION = '0.0.0';

export function help(command?: string): string {
  return HELP[command ?? ''] ?? HELP[''] ?? '';
}

const SERVER_FLAGS = `Server (a config file supplies the defaults; see below):
      --config PATH        config file (default ~/.config/nzb/config.json)
      --host HOST          news server
      --port N             default 563
      --security MODE      implicit | starttls | none (default implicit)
  -c, --connections N      simultaneous connections (default 4); respect your
                           provider's cap. Also sets how many articles are
                           fetched at once, so a download costs roughly
                           N x article size in memory
      --user NAME          username (not a secret, so a literal is fine)
      --pass-env NAME      read the password from this environment variable
      --pass-file PATH     read the password from this file
      --credential-ttl S   re-resolve credentials older than S seconds, for
                           sources that issue them with a lifetime

With neither --pass-env nor --pass-file, the password is looked for in:

  1. $NNTP_PASSWORD
  2. /run/secret/nntp_password
  3. a terminal prompt, which is skipped when there is no terminal

Either flag replaces that chain outright rather than adding to it: having named
where the password is, falling back elsewhere could log in as another account.
The username works the same way, from $NNTP_USERNAME then
/run/secret/nntp_username, but is never prompted for -- the prompt hides what
you type, which is right for a secret and unusable for a name.

The password is never a command-line argument: argv is readable by every process
on the machine through ps, and lands in shell history. There is no run-a-command
option; 'op run -- nzb ...' covers it without this tool spawning anything.`;

const HELP: Record<string, string> = {
  '': `nzb — inspect NZBs and download their contents

Usage: nzb <command> [options]

Commands:
  inspect <file.nzb>     parse and report; no network access at all
  stat    <file.nzb>     ask the server which articles are still there
  get     <file.nzb>     download whole files, or byte ranges of them
  verify  <file.nzb>     check downloaded files against the release's PAR2 set
  decode  <article...>   decode raw articles already on disk
  completion <shell>     print a shell completion script (bash, zsh, fish)

Run 'nzb <command> --help' for the options of one command.`,

  inspect: `nzb inspect <file.nzb>

Parse an NZB and report what is in it. Strictly offline, so it is safe and
instant on a file from an indexer you do not trust.

Every size reported is the ENCODED size, which is all an NZB knows: it is 2-4%
larger than the decoded file. The real size lives in an article's yEnc header
and costs a fetch to learn.

  --json    machine-readable output`,

  stat: `nzb stat <file.nzb> [options]

Ask the server whether a release is still retained. STAT returns a status line
without transferring an article, so this costs almost nothing.

  --sample N   check N articles per file, spread across it (default 3)
  --all        check every article
  --json       machine-readable output

A clean sample is evidence of retention, not proof.

${SERVER_FLAGS}`,

  get: `nzb get <file.nzb> [options]

Download whole files, or ranges within them.

  -o, --out DIR         output directory (default .)
      --include GLOB    only files whose decoded name matches; repeatable
      --range RANGE     START-END, START- or -LAST. Half-open: START-END means
                        [START, END), unlike HTTP's inclusive Range. Accepts
                        suffixes: 4MiB, 4MB, 1.5GiB
      --sparse          write ranges at their true offsets in a file of the
                        full declared length, leaving the rest a hole
      --no-verify       skip the per-article CRC32 check
  -n, --dry-run         report what would be fetched, and fetch nothing

--sparse is what makes a preview usable. An MP4's moov atom sits at the front on
a faststart encode and at the back on most remuxes, and an NZB cannot say which;
fetching the head and the tail into a sparse file lets ffmpeg find it either way
for a fraction of a percent of the bytes.

Opening each file costs one article, because that is where the authoritative
filename and size live, so --include is matched after every file is probed.

${SERVER_FLAGS}`,

  verify: `nzb verify <file.nzb> [options]

Check files you have already downloaded against the release's own PAR2 set.

  -o, --out DIR   where the downloaded files are (default .)

Costs one article: the index .par2 carries the authoritative filename, length
and MD5 of every protected file plus per-slice checksums, and verifying needs no
recovery data, so the parity volumes are never fetched.

Reports which slices are damaged, not merely that a file is wrong. Exits
non-zero if anything is damaged or absent. Repair is not implemented; par2cmdline
or QuickPar can use the recovery volumes if you need it.

${SERVER_FLAGS}`,

  completion: `nzb completion <bash|zsh|fish>

Print a completion script to stdout. Offline, and needs no config.

  bash   nzb completion bash > /usr/local/etc/bash_completion.d/nzb
  zsh    nzb completion zsh > "\${fpath[1]}/_nzb"
  fish   nzb completion fish > ~/.config/fish/completions/nzb.fish

Or source it directly from your profile: source <(nzb completion bash).

The script is generated from the same table the parser uses, so it offers the
flags each command actually accepts rather than a hand-maintained copy that
drifts.`,

  decode: `nzb decode <article...> [options]

Decode raw yEnc articles already on disk. Offline.

  -o, --out DIR      output directory (default .)
      --dot-stuffed  the input still carries NNTP dot-stuffing, as a raw socket
                     capture does. Anything fetched by this tool does not.
      --no-verify    skip the per-article CRC32 check

Parts of one file are written into a sparse file at their true offsets, so
decoding articles 1 and 1868 of a set yields a correctly-sized file with both
pieces in place rather than 8 MiB of concatenation.`,
};
