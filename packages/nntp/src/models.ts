/**
 * NNTP protocol model (RFC 3977, with AUTHINFO from RFC 4643).
 *
 * Two invariants this package owns, because nothing downstream does:
 *
 * 1. **Dot-unstuffing.** Multi-line responses arrive dot-stuffed: a body line
 *    beginning with `.` was transmitted as `..`, and a lone `.` terminates the
 *    block. Every `Buffer` this package hands out is already unstuffed. yEnc
 *    decoders do *not* do this — `@thaunknown/yencode` calls its decoder with
 *    `stripDots = false` — so skipping it here silently corrupts roughly one
 *    article in a few hundred.
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
 * Credentials for `AUTHINFO USER` / `AUTHINFO PASS`.
 *
 * Consumed by the transport and never stored on the client, written to a log,
 * included in an error message, or re-emitted. No other package in this repo
 * accepts this type.
 */
export interface NntpCredentials {
  readonly user: string;
  readonly pass: string;
}

/** A single-line status response. */
export interface NntpResponse {
  readonly code: number;
  readonly message: string;
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

/**
 * Client surface.
 *
 * Message-IDs are passed **without** angle brackets — the same form the NZB
 * stores — and the client adds them. Message-ID lookup does not require a
 * selected newsgroup (RFC 3977 §6.2.1), so {@link NntpClient.group} is optional
 * and only needed for article-number access or fussy providers.
 */
export interface NntpClient {
  connect(): Promise<NntpResponse>;
  authenticate(credentials: NntpCredentials): Promise<NntpResponse>;
  group(name: string): Promise<NntpResponse>;
  /** Existence check that transfers no payload. */
  stat(messageId: string): Promise<NntpResponse>;
  head(messageId: string): Promise<NntpArticleResponse>;
  body(messageId: string): Promise<NntpArticleResponse>;
  article(messageId: string): Promise<NntpArticleResponse>;
  quit(): Promise<void>;
  /** Tear down the socket without a protocol handshake. */
  destroy(): void;
}

/**
 * A pool's per-connection outcome. Connection failures must be individually
 * attributable — collapsing them into one generic error makes a wrong password
 * indistinguishable from a provider connection cap.
 */
export interface NntpConnectionOutcome {
  readonly index: number;
  readonly connected: boolean;
  readonly failureReason: string | null;
}
