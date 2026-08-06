import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from '../src/run.ts';
import { startFakeServer } from '../../nntp/test/fake-server.ts';
import type { FakeServer } from '../../nntp/test/fake-server.ts';
import { buildPost, responder } from './post.ts';
import type { Post } from './post.ts';

let directory = '';
let server: FakeServer | null = null;
let post: Post;
let nzbPath = '';
let configPath = '';

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function invoke(...argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nzb-run-'));
  post = buildPost({
    files: [
      { name: 'show.mkv', segmentSizes: [100, 100, 50] },
      { name: 'show.nfo', segmentSizes: [40] },
    ],
  });
  nzbPath = join(directory, 'test.nzb');
  await writeFile(nzbPath, post.xml);

  server = await startFakeServer({ respond: responder(post) });
  configPath = join(directory, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      host: '127.0.0.1',
      port: server.port,
      security: 'none',
      connections: 2,
      user: 'someone',
      password: { env: 'NZB_TEST_PASS' },
    }),
  );
  await chmod(configPath, 0o600);
  process.env['NZB_TEST_PASS'] = 'secret';
});

afterEach(async () => {
  await server?.close();
  server = null;
  delete process.env['NZB_TEST_PASS'];
  await rm(directory, { recursive: true, force: true });
});

describe('run', () => {
  it('prints usage and exits zero with no arguments', async () => {
    const result = await invoke();

    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: nzb');
  });

  it('lists all four commands in the usage', async () => {
    const { out } = await invoke('--help');

    for (const command of ['inspect', 'stat', 'get', 'decode']) {
      expect(out).toContain(command);
    }
  });

  it('gives per-command help', async () => {
    const { out } = await invoke('get', '--help');

    expect(out).toContain('--sparse');
    expect(out).toContain('--range');
  });

  it('warns in the help that --range is half-open, unlike HTTP', async () => {
    const { out } = await invoke('get', '--help');

    expect(out).toContain('Half-open');
  });

  it('says in the help that the password is never an argument', async () => {
    const { out } = await invoke('get', '--help');

    expect(out).toMatch(/never a command-line argument/u);
  });

  it('exits 2 on an unknown command, and shows usage', async () => {
    const result = await invoke('frobnicate');

    expect(result.code).toBe(2);
    expect(result.err).toContain('Usage: nzb');
  });

  it('exits 2 with a one-line complaint on a bad flag, and no stack', async () => {
    const result = await invoke('get', nzbPath, '--range', 'nonsense', '--config', configPath);

    expect(result.code).toBe(2);
    expect(result.err).toContain('--range');
    expect(result.err).not.toContain('at ');
  });

  it('inspects offline, with no server configured at all', async () => {
    const result = await invoke('inspect', nzbPath);

    expect(result.code).toBe(0);
    expect(result.out).toContain('2 files');
  });

  it('sends inspect --json to stdout as valid JSON', async () => {
    const result = await invoke('inspect', nzbPath, '--json');

    expect(() => JSON.parse(result.out) as unknown).not.toThrow();
    expect(result.err).toBe('');
  });

  it('downloads with get', async () => {
    const out = join(directory, 'out');

    const result = await invoke('get', nzbPath, '--config', configPath, '-o', out);

    expect(result.code).toBe(0);
    expect(await readFile(join(out, 'show.mkv'))).toEqual(post.contents.get('show.mkv'));
  });

  it('takes the password from the environment variable the config names', async () => {
    // Never from argv. The config says which variable; the value stays in the
    // environment until the moment AUTHINFO PASS is built.
    const out = join(directory, 'out');

    const result = await invoke(
      'get',
      nzbPath,
      '--config',
      configPath,
      '-o',
      out,
      '--include',
      '*.nfo',
    );

    expect(result.code).toBe(0);
    expect(server?.commands).toContain('AUTHINFO PASS secret');
  });

  it('fails cleanly when the named password variable is unset', async () => {
    delete process.env['NZB_TEST_PASS'];

    const result = await invoke('get', nzbPath, '--config', configPath, '-o', directory);

    expect(result.code).not.toBe(0);
    expect(result.err).toContain('NZB_TEST_PASS');
  });

  it('lets a flag override the config', async () => {
    // Port 1 is closed, so the connection is refused immediately -- which is
    // the observable proof the override beat the config's working port.
    const result = await invoke('stat', nzbPath, '--config', configPath, '--port', '1');

    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/ECONNREFUSED|connect/u);
  });

  it('refuses a group-writable config, which could name a command to run', async () => {
    await chmod(configPath, 0o660);

    const result = await invoke('stat', nzbPath, '--config', configPath);

    expect(result.code).toBe(2);
    expect(result.err).toContain('writable');
  });

  it('reports retention with stat', async () => {
    const result = await invoke('stat', nzbPath, '--config', configPath, '--all');

    expect(result.code).toBe(0);
    expect(result.out).toContain('ok');
  });

  it('keeps progress on stderr so stdout stays the report', async () => {
    const out = join(directory, 'out');

    const result = await invoke('get', nzbPath, '--config', configPath, '-o', out);

    expect(result.err).toContain('show.mkv');
    expect(result.out).not.toContain('of 250 B');
  });

  it('writes a sparse tail fetch at its true offset', async () => {
    const out = join(directory, 'out');

    await invoke(
      'get',
      nzbPath,
      '--config',
      configPath,
      '-o',
      out,
      '--include',
      '*.mkv',
      '--range',
      '-50',
      '--sparse',
    );

    const contents = await readFile(join(out, 'show.mkv'));
    expect(contents.length).toBe(250);
    expect(contents.subarray(200)).toEqual(post.contents.get('show.mkv')?.subarray(200));
  });

  it('refuses two password sources at once', async () => {
    const result = await invoke(
      'stat',
      nzbPath,
      '--config',
      configPath,
      '--pass-env',
      'A',
      '--pass-file',
      '/b',
    );

    expect(result.code).toBe(2);
    expect(result.err).toContain('only one of');
  });

  it('decodes articles from disk with no server at all', async () => {
    const article = join(directory, 'a1');
    const first = post.articles.get('f1s1@fixture.invalid');
    await writeFile(article, first ?? Buffer.alloc(0));
    const out = join(directory, 'decoded');

    const result = await invoke('decode', article, '-o', out);

    expect(result.code).toBe(0);
    expect(await readFile(join(out, 'show.nfo'))).toEqual(post.contents.get('show.nfo'));
  });
});

describe('error reporting', () => {
  it('reports a missing credential as configuration, not as a crash', async () => {
    // A ProviderError means "you have not told me where the password is". The
    // message already names every source tried; frames from inside the provider
    // library help nobody, and exit 2 is the conventional "used it wrong".
    delete process.env['NZB_TEST_PASS'];

    const result = await invoke('stat', nzbPath, '--config', configPath);

    expect(result.code).toBe(2);
    expect(result.err).toContain('NZB_TEST_PASS');
    expect(result.err).not.toContain('    at ');
  });

  it('names every source the default chain tried', async () => {
    const bare = join(directory, 'bare.json');
    await writeFile(
      bare,
      JSON.stringify({ host: '127.0.0.1', port: server?.port ?? 0, security: 'none' }),
    );
    await chmod(bare, 0o600);
    delete process.env['NNTP_USERNAME'];
    delete process.env['NNTP_PASSWORD'];

    const result = await invoke('stat', nzbPath, '--config', bare);

    expect(result.err).toContain('NNTP_USERNAME');
    expect(result.err).toContain('/run/secret/nntp_username');
  });

  it('does not print the same line twice for an unexpected error', async () => {
    const result = await invoke('inspect', join(directory, 'absent.nzb'));

    const lines = result.err.split('\n').filter((line) => line.trim() !== '');
    expect(new Set(lines).size).toBe(lines.length);
  });
});
