import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NntpPool } from '@chad3814/nntp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { get } from '../src/commands/get.ts';
import { CliError } from '../src/errors.ts';
import type { GetOptions, ServerSettings } from '../src/options.ts';
import { startFakeServer } from '../../nntp/test/fake-server.ts';
import type { FakeServer } from '../../nntp/test/fake-server.ts';
import { buildPost, responder } from './post.ts';
import type { Post } from './post.ts';

/** Two files: a three-article mkv of 250 bytes, and a one-article nfo. */
const FILES = [
  { name: 'show.mkv', segmentSizes: [100, 100, 50] },
  { name: 'show.nfo', segmentSizes: [40] },
];

let directory = '';
let out = '';
let server: FakeServer | null = null;
let pool: NntpPool | null = null;
let post: Post;
let nzbPath = '';

const SERVER: Omit<ServerSettings, 'host' | 'port'> = {
  security: 'none',
  connections: 2,
  user: 'someone',
  password: { env: 'UNUSED' },
  credentialTtlMs: null,
};

async function start(built: Post = buildPost({ files: FILES })): Promise<NntpPool> {
  post = built;
  server = await startFakeServer({ respond: responder(post) });
  nzbPath = join(directory, 'test.nzb');
  await writeFile(nzbPath, post.xml);

  pool = new NntpPool({
    endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
    credentials: { user: SERVER.user as string, pass: 'secret' },
    connections: SERVER.connections,
  });
  return pool;
}

function options(overrides: Partial<GetOptions> = {}): GetOptions {
  return {
    nzbPath,
    server: { ...SERVER, host: '127.0.0.1', port: server?.port ?? 0 },
    outputDir: out,
    include: [],
    ranges: [],
    sparse: false,
    verify: true,
    dryRun: false,
    ...overrides,
  };
}

const silent = (): void => {};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nzb-get-'));
  out = join(directory, 'out');
});

afterEach(async () => {
  pool?.destroy();
  pool = null;
  await server?.close();
  server = null;
  await rm(directory, { recursive: true, force: true });
});

describe('get with an unavailable file', () => {
  it('skips a file it cannot open and fetches the rest', async () => {
    // A single expired article in an unrelated file must not make the whole
    // release unfetchable. This is the shape of every real post eventually.
    const nntp = await start(
      buildPost({ files: FILES, missing: new Set(['f1s1@fixture.invalid']) }),
    );

    const result = await get(options({ include: ['*.mkv'] }), nntp, silent);

    expect(await readFile(join(out, 'show.mkv'))).toEqual(post.contents.get('show.mkv'));
    expect(result.text).toContain('skipped');
  });

  it('names the skipped file on the progress channel', async () => {
    const nntp = await start(
      buildPost({ files: FILES, missing: new Set(['f1s1@fixture.invalid']) }),
    );
    const lines: string[] = [];

    await get(options({ include: ['*.mkv'] }), nntp, (line) => lines.push(line));

    expect(lines.join('\n')).toContain('cannot open');
  });

  it('does not call the run a failure when --include was given', async () => {
    // The skipped file may be one nobody asked for, and its real name is
    // unknowable precisely because it could not be opened.
    const nntp = await start(
      buildPost({ files: FILES, missing: new Set(['f1s1@fixture.invalid']) }),
    );

    const result = await get(options({ include: ['*.mkv'] }), nntp, silent);

    expect(result.failed).toBe(false);
  });

  it('does call it a failure when every file was requested', async () => {
    const nntp = await start(
      buildPost({ files: FILES, missing: new Set(['f1s1@fixture.invalid']) }),
    );

    const result = await get(options(), nntp, silent);

    expect(result.failed).toBe(true);
    expect(result.text).toContain('incomplete');
  });

  it('fails outright when no file can be opened at all', async () => {
    const nntp = await start(
      buildPost({
        files: FILES,
        missing: new Set(['f0s1@fixture.invalid', 'f1s1@fixture.invalid']),
      }),
    );

    await expect(get(options(), nntp, silent)).rejects.toThrow(CliError);
  });
});

describe('get with several ranges', () => {
  it('writes a head and a tail into one sparse file', async () => {
    // The moov case, end to end: an MP4's index sits at the front on a
    // faststart encode and the back on most remuxes, and an NZB cannot say
    // which. Both ends in one seekable file works either way.
    const nntp = await start();

    await get(
      options({
        include: ['*.mkv'],
        ranges: [
          { start: 0, end: 20 },
          { start: -20, end: null },
        ],
        sparse: true,
      }),
      nntp,
      silent,
    );

    const contents = await readFile(join(out, 'show.mkv'));
    const whole = post.contents.get('show.mkv');
    expect(contents.length).toBe(250);
    expect(contents.subarray(0, 20)).toEqual(whole?.subarray(0, 20));
    expect(contents.subarray(230)).toEqual(whole?.subarray(230));
    expect(contents.subarray(20, 230).every((byte) => byte === 0)).toBe(true);
  });

  it('does not let the second range truncate the first', async () => {
    // The bug this design avoids: one sink per file, opened once.
    const nntp = await start();

    const result = await get(
      options({
        include: ['*.mkv'],
        ranges: [
          { start: 0, end: 20 },
          { start: -20, end: null },
        ],
        sparse: true,
      }),
      nntp,
      silent,
    );

    expect(result.text).toContain('40 B');
  });

  it('sums the article cost across ranges', async () => {
    const nntp = await start();

    const result = await get(
      options({
        include: ['*.mkv'],
        ranges: [
          { start: 0, end: 20 },
          { start: -20, end: null },
        ],
        sparse: true,
        dryRun: true,
      }),
      nntp,
      silent,
    );

    // Segment 1 and segment 3.
    expect(result.text).toContain('0-20 + 230-250');
  });
});
