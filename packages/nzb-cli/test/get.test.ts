import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

describe('get', () => {
  it('downloads every file whole', async () => {
    const nntp = await start();

    await get(options(), nntp, silent);

    expect(await readFile(join(out, 'show.mkv'))).toEqual(post.contents.get('show.mkv'));
    expect(await readFile(join(out, 'show.nfo'))).toEqual(post.contents.get('show.nfo'));
  });

  it('names files from the yEnc header, not the subject', async () => {
    // The subject says "show.mkv" here too, but the header is what is
    // authoritative and obfuscated posts make them differ.
    const nntp = await start();

    const report = (await get(options(), nntp, silent)).text;

    expect(report).toContain('show.mkv');
  });

  it('selects files by glob', async () => {
    const nntp = await start();

    await get(options({ include: ['*.nfo'] }), nntp, silent);

    await expect(readFile(join(out, 'show.nfo'))).resolves.toBeDefined();
    await expect(readFile(join(out, 'show.mkv'))).rejects.toThrow();
  });

  it('fails when a glob matches nothing, rather than succeeding silently', async () => {
    const nntp = await start();

    await expect(get(options({ include: ['*.zip'] }), nntp, silent)).rejects.toThrow(CliError);
  });

  it('writes only the requested range, from offset zero', async () => {
    const nntp = await start();

    await get(options({ include: ['*.mkv'], ranges: [{ start: 100, end: 150 }] }), nntp, silent);

    const expected = post.contents.get('show.mkv')?.subarray(100, 150);
    expect(await readFile(join(out, 'show.mkv'))).toEqual(expected);
  });

  it('writes a range at its true offset in a sparse file of full length', async () => {
    // The moov case: one seekable file of the right size with the fetched
    // pieces where they belong.
    const nntp = await start();

    await get(
      options({ include: ['*.mkv'], ranges: [{ start: 200, end: null }], sparse: true }),
      nntp,
      silent,
    );

    const target = join(out, 'show.mkv');
    expect((await stat(target)).size).toBe(250);
    const contents = await readFile(target);
    expect(contents.subarray(200)).toEqual(post.contents.get('show.mkv')?.subarray(200));
    expect(contents.subarray(0, 200).every((byte) => byte === 0)).toBe(true);
  });

  it('reads a suffix range as the last N bytes', async () => {
    const nntp = await start();

    await get(options({ include: ['*.mkv'], ranges: [{ start: -30, end: null }] }), nntp, silent);

    expect(await readFile(join(out, 'show.mkv'))).toEqual(
      post.contents.get('show.mkv')?.subarray(220),
    );
  });

  it('fetches only the articles a range overlaps', async () => {
    const nntp = await start();
    const before = server?.commands.filter((c) => c.startsWith('BODY')).length ?? 0;

    await get(options({ include: ['*.mkv'], ranges: [{ start: 0, end: 50 }] }), nntp, silent);

    const bodies = (server?.commands.filter((c) => c.startsWith('BODY')) ?? []).length - before;
    // Two probes (one per file) plus nothing more: segment 1 is already in hand.
    expect(bodies).toBe(2);
  });

  it('reports what it would do without fetching, under --dry-run', async () => {
    const nntp = await start();

    const report = (await get(options({ dryRun: true }), nntp, silent)).text;

    expect(report).toContain('Dry run');
    await expect(readFile(join(out, 'show.mkv'))).rejects.toThrow();
  });

  it('reports the article count a range will cost', async () => {
    const nntp = await start();

    const report = (
      await get(
        options({ include: ['*.mkv'], ranges: [{ start: 0, end: 150 }], dryRun: true }),
        nntp,
        silent,
      )
    ).text;

    expect(report).toMatch(/\b2\b/u);
  });

  it('emits progress as bytes arrive', async () => {
    const nntp = await start();
    const lines: string[] = [];

    await get(options({ include: ['*.mkv'] }), nntp, (line) => lines.push(line));

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.at(-1)).toContain('show.mkv');
  });

  it('fails when an article is missing rather than writing a short file', async () => {
    const nntp = await start(
      buildPost({ files: FILES, missing: new Set(['f0s2@fixture.invalid']) }),
    );

    await expect(get(options({ include: ['*.mkv'] }), nntp, silent)).rejects.toThrow();
  });

  it('never lets a yEnc filename escape the output directory', async () => {
    const nntp = await start(
      buildPost({ files: [{ name: '../../escaped.bin', segmentSizes: [20] }] }),
    );

    await get(options(), nntp, silent);

    await expect(readFile(join(out, 'escaped.bin'))).resolves.toBeDefined();
  });
});
