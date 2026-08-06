import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NntpPool } from '@chad3814/nntp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stat as statCommand } from '../src/commands/stat.ts';
import type { ServerSettings, StatOptions } from '../src/options.ts';
import { startFakeServer } from '../../nntp/test/fake-server.ts';
import type { FakeServer } from '../../nntp/test/fake-server.ts';
import { buildPost, responder } from './post.ts';
import type { Post } from './post.ts';

/** Two files: a three-article mkv and a one-article nfo. */
const FILES = [
  { name: 'show.mkv', segmentSizes: [100, 100, 50] },
  { name: 'show.nfo', segmentSizes: [40] },
];

let directory = '';
let server: FakeServer | null = null;
let pool: NntpPool | null = null;
let nzbPath = '';

async function start(built: Post = buildPost({ files: FILES })): Promise<NntpPool> {
  server = await startFakeServer({ respond: responder(built) });
  nzbPath = join(directory, 'test.nzb');
  await writeFile(nzbPath, built.xml);

  pool = new NntpPool({
    endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
    credentials: { user: 'someone', pass: 'secret' },
    connections: 2,
  });
  return pool;
}

function options(overrides: Partial<StatOptions> = {}): StatOptions {
  const settings: ServerSettings = {
    host: '127.0.0.1',
    port: server?.port ?? 0,
    security: 'none',
    connections: 2,
    user: 'someone',
    password: { env: 'UNUSED' },
    credentialTtlMs: null,
  };
  return { nzbPath, server: settings, sample: 3, json: false, ...overrides };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nzb-stat-'));
});

afterEach(async () => {
  pool?.destroy();
  pool = null;
  await server?.close();
  server = null;
  await rm(directory, { recursive: true, force: true });
});

describe('stat', () => {
  it('reports every file present on a healthy post', async () => {
    const nntp = await start();

    const report = (await statCommand(options({ sample: 3 }), nntp)).text;

    expect(report).toContain('ok');
    expect(report).not.toContain('GONE');
  });

  it('transfers no article bodies', async () => {
    // The whole point: retention for the price of a status line.
    const nntp = await start();

    await statCommand(options({ sample: 3 }), nntp);

    expect(server?.commands.filter((c) => c.startsWith('BODY'))).toEqual([]);
  });

  it('samples rather than checking everything by default', async () => {
    const nntp = await start();

    await statCommand(options({ sample: 2 }), nntp);

    // 2 of 3 for the mkv, 1 for the single-article nfo.
    expect(server?.commands.filter((c) => c.startsWith('STAT')).length).toBe(3);
  });

  it('checks every article when asked', async () => {
    const nntp = await start();

    await statCommand(options({ sample: null }), nntp);

    expect(server?.commands.filter((c) => c.startsWith('STAT')).length).toBe(4);
  });

  it('says the sample is not proof', async () => {
    const nntp = await start();

    const report = (await statCommand(options({ sample: 1 }), nntp)).text;

    expect(report).toContain('not proof');
  });

  it('reports a partially retained file as PARTIAL, naming the gap', async () => {
    const nntp = await start(
      buildPost({ files: FILES, missing: new Set(['f0s2@fixture.invalid']) }),
    );

    const report = (await statCommand(options({ sample: null }), nntp)).text;

    expect(report).toContain('PARTIAL');
    expect(report).toContain('2');
  });

  it('reports a wholly missing file as GONE', async () => {
    const nntp = await start(
      buildPost({ files: FILES, missing: new Set(['f1s1@fixture.invalid']) }),
    );

    const report = (await statCommand(options({ sample: null }), nntp)).text;

    expect(report).toContain('GONE');
  });

  it('emits parseable JSON with --json', async () => {
    const nntp = await start();

    const report = (await statCommand(options({ sample: null, json: true }), nntp)).text;

    expect(JSON.parse(report)).toMatchObject({ complete: true });
  });
});
