/**
 * Error taxonomy.
 *
 * The distinctions are operational, not decorative — a pool has to tell a wrong
 * password from a connection cap from a dead socket, and the reference
 * implementation collapsing all three into one generic message is precisely
 * what made it undiagnosable.
 *
 * None of these ever carry credentials. Building a message from a raw command
 * line would leak `AUTHINFO PASS <secret>` into logs and stack traces, so
 * commands are redacted before they reach an error.
 */

/** A response whose status code is not what the command expected. */
export class NntpProtocolError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`NNTP ${code}: ${message}`);
    this.name = 'NntpProtocolError';
    this.code = code;
  }
}

/**
 * Authentication was refused.
 *
 * Deliberately built from the status code and the server's own text only. The
 * password is never an input to this constructor.
 */
export class NntpAuthError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`NNTP authentication failed (${code}): ${message}`);
    this.name = 'NntpAuthError';
    this.code = code;
  }
}

/** A command produced no complete response within the configured timeout. */
export class NntpTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`NNTP ${operation} timed out after ${timeoutMs}ms`);
    this.name = 'NntpTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** The socket failed or closed underneath an in-flight command. */
export class NntpConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NntpConnectionError';
  }
}
