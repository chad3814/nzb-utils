import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, resolveServer } from '../src/config.ts';
import { CliError } from '../src/errors.ts';

let directory = '';
const path = (): string => join(directory, 'config.json');

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nzb-cli-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function write(contents: unknown, mode = 0o600): Promise<string> {
  await writeFile(path(), typeof contents === 'string' ? contents : JSON.stringify(contents));
  await chmod(path(), mode);
  return path();
}

describe('loadConfig', () => {
  it('reads a well-formed config', async () => {
    const file = await write({ host: 'news.example.com', port: 563, connections: 8 });

    await expect(loadConfig(file)).resolves.toMatchObject({
      host: 'news.example.com',
      port: 563,
      connections: 8,
    });
  });

  it('returns nothing when no path is given and no default file exists', async () => {
    await expect(loadConfig(undefined, join(directory, 'absent.json'))).resolves.toEqual({});
  });

  it('fails when an explicitly named config is missing', async () => {
    // Silently ignoring --config would run against the wrong server rather than
    // the one the user just pointed at.
    await expect(loadConfig(join(directory, 'absent.json'))).rejects.toThrow(CliError);
  });

  it('rejects a config that is writable by anyone else', async () => {
    // Not about secrecy -- the file holds references, not secrets. It is about
    // the `command` field being an executable this tool will run: a
    // group-writable config is arbitrary code execution by whoever shares the
    // group.
    const file = await write({ host: 'news.example.com' }, 0o666);

    await expect(loadConfig(file)).rejects.toThrow(/writable/u);
  });

  it('accepts a config that is merely readable by others, which leaks nothing', async () => {
    const file = await write({ host: 'news.example.com' }, 0o644);

    await expect(loadConfig(file)).resolves.toMatchObject({ host: 'news.example.com' });
  });

  it('reports the offending file and the JSON complaint on a syntax error', async () => {
    const file = await write('{ "host": ');

    await expect(loadConfig(file)).rejects.toThrow(/config\.json/u);
  });

  it('rejects an unknown key rather than ignoring it', async () => {
    // A silently dropped `conections: 20` is a support ticket.
    const file = await write({ host: 'news.example.com', conections: 20 });

    await expect(loadConfig(file)).rejects.toThrow(/conections/u);
  });

  it('rejects a field of the wrong type', async () => {
    const file = await write({ host: 'news.example.com', port: '563' });

    await expect(loadConfig(file)).rejects.toThrow(/port/u);
  });

  it('rejects a top-level value that is not an object', async () => {
    const file = await write([1, 2, 3]);

    await expect(loadConfig(file)).rejects.toThrow(CliError);
  });

  it('reads each secret reference form', async () => {
    const file = await write({
      host: 'news.example.com',
      user: 'someone',
      password: { file: '/run/secret/nntp_password' },
    });

    await expect(loadConfig(file)).resolves.toMatchObject({
      user: 'someone',
      password: { file: '/run/secret/nntp_password' },
    });
  });

  it('reads an env reference', async () => {
    const file = await write({ host: 'h', password: { env: 'NNTP_PASSWORD' } });

    await expect(loadConfig(file)).resolves.toMatchObject({ password: { env: 'NNTP_PASSWORD' } });
  });

  it('refuses a run-a-command reference, and says what to use instead', async () => {
    // Removed deliberately: spawning a program named by a config file is a lot
    // of danger for something `op run --` already does, and vault access
    // belongs in a dedicated provider package.
    const file = await write({
      host: 'h',
      password: { command: ['op', 'read', 'op://Private/News/password'] },
    });

    const error = await loadConfig(file).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('not supported');
    expect((error as Error).message).toContain('op run');
  });

  it('rejects an inline password, and says why', async () => {
    // The one thing this file must never hold. Accepting it would make the
    // easy path the unsafe one. Asserted on the specific wording, not just
    // "some error": the generic "must be a secret reference object" message
    // also fires for a string, so a loose assertion here passes even when the
    // deliberate, explanatory rejection has been removed.
    const file = await write({ host: 'news.example.com', password: 'hunter2' });

    await expect(loadConfig(file)).rejects.toThrow(/not a place to keep a secret/u);
  });

  it('lists the accepted forms when refusing an inline password', async () => {
    const file = await write({ host: 'news.example.com', password: 'hunter2' });

    const error = await loadConfig(file).catch((caught: unknown) => caught);

    for (const form of ['env', 'file']) {
      expect((error as Error).message).toContain(form);
    }
  });

  it('rejects a secret reference naming more than one source', async () => {
    const file = await write({
      host: 'news.example.com',
      password: { env: 'A', file: '/b' },
    });

    await expect(loadConfig(file)).rejects.toThrow(CliError);
  });

  it('rejects an empty command vector', async () => {
    const file = await write({ host: 'news.example.com', password: { command: [] } });

    await expect(loadConfig(file)).rejects.toThrow(CliError);
  });
});

describe('resolveServer', () => {
  it('defaults to implicit TLS on 563, which is the Usenet convention', () => {
    const server = resolveServer({ host: 'news.example.com' }, {});

    expect(server.port).toBe(563);
    expect(server.security).toBe('implicit');
  });

  it('leaves both credentials unnamed so the default chains apply', () => {
    // null means "look in the usual places": environment, then secret mount,
    // then a prompt for the password. Pinning a single source here would
    // silently disable the other two.
    const server = resolveServer({ host: 'news.example.com' }, {});

    expect(server.user).toBeNull();
    expect(server.password).toBeNull();
  });

  it('lets the config name a single password source, replacing the chain', () => {
    const server = resolveServer({ host: 'h', password: { env: 'OTHER' } }, {});

    expect(server.password).toEqual({ env: 'OTHER' });
  });

  it('lets a flag override a source the config named', () => {
    const server = resolveServer(
      { host: 'h', password: { env: 'FROM_CONFIG' } },
      { password: { file: '/from/flag' } },
    );

    expect(server.password).toEqual({ file: '/from/flag' });
  });

  it('lets flags override the file', () => {
    const server = resolveServer(
      { host: 'news.example.com', port: 563, connections: 4 },
      { host: 'other.example.com', connections: 12 },
    );

    expect(server.host).toBe('other.example.com');
    expect(server.connections).toBe(12);
    expect(server.port).toBe(563);
  });

  it('fails when no host is configured anywhere', () => {
    expect(() => resolveServer({}, {})).toThrow(/--host/u);
  });

  it('rejects a connection count below one', () => {
    expect(() => resolveServer({ host: 'h' }, { connections: 0 })).toThrow(CliError);
  });

  it('rejects a port outside the valid range', () => {
    expect(() => resolveServer({ host: 'h' }, { port: 70_000 })).toThrow(CliError);
  });
});
