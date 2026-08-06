import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { unstuff } from '@chad3814/nntp';
import { decodeArticle } from '@chad3814/yenc';
import type { YencArticle } from '@chad3814/yenc';

import { CliError } from '../errors.ts';
import { bytes, plural, table } from '../format.ts';
import type { DecodeOptions } from '../options.ts';
import { openSink } from '../sink.ts';
import type { Sink } from '../sink.ts';

/**
 * `nzb decode` — decode raw articles already on disk.
 *
 * For articles captured out of band: a socket dump, a file another tool saved,
 * an article pulled by hand. Offline, and useful precisely when something has
 * gone wrong enough that you have the bytes but not a working pipeline.
 *
 * Parts of one file are written into a sparse file at their true `=ypart`
 * offsets, so decoding articles 1 and 1868 of a set produces a correctly-sized
 * file with both pieces in the right places rather than 8 MiB of concatenation.
 */
export async function decode(options: DecodeOptions): Promise<string> {
  if (options.articlePaths.length === 0) {
    throw new CliError('nzb decode: give it at least one article file');
  }

  const sinks = new Map<string, Sink>();
  const written = new Map<string, number>();
  const rows: string[][] = [['ARTICLE', 'PART', 'BYTES', 'CRC32', 'INTO']];

  try {
    for (const path of options.articlePaths) {
      const article = await load(path, options);
      const name = safeName(article.header.name, path);
      const sink = await sinkFor(join(options.outputDir, name), article, sinks);

      // A part carries its own offset, so writing it there is what makes an
      // arbitrary subset of articles land correctly in one file.
      await sink.write(article.part?.begin ?? 0, article.data);
      written.set(name, (written.get(name) ?? 0) + article.data.length);

      rows.push([
        basename(path),
        article.part === null ? 'single' : String(article.header.part ?? 0),
        bytes(article.data.length),
        describeChecksum(article),
        name,
      ]);
    }
  } finally {
    for (const sink of sinks.values()) {
      await sink.close();
    }
  }

  const total = [...written.values()].reduce((sum, count) => sum + count, 0);
  return [
    table(rows),
    '',
    `${plural(options.articlePaths.length, 'article')} decoded into ` +
      `${plural(written.size, 'file')}, ${bytes(total)}`,
  ].join('\n');
}

/** One sink per output file, sized from the first article that mentions it. */
async function sinkFor(
  target: string,
  article: YencArticle,
  sinks: Map<string, Sink>,
): Promise<Sink> {
  const existing = sinks.get(target);
  if (existing !== undefined) {
    return existing;
  }

  // Always sparse: the caller supplied an arbitrary subset of the parts, in an
  // arbitrary order, and each one belongs at its own offset.
  const sink = await openSink(target, {
    sparse: true,
    declaredSize: article.header.size,
    rangeStart: 0,
  });
  sinks.set(target, sink);
  return sink;
}

async function load(path: string, options: DecodeOptions): Promise<YencArticle> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    throw new CliError(`cannot read ${path}: ${error instanceof Error ? error.message : 'failed'}`);
  }

  // NNTP sends a body line beginning with "." as ".."; nothing in a yEnc
  // decoder undoes it, so a raw capture has to be unstuffed first or the
  // article decodes to subtly wrong bytes and the CRC catches it far too late.
  const body = options.dotStuffed ? unstuff(raw) : raw;

  try {
    return decodeArticle(body, { verify: options.verify });
  } catch (error) {
    throw new CliError(
      `${path}: ${error instanceof Error ? error.message : 'is not a decodable yEnc article'}`,
      1,
    );
  }
}

/**
 * A filename out of a yEnc header is attacker-controlled, so it never becomes a
 * path. `../../.ssh/authorized_keys` reduces to `authorized_keys`.
 */
function safeName(name: string, path: string): string {
  const base = basename(name.replaceAll('\\', '/')).trim();
  return base === '' || base === '.' || base === '..' ? `${basename(path)}.decoded` : base;
}

function describeChecksum(article: YencArticle): string {
  if (article.checksum.matches === null) {
    return 'none';
  }
  return article.checksum.matches ? 'ok' : 'MISMATCH';
}
