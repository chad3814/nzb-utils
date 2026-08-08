/**
 * Command-line surface for `nzb`.
 *
 * Credentials are never accepted as command-line arguments — argv is visible to
 * every process on the machine via `ps`, and ends up in shell history. What the
 * tool takes is a *reference*: the name of an environment variable, the path of
 * a file, or a command whose stdout is the secret. Each maps onto a
 * `@chad3814/secret-provider` provider, so the value is fetched at the moment
 * it is needed and never written anywhere.
 */

/**
 * Where one secret comes from. Deliberately not the secret itself.
 *
 * Discriminated by which key is present, so the config file reads as prose:
 * `{ "env": "NNTP_PASSWORD" }` or `{ "file": "/run/secret/nntp_password" }`.
 *
 * There is deliberately no "run this command" form. Spawning an arbitrary
 * program named by a config file is a large amount of danger for a convenience
 * that `op run -- nzb …` already covers, and vault access belongs in dedicated
 * provider packages rather than in a shell-out.
 */
export type SecretRef = { readonly env: string } | { readonly file: string };

export type Security = 'implicit' | 'starttls' | 'none';

/** Everything needed to open an authenticated connection. */
export interface ServerSettings {
  readonly host: string;
  readonly port: number;
  readonly security: Security;
  readonly connections: number;
  /** A username is not a secret, so a literal is allowed alongside a reference. */
  readonly user: string | SecretRef | null;
  /** A single named source, or `null` for the default chain. */
  readonly password: SecretRef | null;
  /** Re-resolve credentials older than this. For sources that issue them with a lifetime. */
  readonly credentialTtlMs: number | null;
}

/** The config file's shape: every field optional, all of them overridable by flags. */
export type NzbConfig = Partial<ServerSettings>;

/** Server fields a flag can override. */
export type ServerOverrides = Partial<Omit<ServerSettings, 'user' | 'password'>> & {
  readonly user?: string;
  /** Set by `--pass-env` or `--pass-file`, which replace the default chain entirely. */
  readonly password?: SecretRef;
};

/** A byte range parsed from `--range`, half-open. `null` end means "to EOF". */
export interface RangeOption {
  /** Negative means "this many bytes from the end", as `-N` in `--range`. */
  readonly start: number;
  readonly end: number | null;
}

/** `nzb inspect <file.nzb>` — parse and report, no network access. */
export interface InspectOptions {
  readonly nzbPath: string;
  /** Emit machine-readable JSON instead of a table. */
  readonly json: boolean;
}

/**
 * `nzb stat <file.nzb>` — check article availability with `STAT`, transferring
 * no payload.
 */
export interface StatOptions {
  readonly nzbPath: string;
  readonly server: ServerSettings;
  /**
   * Sample this many segments per file rather than every segment. `null` checks
   * all of them.
   */
  readonly sample: number | null;
  readonly json: boolean;
}

/** `nzb get <file.nzb>` — download whole files, or ranges of them. */
export interface GetOptions {
  readonly nzbPath: string;
  readonly server: ServerSettings;
  /** Output directory. Files are named from the yEnc header, not the subject. */
  readonly outputDir: string;
  /** Glob patterns matched against decoded filenames. Empty means all files. */
  readonly include: readonly string[];
  /**
   * Byte ranges within each selected file. Empty means the whole file.
   *
   * More than one is the head+tail preview: both ends of an MP4 into a single
   * sparse file, so ffmpeg finds `moov` wherever the encoder put it.
   */
  readonly ranges: readonly RangeOption[];
  /**
   * Write ranges into a sparse file at their true offsets, preserving the
   * declared full length. This is what makes a head+tail fetch readable by
   * ffmpeg regardless of whether an MP4's `moov` atom sits at the front or the
   * back.
   */
  readonly sparse: boolean;
  /** Verify each article against its yEnc `pcrc32` trailer. */
  readonly verify: boolean;
  /** Report what would be fetched, and from which articles, without fetching. */
  readonly dryRun: boolean;
}

/** `nzb verify <file.nzb>` — check downloaded files against the release's PAR2 set. */
export interface VerifyOptions {
  readonly nzbPath: string;
  readonly server: ServerSettings;
  /** Where the downloaded files are. */
  readonly directory: string;
}

/** `nzb decode <article...>` — decode already-fetched raw articles from disk. */
export interface DecodeOptions {
  readonly articlePaths: readonly string[];
  readonly outputDir: string;
  /**
   * Whether the input still carries NNTP dot-stuffing. Raw captures from a
   * socket do; anything already processed by `@chad3814/nntp` does not.
   */
  readonly dotStuffed: boolean;
  readonly verify: boolean;
}

export type Command =
  | { readonly name: 'inspect'; readonly options: InspectOptions }
  | { readonly name: 'stat'; readonly options: StatOptions }
  | { readonly name: 'get'; readonly options: GetOptions }
  | { readonly name: 'verify'; readonly options: VerifyOptions }
  | { readonly name: 'decode'; readonly options: DecodeOptions };
