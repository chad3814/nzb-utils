/**
 * NNTP protocol model (RFC 3977, with AUTHINFO from RFC 4643).
 *
 * Two invariants this package owns, because nothing downstream does:
 *
 * 1. **Dot-unstuffing.** Multi-line responses arrive dot-stuffed: a body line
 *    beginning with `.` was transmitted as `..`, and a lone `.` terminates the
 *    block. Every `Buffer` this package hands out is already unstuffed. yEnc
 *    decoders do *not* do this — `@thaunknown/yencode` calls its decoder with
 *    `stripDots = false` — so skipping it here corrupts the article with nothing
 *    to signal it. How often it fires is encoder-dependent: yEnc recommends
 *    escaping `.` at the start of a line, and a real post measured 0 stuffed
 *    lines in 66,563.
 * 2. **Bytes, never strings.** Usenet is 8-bit clean and yEnc depends on it.
 *    Article payloads are `Buffer` end to end; only status lines are decoded to
 *    text, and those as `latin1`.
 */

/** Transport target. Port 119 is cleartext; 563 is implicit TLS. */
export interface NntpEndpoint {
  readonly host: string;
  readonly port: number;
  /**
   * - `implicit`: wrap the socket in TLS immediately (the 563 convention).
   * - `starttls`: connect in cleartext, then upgrade via `STARTTLS`.
   * - `none`: cleartext for the whole session.
   */
  readonly security: 'implicit' | 'starttls' | 'none';
}

/**
 * A credential: either a literal, or an async thunk that produces one.
 *
 * The thunk form is structurally identical to `Provider<string>` from
 * `@chad3814/secret-provider`, which is where the shape comes from and what it
 * exists to accept — `chain(fromEnv(...), fromFile(...))` and friends satisfy
 * it directly. It is declared structurally rather than imported so this package
 * keeps zero runtime dependencies, for the same reason `@chad3814/nzb` declares
 * its own `ArticleSource` instead of depending on this one.
 *
 * A provider is the better shape for a secret: it defers the fetch until the
 * moment of use, it lets the value come straight from a vault or a subprocess
 * without passing through a config file, and it puts the decision about caching
 * in the caller's hands rather than this package's.
 */
export type NntpSecret = string | (() => Promise<string>);

/**
 * Credentials for `AUTHINFO USER` / `AUTHINFO PASS`.
 *
 * Consumed by the transport and never stored on the client, written to a log,
 * included in an error message, or re-emitted. No other package in this repo
 * accepts this type.
 *
 * Each field is resolved at the moment its command is built, and the password
 * only if the server actually asks for it — some accept a bare username, and
 * there is no reason to make a vault round-trip for a secret that will not be
 * sent.
 */
export interface NntpCredentials {
  readonly user: NntpSecret;
  readonly pass: NntpSecret;
}

/** A single-line status response. */
export interface NntpResponse {
  readonly code: number;
  readonly message: string;
  /**
   * Which server answered, for pools that have more than one to choose from.
   *
   * Set by `NntpPool` too, to its endpoint host, so a single pool and an
   * `NntpMultiPool` report identically and a caller retrying elsewhere does
   * not need to know which it holds.
   */
  readonly server?: string;
}

/** A multi-line article response. */
export interface NntpArticleResponse extends NntpResponse {
  /**
   * Raw article bytes with CRLF line endings preserved and dot-stuffing already
   * removed. Excludes the terminating `.` line.
   */
  readonly body: Buffer;
}

/**
 * Status codes this client acts on. Not exhaustive — unrecognized codes are
 * surfaced as-is rather than coerced.
 */
export const NNTP_STATUS = {
  /** Greeting, posting allowed. */
  readyPostingAllowed: 200,
  /** Greeting, posting prohibited. */
  readyPostingProhibited: 201,
  /** Response to `QUIT`. */
  closing: 205,
  /** `ARTICLE` follows. */
  articleFollows: 220,
  /** `HEAD` follows. */
  headFollows: 221,
  /** `BODY` follows. */
  bodyFollows: 222,
  /** `STAT` succeeded; the article exists. */
  articleExists: 223,
  /** `AUTHINFO PASS` accepted. */
  authenticationAccepted: 281,
  /** `AUTHINFO USER` accepted, password required. */
  passwordRequired: 381,
  /** No article with that Message-ID: expired retention, or removed. */
  noSuchArticle: 430,
  /** Authentication required before this command is permitted. */
  authenticationRequired: 480,
  /** Permission denied, or the provider's connection limit is reached. */
  permissionDenied: 502,
} as const;

export type NntpStatus = (typeof NNTP_STATUS)[keyof typeof NNTP_STATUS];
