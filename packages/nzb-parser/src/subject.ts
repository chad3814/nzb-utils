import type { NzbSubjectHints } from './models.ts';

/**
 * Recover filename and part counters from a Usenet article subject.
 *
 * NZB has no filename field, so every client regexes the subject. The
 * conventional shape is:
 *
 * ```
 * Release.Name [2/7] - "the file.par2" yEnc (1/9) 34624863
 *               ^file counter  ^name          ^part counter  ^decoded size
 * ```
 *
 * Everything here is advisory. The authoritative name and size come from the
 * yEnc `=ybegin name=` / `size=` headers at fetch time, which is why the result
 * type is called *hints* and every field is nullable. A best guess is fine; a
 * confident wrong answer is not, so anything that does not match the convention
 * yields `null` rather than a heuristic.
 */

/** The last `(n/m)`, optionally followed by a decoded byte count. */
const PART_COUNTER = /\((\d+)\/(\d+)\)(?:\s+(\d+))?(?![\s\S]*\(\d+\/\d+\))/u;

const EMPTY: NzbSubjectHints = {
  name: null,
  part: null,
  totalParts: null,
  declaredSize: null,
};

export function parseSubject(subject: string): NzbSubjectHints {
  return {
    name: extractName(subject),
    ...extractCounters(subject),
  };
}

/**
 * The filename is the last double-quoted run. Last rather than first because
 * some posters prefix a quoted release name before the quoted filename.
 *
 * Unquoted subjects deliberately yield `null`: picking "the token that looks
 * like a filename" guesses wrong on release names that contain dots, which is
 * most of them.
 */
function extractName(subject: string): string | null {
  const close = subject.lastIndexOf('"');
  if (close <= 0) {
    return null;
  }
  const open = subject.lastIndexOf('"', close - 1);
  if (open < 0) {
    return null;
  }
  const name = subject.slice(open + 1, close).trim();
  return name.length > 0 ? name : null;
}

function extractCounters(subject: string): Omit<NzbSubjectHints, 'name'> {
  const match = PART_COUNTER.exec(subject);
  if (match === null) {
    return { part: EMPTY.part, totalParts: EMPTY.totalParts, declaredSize: EMPTY.declaredSize };
  }

  const [, part, totalParts, declaredSize] = match;
  return {
    part: toInteger(part),
    totalParts: toInteger(totalParts),
    declaredSize: toInteger(declaredSize),
  };
}

function toInteger(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
