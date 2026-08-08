import { parseArgs } from 'node:util';

import { CliError } from './errors.ts';
import { loadConfig, resolveServer } from './config.ts';
import type {
  Command,
  DecodeOptions,
  GetOptions,
  SecretRef,
  ServerOverrides,
  ServerSettings,
} from './options.ts';
import { help, VERSION } from './help.ts';
import { parseRange } from './range.ts';

/**
 * Turning argv into a {@link Command}.
 *
 * Built on `node:util`'s `parseArgs`, which is why this package needs no
 * argument-parsing dependency.
 *
 * No option here takes a secret. `--pass-env` and `--pass-file` name *where* to
 * find one, because argv is readable by every process on the machine through
 * `ps` and lands in shell history. Either one replaces the default chain
 * outright rather than joining it.
 */

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  json: { type: 'boolean' },

  config: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  security: { type: 'string' },
  connections: { type: 'string', short: 'c' },
  user: { type: 'string' },
  'pass-env': { type: 'string' },
  'pass-file': { type: 'string' },
  'credential-ttl': { type: 'string' },

  all: { type: 'boolean' },
  sample: { type: 'string' },

  out: { type: 'string', short: 'o' },
  include: { type: 'string', multiple: true },
  range: { type: 'string', multiple: true },
  sparse: { type: 'boolean' },
  'no-verify': { type: 'boolean' },
  'dry-run': { type: 'boolean', short: 'n' },

  'dot-stuffed': { type: 'boolean' },
} as const;

const COMMANDS = ['inspect', 'stat', 'get', 'verify', 'decode'] as const;
type CommandName = (typeof COMMANDS)[number];

function isCommand(name: string): name is CommandName {
  return (COMMANDS as readonly string[]).includes(name);
}

export interface ParsedArgs {
  readonly command: Command | null;
  /** Set when `--help` or `--version` was asked for; print and exit zero. */
  readonly message: string | null;
}

export async function parseCommandLine(argv: readonly string[]): Promise<ParsedArgs> {
  const { values, positionals } = read(argv);

  if (values.version === true) {
    return { command: null, message: VERSION };
  }

  const name = positionals[0];
  if (values.help === true || name === undefined) {
    return { command: null, message: help(name) };
  }
  if (!isCommand(name)) {
    throw new CliError(`unknown command ${JSON.stringify(name)}\n\n${help()}`);
  }

  const rest = positionals.slice(1);

  if (name === 'decode') {
    return { message: null, command: { name, options: decodeOptions(values, rest) } };
  }

  const nzbPath = onlyNzb(name, rest);

  if (name === 'inspect') {
    return { message: null, command: { name, options: { nzbPath, json: values.json === true } } };
  }

  const server = resolveServer(await loadConfig(values.config), overrides(values));

  if (name === 'stat') {
    return {
      message: null,
      command: {
        name,
        options: { nzbPath, server, sample: sample(values), json: values.json === true },
      },
    };
  }

  if (name === 'verify') {
    return {
      message: null,
      command: { name, options: { nzbPath, server, directory: values.out ?? '.' } },
    };
  }

  return { message: null, command: { name, options: getOptions(values, nzbPath, server) } };
}

function onlyNzb(name: string, rest: readonly string[]): string {
  const nzbPath = rest[0];
  if (nzbPath === undefined) {
    throw new CliError(`nzb ${name}: give it an NZB file`);
  }
  if (rest.length > 1) {
    throw new CliError(`nzb ${name}: expected one NZB file, got ${String(rest.length)}`);
  }
  return nzbPath;
}

function decodeOptions(values: Values, rest: readonly string[]): DecodeOptions {
  return {
    articlePaths: rest,
    outputDir: values.out ?? '.',
    dotStuffed: values['dot-stuffed'] === true,
    verify: values['no-verify'] !== true,
  };
}

function getOptions(values: Values, nzbPath: string, server: ServerSettings): GetOptions {
  if ((values.range ?? []).length > 1 && values.sparse !== true) {
    throw new CliError(
      'more than one --range needs --sparse: two disjoint ranges have no meaningful ' +
        'contiguous layout, and writing them end to end would silently produce a file ' +
        'whose bytes are at the wrong offsets',
    );
  }

  return {
    nzbPath,
    server,
    outputDir: values.out ?? '.',
    include: values.include ?? [],
    ranges: (values.range ?? []).map((text) => parseRange(text)),
    sparse: values.sparse === true,
    verify: values['no-verify'] !== true,
    dryRun: values['dry-run'] === true,
  };
}

interface Parsed {
  readonly values: Partial<{
    [K in keyof typeof OPTIONS]: (typeof OPTIONS)[K] extends { type: 'boolean' }
      ? boolean
      : (typeof OPTIONS)[K] extends { multiple: true }
        ? string[]
        : string;
  }>;
  readonly positionals: readonly string[];
}

type Values = Parsed['values'];

function read(argv: readonly string[]): Parsed {
  try {
    return parseArgs({ args: joinNegatives(argv), options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : 'could not parse arguments');
  }
}

/**
 * Rewrite `--range -4MiB` into `--range=-4MiB`.
 *
 * `parseArgs` refuses the spaced form as ambiguous, which is fair in general
 * and unhelpful here: asking for the last 4 MiB is the single most useful thing
 * `--range` does, and `--range -4MiB` is how anyone would write it. Only a
 * token that looks like a negative number is joined, so `--range --sparse`
 * still fails as the mistake it is.
 */
function joinNegatives(argv: readonly string[]): string[] {
  const out: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const next = argv[index + 1];

    if (token === '--range' && next !== undefined && /^-[\d.]/u.test(next)) {
      out.push(`--range=${next}`);
      index += 1;
      continue;
    }
    out.push(token);
  }

  return out;
}

function overrides(values: Values): ServerOverrides {
  const password = passwordRef(values);

  return {
    ...(values.host === undefined ? {} : { host: values.host }),
    ...(values.port === undefined ? {} : { port: number(values.port, '--port') }),
    ...(values.security === undefined ? {} : { security: security(values.security) }),
    ...(values.connections === undefined
      ? {}
      : { connections: number(values.connections, '--connections') }),
    ...(values.user === undefined ? {} : { user: values.user }),
    ...(password === null ? {} : { password }),
    ...(values['credential-ttl'] === undefined
      ? {}
      : { credentialTtlMs: number(values['credential-ttl'], '--credential-ttl') * 1000 }),
  };
}

function passwordRef(values: Values): SecretRef | null {
  const given = [
    values['pass-env'] === undefined ? null : ({ env: values['pass-env'] } as SecretRef),
    values['pass-file'] === undefined ? null : ({ file: values['pass-file'] } as SecretRef),
  ].filter((ref): ref is SecretRef => ref !== null);

  if (given.length > 1) {
    throw new CliError('give only one of --pass-env or --pass-file');
  }
  return given[0] ?? null;
}

function sample(values: Values): number | null {
  if (values.all === true) {
    if (values.sample !== undefined) {
      throw new CliError('give either --all or --sample, not both');
    }
    return null;
  }
  return values.sample === undefined ? 3 : number(values.sample, '--sample');
}

function number(text: string, flag: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError(`${flag} must be a non-negative integer, got ${JSON.stringify(text)}`);
  }
  return value;
}

function security(text: string): 'implicit' | 'starttls' | 'none' {
  if (text !== 'implicit' && text !== 'starttls' && text !== 'none') {
    throw new CliError(
      `--security must be implicit, starttls or none, got ${JSON.stringify(text)}`,
    );
  }
  return text;
}

export { help, VERSION } from './help.ts';
