import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CliError } from './errors.ts';
import type { NzbConfig, SecretRef, ServerOverrides, ServerSettings } from './options.ts';

/**
 * The config file, and merging it with flags.
 *
 * It holds where the server is and *where the credentials come from* — never a
 * credential. That is what makes it safe to keep in a dotfile repo, and it is
 * enforced rather than merely documented: an inline password is rejected.
 */

export function defaultConfigPath(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, 'nzb', 'config.json');
}

/**
 * Read and validate the config file.
 *
 * @param explicit A path from `--config`. Missing is an error: the user just
 *   pointed at a file, and quietly running against a different server than the
 *   one they named is worse than stopping.
 * @param fallback Where to look when no path was given. Missing is fine.
 */
export async function loadConfig(explicit?: string, fallback?: string): Promise<NzbConfig> {
  const path = explicit ?? fallback ?? defaultConfigPath();

  let text: string;
  try {
    await assertNotWritableByOthers(path);
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (explicit === undefined && isMissing(error)) {
      return {};
    }
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`cannot read config ${path}: ${describe(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${describe(error)}`);
  }

  return validate(parsed, path);
}

/**
 * Refuse a config anyone else can write to.
 *
 * Not about secrecy — the file holds references, not secrets, so being readable
 * is fine and is not flagged. It is about what a *writer* could do: change
 * `host`, and the next run authenticates against their server and hands them
 * the password; or point `password.file` at a path they control. Both are
 * silent.
 */
async function assertNotWritableByOthers(path: string): Promise<void> {
  const info = await stat(path);
  const mode = info.mode & 0o777;

  if ((mode & 0o022) !== 0) {
    throw new CliError(
      `${path} is writable by group or others (mode ${mode.toString(8).padStart(4, '0')}). ` +
        'Anyone who can write it can redirect this tool at their own server and collect the ' +
        `password you send it. Fix with: chmod go-w ${path}`,
    );
  }
}

const KNOWN = new Set([
  'host',
  'port',
  'security',
  'connections',
  'user',
  'password',
  'credentialTtlMs',
]);

function validate(value: unknown, path: string): NzbConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(`${path} must contain a JSON object`);
  }

  const raw: Record<string, unknown> = { ...value };
  for (const key of Object.keys(raw)) {
    if (!KNOWN.has(key)) {
      throw new CliError(
        `${path}: unknown setting ${JSON.stringify(key)}. Known settings: ${[...KNOWN].join(', ')}`,
      );
    }
  }

  const config: NzbConfig = {
    ...optional('host', string(raw['host'], 'host', path)),
    ...optional('port', integer(raw['port'], 'port', path)),
    ...optional('security', security(raw['security'], path)),
    ...optional('connections', integer(raw['connections'], 'connections', path)),
    ...optional('user', user(raw['user'], path)),
    ...optional('password', secretRef(raw['password'], 'password', path)),
    ...optional('credentialTtlMs', integer(raw['credentialTtlMs'], 'credentialTtlMs', path)),
  };

  return config;
}

/** Omit the key entirely when absent, so `exactOptionalPropertyTypes` holds. */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function string(value: unknown, field: string, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value === '') {
    throw new CliError(`${path}: ${field} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, field: string, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CliError(`${path}: ${field} must be an integer`);
  }
  return value;
}

function security(value: unknown, path: string): ServerSettings['security'] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'implicit' && value !== 'starttls' && value !== 'none') {
    throw new CliError(`${path}: security must be "implicit", "starttls" or "none"`);
  }
  return value;
}

function user(value: unknown, path: string): string | SecretRef | undefined {
  if (value === undefined || typeof value === 'string') {
    return string(value, 'user', path);
  }
  return secretRef(value, 'user', path);
}

function secretRef(value: unknown, field: string, path: string): SecretRef | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    throw new CliError(
      `${path}: ${field} must be a reference, not a literal — ` +
        '{"env": "NAME"} or {"file": "PATH"}. ' +
        'This file is not a place to keep a secret.',
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(`${path}: ${field} must be a secret reference object`);
  }

  const keys = Object.keys(value);
  if (keys.length !== 1) {
    throw new CliError(
      `${path}: ${field} must name exactly one source, got ${JSON.stringify(keys)}`,
    );
  }

  const record: Record<string, unknown> = { ...value };
  if (typeof record['env'] === 'string') {
    return { env: record['env'] };
  }
  if (typeof record['file'] === 'string') {
    return { file: record['file'] };
  }
  if ('command' in record) {
    throw new CliError(
      `${path}: ${field}.command is not supported. Running a program named by a config file ` +
        'is a large amount of danger for something `op run -- nzb …` already does; use ' +
        `{"env": "NAME"} with a wrapper, or a dedicated provider package.`,
    );
  }

  throw new CliError(`${path}: ${field} must be {"env": "NAME"} or {"file": "PATH"}`);
}

/** Merge the config file with flag overrides and apply defaults. */
export function resolveServer(config: NzbConfig, overrides: ServerOverrides): ServerSettings {
  const host = overrides.host ?? config.host;
  if (host === undefined) {
    throw new CliError(
      'no server configured: pass --host, or set "host" in the config file ' +
        `(${defaultConfigPath()})`,
    );
  }

  const port = overrides.port ?? config.port ?? 563;
  if (port < 1 || port > 65_535) {
    throw new CliError(`--port must be between 1 and 65535, got ${String(port)}`);
  }

  const connections = overrides.connections ?? config.connections ?? 4;
  if (connections < 1) {
    throw new CliError(`--connections must be at least 1, got ${String(connections)}`);
  }

  return {
    host,
    port,
    connections,
    security: overrides.security ?? config.security ?? 'implicit',
    // null means "use the default chain", which is where the environment,
    // the secret mount and the prompt live. A named source replaces it.
    user: overrides.user ?? config.user ?? null,
    password: overrides.password ?? config.password ?? null,
    credentialTtlMs: overrides.credentialTtlMs ?? config.credentialTtlMs ?? null,
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
