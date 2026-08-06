import { readFile } from 'node:fs/promises';

import { parseNzb } from '@chad3814/nzb-parser';
import type { Nzb, NzbFile } from '@chad3814/nzb-parser';

import { CliError } from '../errors.ts';
import { bytes, plural, table } from '../format.ts';
import type { InspectOptions } from '../options.ts';

/**
 * `nzb inspect` — parse a document and report what is in it.
 *
 * Strictly offline. Everything here is derivable from the XML, and the command
 * is worth having precisely because it is instant and safe to run on a file
 * from an indexer you do not trust.
 *
 * Every size reported is the **encoded** size, because that is the only size an
 * NZB knows. The decoded size lives in the yEnc header of an article and costs
 * a fetch to learn; `nzb stat` and `nzb get` report it, this does not, and the
 * output labels the difference rather than leaving the reader to assume.
 */
export async function inspect(options: InspectOptions): Promise<string> {
  const nzb = parse(await read(options.nzbPath), options.nzbPath);

  return options.json ? JSON.stringify(asJson(nzb), null, 2) : asText(nzb);
}

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new CliError(`cannot read ${path}: ${error instanceof Error ? error.message : 'failed'}`);
  }
}

function parse(xml: string, path: string): Nzb {
  try {
    return parseNzb(xml);
  } catch (error) {
    throw new CliError(`${path}: ${error instanceof Error ? error.message : 'is not a valid NZB'}`);
  }
}

function asText(nzb: Nzb): string {
  const encoded = nzb.files.reduce((total, file) => total + file.totalEncodedBytes, 0);
  const segments = nzb.files.reduce((total, file) => total + file.segments.length, 0);
  const lines: string[] = [];

  for (const meta of nzb.meta) {
    lines.push(`${meta.type}: ${meta.value}`);
  }
  if (nzb.meta.length > 0) {
    lines.push('');
  }

  lines.push(
    `${plural(nzb.files.length, 'file')}, ${plural(segments, 'article')}, ` +
      `${bytes(encoded)} encoded`,
    `groups: ${nzb.groups.join(', ')}`,
    '',
    table([
      ['ARTICLES', 'ENCODED', 'POSTED', 'FLAGS', 'NAME (from subject, advisory)'],
      ...nzb.files.map(describeFile),
    ]),
  );

  const gaps = nzb.files.filter((file) => !file.contiguous).length;
  if (gaps > 0) {
    lines.push(
      '',
      `${plural(gaps, 'file has', 'files have')} non-contiguous segment numbering. That is a gap ` +
        'in the document, not proof of missing articles; run `nzb stat` to ask the server.',
    );
  }

  return lines.join('\n');
}

function describeFile(file: NzbFile): readonly string[] {
  const flags = [
    file.contiguous ? '' : 'gaps',
    file.segments.length === 1 ? 'single' : '',
    // A single-part post has no =ypart line, which is the case the reference
    // implementation crashes on, so it is worth flagging as interesting.
  ]
    .filter((flag) => flag !== '')
    .join(',');

  return [
    String(file.segments.length),
    bytes(file.totalEncodedBytes),
    file.date.toISOString().slice(0, 10),
    flags === '' ? '-' : flags,
    file.subjectHints.name ?? '(none in subject)',
  ];
}

function asJson(nzb: Nzb): unknown {
  return {
    meta: nzb.meta,
    groups: nzb.groups,
    totals: {
      files: nzb.files.length,
      segments: nzb.files.reduce((total, file) => total + file.segments.length, 0),
      // Named so no consumer mistakes it for a decoded size.
      encodedBytes: nzb.files.reduce((total, file) => total + file.totalEncodedBytes, 0),
    },
    files: nzb.files.map((file) => ({
      subject: file.subject,
      poster: file.poster,
      posted: file.date.toISOString(),
      groups: file.groups,
      segments: file.segments.length,
      encodedBytes: file.totalEncodedBytes,
      contiguous: file.contiguous,
      subjectHints: file.subjectHints,
    })),
  };
}
