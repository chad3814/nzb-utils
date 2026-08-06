/**
 * An error caused by how the tool was invoked or configured, rather than by a
 * bug or a server.
 *
 * These print as a one-line message with no stack trace: a mistyped `--range`
 * is not something a user can act on a stack for, and burying the actual
 * complaint under twenty frames of Node internals is how CLIs become
 * frustrating. Everything else keeps its stack, because everything else is
 * either our fault or the network's.
 */
export class CliError extends Error {
  /** Process exit code. 2 is the conventional "you used it wrong". */
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
