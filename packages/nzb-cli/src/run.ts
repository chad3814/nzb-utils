import { NntpPool } from '@chad3814/nntp';
import { ProviderError } from '@chad3814/secret-provider';

import { completion } from './commands/completion.ts';
import { decode } from './commands/decode.ts';
import { get } from './commands/get.ts';
import type { CommandResult } from './commands/get.ts';
import { inspect } from './commands/inspect.ts';
import { stat } from './commands/stat.ts';
import { verify } from './commands/verify.ts';
import { credentialsFor } from './credentials.ts';
import { CliError } from './errors.ts';
import type { Command, ServerSettings } from './options.ts';
import { parseCommandLine } from './parse-args.ts';

/**
 * Wiring argv to a command and a transport.
 *
 * Separate from `bin.ts` so the whole thing can be driven from a test without
 * spawning a process: everything that touches the outside world arrives through
 * {@link Io}.
 */
export interface Io {
  /** The report. Redirectable, so `--json` output stays clean. */
  out(text: string): void;
  /** Progress, warnings, diagnostics. Never part of the data. */
  err(text: string): void;
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  // A failed connection propagates as an error *and* is recorded in
  // pool.failures, so both paths would report the same line. Saying it twice
  // makes an already-unhappy moment look like two problems.
  const said = new Set<string>();
  const once = (text: string): void => {
    if (!said.has(text)) {
      said.add(text);
      io.err(text);
    }
  };

  try {
    const { command, message } = await parseCommandLine(argv);

    if (message !== null) {
      io.out(message);
      return 0;
    }
    if (command === null) {
      return 0;
    }

    const result = await execute(command, { ...io, err: once });
    io.out(result.text);
    return result.failed ? 1 : 0;
  } catch (error) {
    return report(error, once);
  }
}

async function execute(command: Command, io: Io): Promise<CommandResult> {
  if (command.name === 'inspect') {
    return { text: await inspect(command.options), failed: false };
  }
  if (command.name === 'decode') {
    return { text: await decode(command.options), failed: false };
  }
  if (command.name === 'completion') {
    return { text: completion(command.options.shell), failed: false };
  }

  const pool = connect(command.options.server);
  try {
    if (command.name === 'stat') {
      return await stat(command.options, pool);
    }
    if (command.name === 'verify') {
      return await verify(command.options, pool, (line) => {
        io.err(line);
      });
    }
    return await get(command.options, pool, (line) => {
      io.err(line);
    });
  } finally {
    // Synchronous, and in a finally: a CLI that leaves sockets open exits
    // slowly or not at all.
    pool.destroy();
    reportFailures(pool, io);
  }
}

function connect(server: ServerSettings): NntpPool {
  return new NntpPool({
    endpoint: { host: server.host, port: server.port, security: server.security },
    credentials: credentialsFor(server),
    connections: server.connections,
    // A CLI that hangs forever on a wedged provider is worse than one that
    // fails: there is a person waiting on it.
    timeoutMs: 30_000,
    ...(server.credentialTtlMs === null ? {} : { credentialTtlMs: server.credentialTtlMs }),
  });
}

/**
 * Per-connection failures, individually.
 *
 * The reference implementation collapses these into one generic message, which
 * is how a wrong password and a provider connection cap become the same
 * unhelpful line.
 */
function reportFailures(pool: NntpPool, io: Io): void {
  for (const failure of pool.failures) {
    io.err(failure.reason);
  }
}

function report(error: unknown, err: (text: string) => void): number {
  // A misused flag or an unset variable needs the complaint, not twenty frames
  // of Node internals. A ProviderError is the same kind of thing as a CliError:
  // the message already names every source that was tried, and the frames are
  // all inside the provider library.
  if (error instanceof CliError) {
    err(error.message);
    return error.exitCode;
  }
  if (error instanceof ProviderError) {
    err(error.message);
    return 2;
  }

  // Everything else is ours or the network's, and the stack is worth having.
  // `stack` already begins with "Name: message", so printing both duplicates it.
  if (error instanceof Error) {
    err(error.stack ?? `${error.name}: ${error.message}`);
  } else {
    err(String(error));
  }
  return 1;
}
