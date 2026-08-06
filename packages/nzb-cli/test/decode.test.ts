import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decode } from '../src/commands/decode.ts';
import { CliError } from '../src/errors.ts';

let directory = '';
let out = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nzb-decode-'));
  out = join(directory, 'out');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const LINE = 128;

function encodePayload(data: Buffer): Buffer {
  const bytes: number[] = [];
  let column = 0;

  for (const byte of data) {
    const value = (byte + 42) % 256;
    const escaped = value === 0x00 || value === 0x0a || value === 0x0d || value === 0x3d;

    if (column >= LINE) {
      bytes.push(0x0d, 0x0a);
      column = 0;
    }
    if (escaped) {
      bytes.push(0x3d, (value + 64) % 256);
      column += 2;
    } else {
      bytes.push(value);
      column += 1;
    }
  }

  return Buffer.from(bytes);
}

/**
 * A payload whose every encoded line starts with a literal `.`.
 *
 * 0x04 encodes to (0x04 + 42) = 0x2E, which is `.`, and needs no escaping — so
 * every wrapped line begins with one and NNTP stuffs every one of them. Without
 * a payload like this the unstuffing tests pass whether or not unstuffing
 * happens, which is exactly the trap they exist to catch.
 */
const DOTTY = Buffer.alloc(300, 0x04);

interface ArticleSpec {
  readonly name: string;
  readonly payload: Buffer;
  readonly totalSize: number;
  readonly part?: { readonly index: number; readonly begin: number };
  readonly stuff?: boolean;
  readonly badCrc?: boolean;
}

async function writeArticle(file: string, spec: ArticleSpec): Promise<string> {
  const checksum = (spec.badCrc === true ? 0 : crc32(spec.payload)).toString(16).padStart(8, '0');
  const head =
    spec.part === undefined
      ? `=ybegin line=128 size=${String(spec.totalSize)} name=${spec.name}\r\n`
      : `=ybegin part=${String(spec.part.index)} line=128 size=${String(spec.totalSize)} name=${spec.name}\r\n` +
        `=ypart begin=${String(spec.part.begin + 1)} end=${String(spec.part.begin + spec.payload.length)}\r\n`;
  const tail =
    spec.part === undefined
      ? `\r\n=yend size=${String(spec.payload.length)} crc32=${checksum}\r\n`
      : `\r\n=yend size=${String(spec.payload.length)} part=${String(spec.part.index)} pcrc32=${checksum}\r\n`;

  let article = Buffer.concat([
    Buffer.from(head, 'latin1'),
    encodePayload(spec.payload),
    Buffer.from(tail, 'latin1'),
  ]);

  if (spec.stuff === true) {
    // What a raw socket capture looks like: every line starting with "." has
    // an extra one.
    article = Buffer.from(
      article
        .toString('latin1')
        .split('\r\n')
        .map((line) => (line.startsWith('.') ? `.${line}` : line))
        .join('\r\n'),
      'latin1',
    );
  }

  const path = join(directory, file);
  await writeFile(path, article);
  return path;
}

const HELLO = Buffer.from('hello world', 'latin1');

describe('decode', () => {
  it('decodes a single-part article', async () => {
    const path = await writeArticle('a.txt', {
      name: 'greeting.txt',
      payload: HELLO,
      totalSize: HELLO.length,
    });

    await decode({ articlePaths: [path], outputDir: out, dotStuffed: false, verify: true });

    expect(await readFile(join(out, 'greeting.txt'))).toEqual(HELLO);
  });

  it('reports the checksum result per article', async () => {
    const path = await writeArticle('a.txt', {
      name: 'greeting.txt',
      payload: HELLO,
      totalSize: HELLO.length,
    });

    const output = await decode({
      articlePaths: [path],
      outputDir: out,
      dotStuffed: false,
      verify: true,
    });

    expect(output).toContain('ok');
  });

  it('places parts at their true offsets in one sparse file', async () => {
    // Articles 1 and 3 of a three-part file: the output must be full length
    // with both pieces where they belong, not 20 bytes of concatenation.
    const head = Buffer.from('HEAD', 'latin1');
    const tail = Buffer.from('TAIL', 'latin1');
    const first = await writeArticle('p1', {
      name: 'split.bin',
      payload: head,
      totalSize: 1000,
      part: { index: 1, begin: 0 },
    });
    const third = await writeArticle('p3', {
      name: 'split.bin',
      payload: tail,
      totalSize: 1000,
      part: { index: 3, begin: 996 },
    });

    await decode({
      articlePaths: [first, third],
      outputDir: out,
      dotStuffed: false,
      verify: true,
    });

    const target = join(out, 'split.bin');
    expect((await stat(target)).size).toBe(1000);
    const contents = await readFile(target);
    expect(contents.subarray(0, 4)).toEqual(head);
    expect(contents.subarray(996)).toEqual(tail);
  });

  it('accepts parts in any order', async () => {
    const first = await writeArticle('p1', {
      name: 'split.bin',
      payload: Buffer.from('AAAA'),
      totalSize: 100,
      part: { index: 1, begin: 0 },
    });
    const second = await writeArticle('p2', {
      name: 'split.bin',
      payload: Buffer.from('BBBB'),
      totalSize: 100,
      part: { index: 2, begin: 50 },
    });

    await decode({
      articlePaths: [second, first],
      outputDir: out,
      dotStuffed: false,
      verify: true,
    });

    const contents = await readFile(join(out, 'split.bin'));
    expect(contents.subarray(0, 4)).toEqual(Buffer.from('AAAA'));
    expect(contents.subarray(50, 54)).toEqual(Buffer.from('BBBB'));
  });

  it('unstuffs a raw capture when told to', async () => {
    const path = await writeArticle('raw', {
      name: 'binary.bin',
      payload: DOTTY,
      totalSize: DOTTY.length,
      stuff: true,
    });

    // Guard the fixture: if the capture is not actually stuffed, this test and
    // the one below both pass for the wrong reason.
    expect((await readFile(path)).includes(Buffer.from('\r\n..', 'latin1'))).toBe(true);

    await decode({ articlePaths: [path], outputDir: out, dotStuffed: true, verify: true });

    expect(await readFile(join(out, 'binary.bin'))).toEqual(DOTTY);
  });

  it('fails a stuffed capture when not told to unstuff, rather than writing wrong bytes', async () => {
    // The whole reason --dot-stuffed exists. Without it the payload decodes to
    // something subtly wrong, and the CRC is what notices.
    const path = await writeArticle('raw', {
      name: 'binary.bin',
      payload: DOTTY,
      totalSize: DOTTY.length,
      stuff: true,
    });

    await expect(
      decode({ articlePaths: [path], outputDir: out, dotStuffed: false, verify: true }),
    ).rejects.toThrow(CliError);
  });

  it('refuses a corrupt article when verifying', async () => {
    const path = await writeArticle('bad', {
      name: 'greeting.txt',
      payload: HELLO,
      totalSize: HELLO.length,
      badCrc: true,
    });

    await expect(
      decode({ articlePaths: [path], outputDir: out, dotStuffed: false, verify: true }),
    ).rejects.toThrow(CliError);
  });

  it('reports a mismatch instead of failing when not verifying', async () => {
    const path = await writeArticle('bad', {
      name: 'greeting.txt',
      payload: HELLO,
      totalSize: HELLO.length,
      badCrc: true,
    });

    const output = await decode({
      articlePaths: [path],
      outputDir: out,
      dotStuffed: false,
      verify: false,
    });

    expect(output).toContain('MISMATCH');
  });

  it('never lets a yEnc filename escape the output directory', async () => {
    // The name comes from an article, which came from a stranger. Treating it
    // as a path is how a decoder overwrites ~/.ssh/authorized_keys.
    const path = await writeArticle('evil', {
      name: '../../escaped.txt',
      payload: HELLO,
      totalSize: HELLO.length,
    });

    await decode({ articlePaths: [path], outputDir: out, dotStuffed: false, verify: true });

    expect(await readFile(join(out, 'escaped.txt'))).toEqual(HELLO);
  });

  it('strips a Windows path from a filename too', async () => {
    const path = await writeArticle('evil2', {
      name: String.raw`C:\Windows\System32\drivers\etc\hosts`,
      payload: HELLO,
      totalSize: HELLO.length,
    });

    await decode({ articlePaths: [path], outputDir: out, dotStuffed: false, verify: true });

    expect(await readFile(join(out, 'hosts'))).toEqual(HELLO);
  });

  it('requires at least one article', async () => {
    await expect(
      decode({ articlePaths: [], outputDir: out, dotStuffed: false, verify: true }),
    ).rejects.toThrow(CliError);
  });

  it('fails helpfully on a file that is not an article', async () => {
    const path = join(directory, 'plain.txt');
    await writeFile(path, 'no yEnc here');

    await expect(
      decode({ articlePaths: [path], outputDir: out, dotStuffed: false, verify: true }),
    ).rejects.toThrow(/plain\.txt/u);
  });
});
