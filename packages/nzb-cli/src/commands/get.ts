import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NntpPool } from '@chad3814/nntp';
import { openNzbFile } from '@chad3814/nzb';
import type { NzbFileHandle } from '@chad3814/nzb';
import { parseNzb } from '@chad3814/nzb-parser';
import type { NzbFile } from '@chad3814/nzb-parser';

import { CliError } from '../errors.ts';
import { bytes, plural, table } from '../format.ts';
import { matchesAny } from '../match.ts';
import { matchableNames, outputName } from '../naming.ts';
import type { GetOptions, RangeOption } from '../options.ts';
import { openSink } from '../sink.ts';

/**
 * `nzb get` — download whole files, or ranges of them.
 *
 * Opening each file costs one article: that is what supplies the authoritative
 * filename and decoded size, neither of which an NZB has. Only then can
 * `--include` be matched against a real name, so a fetch of one file out of
 * eight still probes all eight. That is eight articles, and it is the honest
 * price of not trusting the subject line.
 */
export async function get(options: GetOptions, pool: NntpPool, log: Log): Promise<CommandResult> {
  const nzb = parse(await read(options.nzbPath), options.nzbPath);
  const rows: string[][] = [['BYTES', 'ARTICLES', 'RANGE', 'NAME']];
  const selected: Selected[] = [];
  const unopenable: string[] = [];

  for (const file of nzb.files) {
    const chosen = await select(file, options, pool, log, unopenable);
    if (chosen !== null) {
      selected.push(chosen);
      rows.push(describe(chosen));
    }
  }

  if (selected.length === 0) {
    throw new CliError(
      options.include.length === 0
        ? `no file in ${options.nzbPath} could be opened`
        : `nothing matched ${options.include.map((p) => JSON.stringify(p)).join(', ')}`,
    );
  }

  const notes = unopenable.length === 0 ? [] : ['', skipped(unopenable, options)];

  if (options.dryRun) {
    return {
      text: [table(rows), '', 'Dry run: nothing fetched.', ...notes].join('\n'),
      failed: failing(unopenable, options),
    };
  }

  let total = 0;
  for (const item of selected) {
    total += await download(item, options, log);
  }

  return {
    text: [
      table(rows),
      '',
      `${bytes(total)} written to ${options.outputDir} from ${plural(selected.length, 'file')}`,
      ...notes,
    ].join('\n'),
    failed: failing(unopenable, options),
  };
}

/**
 * A file that could not be opened is skipped, not fatal.
 *
 * Opening reads segment 1, and on a real post an article does occasionally
 * expire. Aborting the whole run because an unrelated `.nfo` is gone would make
 * the tool useless on exactly the releases people reach for it with. What is
 * *not* acceptable is being quiet about it, so each one is reported.
 *
 * Whether that makes the run a failure depends on what was asked for: with no
 * `--include`, every file was requested and a missing one is a partial result.
 * With `--include`, the skipped file may well be one nobody wanted — and its
 * real name is unknowable precisely because it could not be opened.
 */
function skipped(unopenable: readonly string[], options: GetOptions): string {
  const detail = `skipped ${plural(unopenable.length, 'file')} that could not be opened: ${unopenable.join(', ')}`;
  return options.include.length === 0
    ? `${detail}\nThis fetch is incomplete.`
    : `${detail}\nThey may or may not have matched --include; their real names live in the articles that are missing.`;
}

function failing(unopenable: readonly string[], options: GetOptions): boolean {
  return options.include.length === 0 && unopenable.length > 0;
}

/** What a command produced, and whether the run should be considered a failure. */
export interface CommandResult {
  readonly text: string;
  readonly failed: boolean;
}

/** Where progress goes. Separate from the report so it can be sent to stderr. */
export type Log = (line: string) => void;

interface Selected {
  readonly handle: NzbFileHandle;
  /** One entry per `--range`, or a single whole-file window when none was given. */
  readonly windows: readonly Window[];
  /** What it will be written as, which is not always the header's name. */
  readonly name: string;
  readonly articles: number;
}

interface Window {
  readonly handle: NzbFileHandle;
  /** Absolute offset in the complete file, which is where a sparse write goes. */
  readonly offset: number;
}

async function select(
  file: NzbFile,
  options: GetOptions,
  pool: NntpPool,
  log: Log,
  unopenable: string[],
): Promise<Selected | null> {
  // One article, and it is what turns a subject-line guess into a real name.
  let handle: NzbFileHandle;
  try {
    handle = await openNzbFile(file, pool, { verify: options.verify });
  } catch (error) {
    const label = file.subjectHints.name ?? file.subject;
    log(`cannot open ${label}: ${error instanceof Error ? error.message : 'failed'}`);
    unopenable.push(label);
    return null;
  }

  // Matched against the header name *and* the subject's guess: an obfuscated
  // post puts a random string in the header, so matching only that would make
  // --include useless on exactly the releases it is most wanted for.
  if (!matchableNames(handle.name, file).some((name) => matchesAny(name, options.include))) {
    return null;
  }

  const windows = (options.ranges.length === 0 ? [null] : options.ranges)
    .map((range) => ({ handle: apply(handle, range), offset: offsetOf(handle, range) }))
    .filter((window) => window.handle.size > 0);

  if (windows.length === 0) {
    log(`skipping ${handle.name}: the requested range is empty within it`);
    return null;
  }

  return {
    handle,
    windows,
    name: outputName(handle.name, file),
    articles: windows.reduce(
      (total, window) => total + countArticles(handle, window.offset, window.handle.size),
      0,
    ),
  };
}

function apply(handle: NzbFileHandle, range: RangeOption | null): NzbFileHandle {
  if (range === null) {
    return handle.slice();
  }
  return range.end === null ? handle.slice(range.start) : handle.slice(range.start, range.end);
}

/** Absolute start of the window, needed to place bytes in a sparse file. */
function offsetOf(handle: NzbFileHandle, range: RangeOption | null): number {
  if (range === null) {
    return 0;
  }
  return range.start < 0
    ? Math.max(0, handle.size + range.start)
    : Math.min(range.start, handle.size);
}

function countArticles(handle: NzbFileHandle, offset: number, length: number): number {
  const { segmentSize, segmentCount } = handle.geometry;
  if (!handle.geometry.uniform || segmentSize <= 0 || length === 0) {
    return 0;
  }
  const first = Math.floor(offset / segmentSize);
  const last = Math.min(Math.floor((offset + length - 1) / segmentSize), segmentCount - 1);
  return last - first + 1;
}

function describe(item: Selected): string[] {
  const total = item.windows.reduce((sum, window) => sum + window.handle.size, 0);
  const span =
    total === item.handle.size
      ? 'whole file'
      : item.windows
          .map((window) => `${String(window.offset)}-${String(window.offset + window.handle.size)}`)
          .join(' + ') + ` of ${String(item.handle.size)}`;

  return [bytes(total), String(item.articles), span, item.name];
}

async function download(item: Selected, options: GetOptions, log: Log): Promise<number> {
  const { name } = item;
  const first = item.windows[0];
  if (first === undefined) {
    return 0;
  }

  // One sink for all the ranges of a file: opening it once is what lets a head
  // and a tail land in the same sparse file instead of the second truncating
  // the first.
  const sink = await openSink(join(options.outputDir, name), {
    sparse: options.sparse,
    declaredSize: item.handle.size,
    rangeStart: first.offset,
  });

  const expected = item.windows.reduce((sum, window) => sum + window.handle.size, 0);
  let written = 0;

  try {
    for (const window of item.windows) {
      let inWindow = 0;
      // Streamed rather than buffered: a whole-file get of a 7.8 GiB release
      // must not need 7.8 GiB of RSS to succeed.
      for await (const chunk of window.handle) {
        await sink.write(window.offset + inWindow, chunk);
        inWindow += chunk.byteLength;
        written += chunk.byteLength;
        log(`${name}: ${bytes(written)} of ${bytes(expected)}`);
      }
    }
  } finally {
    await sink.close();
  }

  return written;
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
