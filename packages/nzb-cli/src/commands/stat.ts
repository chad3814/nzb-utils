import { readFile } from 'node:fs/promises';

import { NNTP_STATUS } from '@chad3814/nntp';
import type { NntpPool } from '@chad3814/nntp';
import { parseNzb } from '@chad3814/nzb-parser';
import type { NzbFile, NzbSegment } from '@chad3814/nzb-parser';

import { CliError } from '../errors.ts';
import { plural, table } from '../format.ts';
import type { StatOptions } from '../options.ts';
import type { CommandResult } from './get.ts';

/**
 * `nzb stat` — is this release still there?
 *
 * `STAT` answers `223` or `430` without transferring an article, so checking a
 * scattered handful per file tells a live set from a dead one for effectively
 * no bandwidth. Retention is the question an NZB cannot answer itself: a
 * contiguous segment list says the *document* has no gaps, not that any
 * provider still holds the articles.
 *
 * Sampling is the default because the honest alternative on a 1868-article file
 * is 1868 round-trips. `--all` is there when the answer has to be exact — a
 * sample that comes back clean is evidence, not proof, and the output says so.
 */
export async function stat(options: StatOptions, pool: NntpPool): Promise<CommandResult> {
  const nzb = parseDocument(await read(options.nzbPath), options.nzbPath);
  const results: FileResult[] = [];

  for (const file of nzb.files) {
    results.push(await check(file, options.sample, pool));
  }

  return {
    text: options.json ? JSON.stringify(asJson(results), null, 2) : asText(results, options),
    // A script asking "is this still there?" needs the answer in the exit code.
    failed: results.some((result) => result.missing.length > 0),
  };
}

interface FileResult {
  readonly name: string;
  readonly segments: number;
  readonly checked: number;
  readonly present: number;
  readonly missing: readonly number[];
}

async function check(file: NzbFile, sample: number | null, pool: NntpPool): Promise<FileResult> {
  const chosen = pick(file.segments, sample);
  const missing: number[] = [];
  let present = 0;

  for (const segment of chosen) {
    const code = await statusOf(segment, pool);
    if (code === NNTP_STATUS.articleExists) {
      present += 1;
    } else {
      missing.push(segment.number);
    }
  }

  return {
    name: file.subjectHints.name ?? file.subject,
    segments: file.segments.length,
    checked: chosen.length,
    present,
    missing,
  };
}

async function statusOf(segment: NzbSegment, pool: NntpPool): Promise<number> {
  try {
    return (await pool.stat(segment.messageId)).code;
  } catch (error) {
    // A 430 arrives as a protocol error, and it is an answer rather than a
    // failure: the article is gone. Anything else -- a dead socket, a refused
    // login -- is not this command's to swallow, because reporting a whole
    // release as missing when the password is wrong is the reference
    // implementation's sin in a different costume.
    if (error instanceof Error && error.message.includes(String(NNTP_STATUS.noSuchArticle))) {
      return NNTP_STATUS.noSuchArticle;
    }
    throw error;
  }
}

/**
 * First, middle and last by default: the ends catch a truncated post and the
 * middle catches the partial propagation that leaves both ends intact.
 */
function pick(segments: readonly NzbSegment[], sample: number | null): readonly NzbSegment[] {
  if (sample === null || sample >= segments.length) {
    return segments;
  }
  if (sample <= 0) {
    return [];
  }
  if (sample === 1) {
    return segments.slice(0, 1);
  }

  const chosen: NzbSegment[] = [];
  const step = (segments.length - 1) / (sample - 1);
  for (let index = 0; index < sample; index += 1) {
    const segment = segments[Math.round(index * step)];
    if (segment !== undefined && !chosen.includes(segment)) {
      chosen.push(segment);
    }
  }
  return chosen;
}

function asText(results: readonly FileResult[], options: StatOptions): string {
  const rows: string[][] = [['CHECKED', 'PRESENT', 'ARTICLES', 'STATUS', 'NAME']];

  for (const result of results) {
    rows.push([
      String(result.checked),
      String(result.present),
      String(result.segments),
      status(result),
      result.name,
    ]);
  }

  const complete = results.filter((result) => result.missing.length === 0).length;
  const lines = [
    table(rows),
    '',
    `${String(complete)} of ${plural(results.length, 'file')} fully present in the sample`,
  ];

  if (options.sample !== null) {
    lines.push(
      'Sampled, not exhaustive: a clean sample is evidence of retention, not proof. Use --all ' +
        'to check every article.',
    );
  }

  return lines.join('\n');
}

function status(result: FileResult): string {
  if (result.missing.length === 0) {
    return 'ok';
  }
  if (result.present === 0) {
    return 'GONE';
  }
  return `PARTIAL (${result.missing.slice(0, 5).join(', ')})`;
}

function asJson(results: readonly FileResult[]): unknown {
  return {
    files: results,
    complete: results.every((result) => result.missing.length === 0),
  };
}

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new CliError(`cannot read ${path}: ${error instanceof Error ? error.message : 'failed'}`);
  }
}

function parseDocument(xml: string, path: string): ReturnType<typeof parseNzb> {
  try {
    return parseNzb(xml);
  } catch (error) {
    throw new CliError(`${path}: ${error instanceof Error ? error.message : 'is not a valid NZB'}`);
  }
}
