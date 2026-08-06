import { CliError } from './errors.ts';
import type { RangeOption } from './options.ts';

/**
 * Parsing `--range` and byte counts.
 *
 * Kept apart from the rest of the argument handling because these are the two
 * places a typo turns into either a wrong download or a very large one, and
 * both are worth testing exhaustively without a filesystem or a network.
 */

/**
 * Suffix multipliers.
 *
 * `MB` is 10^6 and `MiB` is 2^20, as the units actually mean. A bare `M` is
 * binary, because every CLI that takes a size that way treats it as binary and
 * surprising people is worse than being pedantic. Reporting 4 MB when 4 MiB was
 * fetched is a 5% lie repeated in every progress line.
 */
const UNITS = new Map<string, number>([
  ['', 1],
  ['b', 1],
  ['k', 1024],
  ['kib', 1024],
  ['kb', 1000],
  ['m', 1024 ** 2],
  ['mib', 1024 ** 2],
  ['mb', 1000 ** 2],
  ['g', 1024 ** 3],
  ['gib', 1024 ** 3],
  ['gb', 1000 ** 3],
  ['t', 1024 ** 4],
  ['tib', 1024 ** 4],
  ['tb', 1000 ** 4],
]);

const COUNT = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/iu;

/** Parse a byte count, with an optional binary or decimal suffix. */
export function parseByteCount(text: string, flag = '--range'): number {
  const match = COUNT.exec(text.trim());
  const digits = match?.[1];
  if (match === null || digits === undefined) {
    throw new CliError(`${flag}: ${JSON.stringify(text)} is not a byte count`);
  }

  const unit = UNITS.get((match[2] ?? '').toLowerCase());
  if (unit === undefined) {
    throw new CliError(`${flag}: ${JSON.stringify(match[2] ?? '')} is not a known size unit`);
  }

  const bytes = Number(digits) * unit;
  if (!Number.isInteger(bytes)) {
    throw new CliError(`${flag}: ${JSON.stringify(text)} is not a whole number of bytes`);
  }
  return bytes;
}

/**
 * Parse `--range`.
 *
 * Three forms, deliberately shaped like HTTP's so they read the way people
 * expect, with one documented difference:
 *
 * - `START-END` — the half-open range `[START, END)`. **HTTP's is inclusive**;
 *   this one matches `slice()` and the rest of the repo, and the help text says
 *   so, because converting between the two silently is how off-by-one bugs get
 *   into downloads.
 * - `START-` — from `START` to the end of the file.
 * - `-N` — the last `N` bytes.
 */
export function parseRange(text: string): RangeOption {
  const trimmed = text.trim();
  const dash = trimmed.indexOf('-');

  if (dash < 0) {
    throw new CliError(
      `--range: ${JSON.stringify(text)} has no dash; expected START-END, START- or -LAST`,
    );
  }

  const head = trimmed.slice(0, dash).trim();
  const tail = trimmed.slice(dash + 1).trim();

  if (head === '' && tail === '') {
    throw new CliError('--range: expected START-END, START- or -LAST');
  }

  // `-N` is a suffix range. Carried as a negative start so it means the same
  // thing to slice() as it does here, whatever the file turns out to be.
  if (head === '') {
    return { start: -parseByteCount(tail), end: null };
  }

  const start = parseByteCount(head);
  if (tail === '') {
    return { start, end: null };
  }

  const end = parseByteCount(tail);
  if (end <= start) {
    // slice() would return nothing at all. For an explicitly typed flag that is
    // a typo, and downloading zero bytes without comment is worse than saying so.
    throw new CliError(
      `--range: end ${String(end)} is not after start ${String(start)}, so the range is empty`,
    );
  }

  return { start, end };
}
