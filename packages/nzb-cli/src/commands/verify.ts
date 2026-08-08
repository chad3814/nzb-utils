import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { NntpPool } from '@chad3814/nntp';
import { openNzbFile } from '@chad3814/nzb';
import { parseNzb } from '@chad3814/nzb-parser';
import type { NzbFile } from '@chad3814/nzb-parser';
import { Par2FileVerifier, parsePar2 } from '@chad3814/par2';
import type { Par2Set } from '@chad3814/par2';

import { CliError } from '../errors.ts';
import { bytes, plural, table } from '../format.ts';
import type { CommandResult } from './get.ts';
import type { Log } from './get.ts';
import type { VerifyOptions } from '../options.ts';

/**
 * `nzb verify` — check downloaded files against the release's own PAR2 set.
 *
 * Cheap, and worth more than it sounds. The index `.par2` is a single article —
 * 5,396 bytes on the release this was built against — and it carries the
 * authoritative filename, length and MD5 of every protected file, plus per-slice
 * checksums. Recovery slices are not needed to *verify*, only to repair, so this
 * never fetches the hundreds of megabytes of parity volumes.
 *
 * It answers a question nothing else in this toolkit can. Every article is
 * already CRC-checked on arrival, so transit corruption is caught — but that
 * says nothing about whether the *assembly* was right. A file that matches the
 * set's MD5 proves every offset, every `=ypart` check and every join was
 * correct, against an authority we did not write.
 */
export async function verify(
  options: VerifyOptions,
  pool: NntpPool,
  log: Log,
): Promise<CommandResult> {
  const nzb = parse(await read(options.nzbPath), options.nzbPath);
  const { set, volumes } = await loadSet(nzb.files, pool, log);

  const rows: string[][] = [['STATUS', 'SIZE', 'SLICES', 'NAME']];
  let bad = 0;
  let missing = 0;

  for (const file of set.files) {
    const row = await checkOne(file, set, options.directory, log);
    rows.push(row.cells);
    if (row.state === 'absent') {
      missing += 1;
    } else if (row.state === 'bad') {
      bad += 1;
    }
  }

  const lines = [
    table(rows),
    '',
    `${plural(set.files.length, 'protected file')}, ` +
      `${String(set.files.length - bad - missing)} verified, ` +
      `${String(bad)} damaged, ${String(missing)} absent`,
    // "in the volumes read", not "in the set": only the index is fetched, and
    // the index carries no parity at all. Reporting 0 as a property of the set
    // would say a release has no recovery data when it has hundreds of
    // megabytes of it, sitting in files this command deliberately did not read.
    `slice size ${bytes(set.sliceSize)}, ${plural(set.recoverySlices, 'recovery slice')} ` +
      `in the ${plural(volumes, 'volume')} read` +
      (set.creator === null ? '' : `, created by ${set.creator}`),
  ];

  if (bad > 0) {
    // Saying what could be done, without pretending this can do it -- and
    // without claiming to know how much parity exists, since the volumes that
    // hold it were deliberately not fetched.
    lines.push(
      '',
      'Repairing needs Reed-Solomon, which this tool does not implement. If the ' +
        'release has vol*.par2 files, par2cmdline or QuickPar can use them.',
    );
  }

  return { text: lines.join('\n'), failed: bad > 0 || missing > 0 };
}

function describe(damaged: number, lengthMatches: boolean): string {
  if (!lengthMatches) {
    return 'WRONG SIZE';
  }
  return damaged === 0 ? 'BAD MD5' : `DAMAGED (${plural(damaged, 'slice')})`;
}

/**
 * Fetch PAR2 files until the set is readable, smallest first.
 *
 * Smallest first is what keeps this cheap: the index volume holds every
 * critical packet and no parity, so it is normally the only one fetched. The
 * loop exists because a set whose index is missing can still be reconstructed
 * from any volume, since critical packets are duplicated into all of them.
 */
async function loadSet(
  files: readonly NzbFile[],
  pool: NntpPool,
  log: Log,
): Promise<{ set: Par2Set; volumes: number }> {
  const candidates = files
    .filter((file) => (file.subjectHints.name ?? '').toLowerCase().endsWith('.par2'))
    .toSorted((a, b) => a.totalEncodedBytes - b.totalEncodedBytes);

  if (candidates.length === 0) {
    throw new CliError('no .par2 file listed in this NZB, so there is nothing to verify against');
  }

  const volumes: Buffer[] = [];
  for (const candidate of candidates) {
    const name = candidate.subjectHints.name ?? '(unnamed)';
    log(`reading ${name} (${plural(candidate.segments.length, 'article')})`);

    try {
      const handle = await openNzbFile(candidate, pool);
      volumes.push(Buffer.from(await handle.bytes()));
      return { set: parsePar2(...volumes), volumes: volumes.length };
    } catch (error) {
      // A missing or unreadable volume is not fatal while others remain: that
      // redundancy is the reason critical packets are in every one of them.
      log(`cannot use ${name}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }

  throw new CliError('no usable PAR2 volume: every candidate was missing or unreadable');
}

interface Row {
  readonly cells: string[];
  readonly state: 'ok' | 'bad' | 'absent';
}

async function checkOne(
  file: Par2Set['files'][number],
  set: Par2Set,
  directory: string,
  log: Log,
): Promise<Row> {
  const target = join(directory, file.name);
  const found = await sizeOf(target);

  if (found === null) {
    return { state: 'absent', cells: ['ABSENT', bytes(file.length), '-', file.name] };
  }

  log(`verifying ${file.name} (${bytes(found)})`);
  const result = await verifyStream(target, new Par2FileVerifier(file, set.sliceSize));

  return {
    state: result.ok ? 'ok' : 'bad',
    cells: [
      result.ok ? 'ok' : describe(result.damagedSlices.length, result.lengthMatches),
      bytes(result.actualLength),
      result.checkedSlices === 0 ? 'none' : String(result.checkedSlices),
      file.name,
    ],
  };
}

async function verifyStream(
  path: string,
  verifier: Par2FileVerifier,
): Promise<ReturnType<Par2FileVerifier['finish']>> {
  // Streamed: the file this matters for is measured in gigabytes, and reading
  // it into memory to hash it would defeat the point of having streamed it to
  // disk in the first place.
  for await (const chunk of createReadStream(path)) {
    verifier.update(chunk as Uint8Array);
  }
  return verifier.finish();
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new CliError(`cannot read ${path}: ${error instanceof Error ? error.message : 'failed'}`);
  }
}

function parse(xml: string, path: string): ReturnType<typeof parseNzb> {
  try {
    return parseNzb(xml);
  } catch (error) {
    throw new CliError(`${path}: ${error instanceof Error ? error.message : 'is not a valid NZB'}`);
  }
}
