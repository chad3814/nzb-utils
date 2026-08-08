import { createHash } from 'node:crypto';

import type { NntpPool } from '@chad3814/nntp';
import type { NzbFile } from '@chad3814/nzb-parser';
import { openNzbFile } from '@chad3814/nzb';
import type { NzbFileHandle } from '@chad3814/nzb';
import { decodeArticle } from '@chad3814/yenc';

/**
 * The individual checks the smoke test runs. Each returns a one-line note for
 * the report, or throws.
 *
 * Every one of these is something a synthetic fixture cannot establish: that the
 * geometry prediction survives a real 1800-article post, that a slice assembled
 * across an article boundary is byte-identical to the articles joined by hand,
 * and that a provider's articles are actually still there.
 */

const MIB = 1024 * 1024;

export const mib = (bytes: number): string => `${(bytes / MIB).toFixed(2)} MiB`;
const sha = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/** Read a whole file through a handle and confirm the byte count agrees. */
export async function readWhole(file: NzbFile, pool: NntpPool): Promise<string> {
  const handle = await openNzbFile(file, pool);
  const bytes = await handle.bytes();
  if (bytes.length !== handle.size) {
    throw new Error(`read ${String(bytes.length)} bytes of a declared ${String(handle.size)}`);
  }
  return `name=${handle.name} size=${String(handle.size)} type=${handle.type || '-'} sha=${sha(bytes)}`;
}

/**
 * What the probe concluded, and how far the NZB's own numbers were from it.
 *
 * The gap is yEnc overhead: an NZB reports encoded article sizes, and anything
 * that presents their sum as a file size is over by a few per cent.
 */
export function describeGeometry(handle: NzbFileHandle, file: NzbFile): string {
  const { geometry } = handle;
  const overhead = ((file.totalEncodedBytes - handle.size) / handle.size) * 100;
  const reconstructed =
    (geometry.segmentCount - 1) * geometry.segmentSize + geometry.lastSegmentSize;

  if (geometry.uniform && reconstructed !== geometry.totalSize) {
    throw new Error(
      `prediction does not add up: ${String(reconstructed)} vs ${String(geometry.totalSize)}`,
    );
  }

  return (
    `size=${String(handle.size)} (${mib(handle.size)}) segment=${String(geometry.segmentSize)} ` +
    `last=${String(geometry.lastSegmentSize)} uniform=${String(geometry.uniform)} ` +
    `yEnc overhead=${overhead.toFixed(2)}%`
  );
}

/**
 * Confirm every probed article sits where uniform arithmetic put it.
 *
 * This is the prediction in predict-then-verify, checked across the whole span
 * rather than only at the ends.
 */
export async function placement(
  file: NzbFile,
  pool: NntpPool,
  handle: NzbFileHandle,
): Promise<string> {
  const count = file.segments.length;
  const numbers = [...new Set([1, 2, 3, Math.floor(count / 2), count - 1, count])].filter(
    (n) => n >= 1 && n <= count,
  );
  const names = new Set<string>();
  const sizes = new Set<number>();

  for (const number of numbers) {
    const segment = file.segments[number - 1];
    if (segment === undefined) {
      continue;
    }
    const { body } = await pool.body(segment.messageId);
    const article = decodeArticle(body, { verify: true });
    names.add(article.header.name);
    sizes.add(article.header.size);

    const expected = (number - 1) * handle.geometry.segmentSize;
    const actual = article.part?.begin ?? 0;
    if (actual !== expected) {
      throw new Error(
        `segment ${String(number)} declares begin=${String(actual)}, predicted ${String(expected)}`,
      );
    }
  }

  if (sizes.size !== 1) {
    throw new Error(`articles disagree on =ybegin size=: ${[...sizes].join(', ')}`);
  }
  // Obfuscated posts randomise the filename per article. That is normal, and
  // reporting it keeps the reason the name check was removed visible.
  return (
    `${String(numbers.length)} articles all where predicted; ` +
    `${String(names.size)} distinct =ybegin name= values, 1 distinct size=`
  );
}

/** A slice with nothing in it must cost nothing. */
export async function emptySlice(handle: NzbFileHandle, pool: NntpPool): Promise<string> {
  const before = pool.failures.length;
  const bytes = await handle.slice(0, 0).bytes();
  if (bytes.length > 0) {
    throw new Error(`slice(0, 0) produced ${String(bytes.length)} bytes`);
  }
  return `0 bytes, ${String(pool.failures.length - before)} new connection failures`;
}

/** Read from the front, and report whatever file signature turns up. */
export async function headSlice(handle: NzbFileHandle, length: number): Promise<string> {
  const bytes = await handle.slice(0, length).bytes();
  if (bytes.length !== Math.min(length, handle.size)) {
    throw new Error(`expected ${String(length)} bytes, got ${String(bytes.length)}`);
  }
  const magic = Buffer.from(bytes.subarray(0, 12))
    .toString('latin1')
    .replaceAll(/[^\u0020-\u007E]/gu, '.');
  return `${mib(bytes.length)} sha=${sha(bytes)} first12=${JSON.stringify(magic)}`;
}

/** Read from the back. The point of the package: this is one article, not all of them. */
export async function tailSlice(handle: NzbFileHandle, length: number): Promise<string> {
  const bytes = await handle.slice(-length).bytes();
  if (bytes.length !== Math.min(length, handle.size)) {
    throw new Error(`expected ${String(length)} bytes, got ${String(bytes.length)}`);
  }
  return `${mib(bytes.length)} sha=${sha(bytes)}`;
}

/**
 * A slice of a slice must stay inside its parent, and must agree with the
 * equivalent slice taken directly.
 */
export async function nestedClamp(handle: NzbFileHandle): Promise<string> {
  const window = handle.slice(MIB, 2 * MIB);
  const inner = window.slice(MIB / 2, 99 * MIB);

  if (inner.size !== MIB / 2) {
    throw new Error(`nested slice escaped its parent: ${String(inner.size)} bytes`);
  }

  const nested = Buffer.from(await inner.bytes());
  const direct = Buffer.from(await handle.slice(MIB + MIB / 2, 2 * MIB).bytes());
  if (!nested.equals(direct)) {
    throw new Error('nested slice differs from the equivalent direct slice');
  }
  return `${mib(nested.length)}, identical to the equivalent direct slice`;
}

/**
 * The join arithmetic, against articles fetched independently.
 *
 * A window straddling the boundary between segments 2 and 3 must equal the tail
 * of one article concatenated with the head of the next. Also counts how many
 * lines arrived dot-stuffed, which is encoder-dependent and worth knowing rather
 * than assuming.
 */
/**
 * How far either side of a segment boundary to compare.
 *
 * Scaled to the segment rather than a fixed 1 MiB. Article sizes vary
 * enormously — 4 MiB on one release, 330 KB on a magazine post — and a
 * hardcoded window goes negative on the small ones, where `subarray` silently
 * counts from the end and compares two unrelated stretches of the file.
 */
function reachFor(segmentSize: number): number {
  return Math.min(MIB, Math.floor(segmentSize / 2));
}

export async function boundaryJoin(
  file: NzbFile,
  pool: NntpPool,
  handle: NzbFileHandle,
): Promise<string> {
  const size = handle.geometry.segmentSize;
  const parts: Buffer[] = [];
  let stuffed = 0;
  let lines = 0;

  for (const number of [2, 3]) {
    const segment = file.segments[number - 1];
    if (segment === undefined) {
      throw new Error(`file has no segment ${String(number)}`);
    }
    const { body } = await pool.body(segment.messageId);
    // Any line here that begins with "." arrived as ".." and was unstuffed by
    // the transport. yEnc decoders do not do this, so counting them says
    // whether this post exercises the path at all.
    for (const line of body.toString('latin1').split('\r\n')) {
      lines += 1;
      if (line.startsWith('.')) {
        stuffed += 1;
      }
    }
    parts.push(Buffer.from(decodeArticle(body, { verify: true }).data));
  }

  const [second, third] = parts;
  if (second === undefined || third === undefined) {
    throw new Error('expected two articles');
  }

  // Segment 2 is [size, 2*size) and segment 3 is [2*size, 3*size), so the
  // boundary between them is at 2*size.
  const reach = reachFor(size);
  const joined = Buffer.concat([second.subarray(size - reach), third.subarray(0, reach)]);
  const sliced = Buffer.from(await handle.slice(2 * size - reach, 2 * size + reach).bytes());

  if (!sliced.equals(joined)) {
    throw new Error('slice across the 2|3 boundary differs from the articles joined by hand');
  }
  return (
    `${mib(sliced.length)} across the 2|3 boundary matches; ` +
    `${String(stuffed)} of ${String(lines)} lines arrived dot-stuffed`
  );
}

/**
 * Are the articles still there?
 *
 * `STAT` asks without transferring a body. Partial availability is normal on
 * Usenet and is not a client bug, but it is worth knowing before blaming code
 * for a failed read.
 */
export async function retention(
  nzb: { files: readonly NzbFile[] },
  pool: NntpPool,
): Promise<string[]> {
  const rows: string[] = [];

  for (const file of nzb.files) {
    const count = file.segments.length;
    const picks = [...new Set([0, Math.floor(count / 2), count - 1])];
    const results: string[] = [];

    for (const index of picks) {
      const segment = file.segments[index];
      if (segment === undefined) {
        continue;
      }
      try {
        const response = await pool.stat(segment.messageId);
        results.push(`${String(index + 1)}:${String(response.code)}`);
      } catch (error) {
        results.push(`${String(index + 1)}:${error instanceof Error ? error.message : 'error'}`);
      }
    }

    rows.push(
      `  ${String(count).padStart(5)} seg  ${results.join('  ').padEnd(30)}  ${file.subjectHints.name ?? '(no name in subject)'}`,
    );
  }

  return rows;
}
