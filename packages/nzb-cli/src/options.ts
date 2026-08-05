/**
 * Command-line surface for `nzb`.
 *
 * Credentials are resolved from the environment or from a config file and passed
 * straight to `@chad3814/nntp`. They are never accepted as command-line
 * arguments — argv is visible to every process on the machine via `ps`, and ends
 * up in shell history.
 */

/** Where the tool reads server credentials from. Never argv. */
export interface CredentialSource {
  /**
   * - `env`: `NZB_NNTP_USER` / `NZB_NNTP_PASS`.
   * - `config`: a user-owned file, mode 0600, path from `--config`.
   * - `command`: run a helper and read the secret from its stdout, e.g.
   *   `op read op://vault/item/password`. Keeps the secret out of both argv and
   *   any file on disk.
   */
  readonly kind: 'env' | 'config' | 'command';
  /** Config path for `config`, or the argv vector for `command`. */
  readonly locator: readonly string[] | null;
}

/** A byte range parsed from `--range`, half-open. `null` end means "to EOF". */
export interface RangeOption {
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
  readonly credentials: CredentialSource;
  /**
   * Sample this many segments per file rather than every segment. `null` checks
   * all of them.
   */
  readonly sample: number | null;
}

/** `nzb get <file.nzb>` — download whole files, or ranges of them. */
export interface GetOptions {
  readonly nzbPath: string;
  readonly credentials: CredentialSource;
  /** Output directory. Files are named from the yEnc header, not the subject. */
  readonly outputDir: string;
  /** Glob patterns matched against decoded filenames. Empty means all files. */
  readonly include: readonly string[];
  /** Byte range within each selected file. `null` means the whole file. */
  readonly range: RangeOption | null;
  readonly connections: number;
  /**
   * Write ranges into a sparse file at their true offsets, preserving the
   * declared full length. This is what makes a head+tail fetch readable by
   * ffmpeg regardless of whether an MP4's `moov` atom sits at the front or the
   * back.
   */
  readonly sparse: boolean;
  /** Verify each article against its yEnc `pcrc32` trailer. */
  readonly verify: boolean;
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
  | { readonly name: 'decode'; readonly options: DecodeOptions };
