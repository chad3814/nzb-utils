/**
 * Which flags belong to which command, and what their values look like.
 *
 * `parseArgs` needs one flat set of options, because it parses before it knows
 * which command it is parsing for. Shell completion needs the opposite: the
 * flags for *this* command and nothing else, or it offers `--sparse` to
 * `nzb inspect`.
 *
 * So this is a second view of the same facts, and a second view is a place for
 * drift to live. `spec.test.ts` asserts that the union of every command's flags
 * is exactly the set `parse-args.ts` declares — a flag added to one and not the
 * other fails the build rather than quietly producing completion that lies.
 */

/** What a flag's value is, for shells that can complete it. */
export type ValueKind =
  | 'none'
  | 'nzb-file'
  | 'file'
  | 'directory'
  | 'number'
  | 'text'
  | { readonly choices: readonly string[] };

export interface FlagSpec {
  readonly value: ValueKind;
  readonly describe: string;
}

/** Flags every command accepts. */
export const GLOBAL_FLAGS: Readonly<Record<string, FlagSpec>> = {
  help: { value: 'none', describe: 'show help for this command' },
  version: { value: 'none', describe: 'print the version' },
};

/** Server flags, shared by everything that opens a connection. */
const SERVER_FLAGS: Readonly<Record<string, FlagSpec>> = {
  config: { value: 'file', describe: 'config file to read' },
  host: { value: 'text', describe: 'news server hostname' },
  port: { value: 'number', describe: 'server port (default 563)' },
  security: {
    value: { choices: ['implicit', 'starttls', 'none'] },
    describe: 'transport security',
  },
  connections: { value: 'number', describe: 'simultaneous connections' },
  user: { value: 'text', describe: 'username (not a secret)' },
  'pass-env': { value: 'text', describe: 'environment variable holding the password' },
  'pass-file': { value: 'file', describe: 'file holding the password' },
  'credential-ttl': { value: 'number', describe: 're-resolve credentials after N seconds' },
};

export interface CommandSpec {
  readonly describe: string;
  /** What the positional arguments are, for file completion. */
  readonly positional: 'nzb-file' | 'files' | 'shell' | 'none';
  readonly flags: Readonly<Record<string, FlagSpec>>;
}

export const COMMAND_SPECS: Readonly<Record<string, CommandSpec>> = {
  inspect: {
    describe: 'parse an NZB and report; no network access',
    positional: 'nzb-file',
    flags: { json: { value: 'none', describe: 'machine-readable output' } },
  },
  stat: {
    describe: 'ask the server which articles are still there',
    positional: 'nzb-file',
    flags: {
      json: { value: 'none', describe: 'machine-readable output' },
      sample: { value: 'number', describe: 'articles to check per file' },
      all: { value: 'none', describe: 'check every article' },
      ...SERVER_FLAGS,
    },
  },
  get: {
    describe: 'download whole files, or byte ranges of them',
    positional: 'nzb-file',
    flags: {
      out: { value: 'directory', describe: 'output directory' },
      include: { value: 'text', describe: 'only files matching this glob' },
      range: { value: 'text', describe: 'START-END, START- or -LAST' },
      sparse: { value: 'none', describe: 'write ranges at their true offsets' },
      'no-verify': { value: 'none', describe: 'skip the per-article CRC32 check' },
      'dry-run': { value: 'none', describe: 'report what would be fetched' },
      ...SERVER_FLAGS,
    },
  },
  verify: {
    describe: "check downloaded files against the release's PAR2 set",
    positional: 'nzb-file',
    flags: {
      out: { value: 'directory', describe: 'where the downloaded files are' },
      ...SERVER_FLAGS,
    },
  },
  decode: {
    describe: 'decode raw yEnc articles already on disk',
    positional: 'files',
    flags: {
      out: { value: 'directory', describe: 'output directory' },
      'dot-stuffed': { value: 'none', describe: 'input still carries NNTP dot-stuffing' },
      'no-verify': { value: 'none', describe: 'skip the per-article CRC32 check' },
    },
  },
  completion: {
    describe: 'print a shell completion script',
    positional: 'shell',
    flags: {},
  },
};

export const COMMAND_NAMES = Object.keys(COMMAND_SPECS);

/** Shells `nzb completion` can emit a script for. */
export const SHELLS = ['bash', 'zsh', 'fish'] as const;
export type Shell = (typeof SHELLS)[number];

export function isShell(value: string): value is Shell {
  return (SHELLS as readonly string[]).includes(value);
}
