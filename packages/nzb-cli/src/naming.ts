import { basename } from 'node:path';

import type { NzbFile } from '@chad3814/nzb-parser';

/**
 * Choosing what to call a file, and what `--include` matches against.
 *
 * The yEnc header is authoritative and the subject is a guess, which argues for
 * always using the header. Real posts are less tidy: obfuscated releases
 * randomise `=ybegin name=` per article, so the "authoritative" name of a
 * 7.5 GiB feature is something like `sGxlgomUUnf2DJFts7f8MxYZgurfWfu`, and the
 * only human-readable name in the whole document is in the subject.
 *
 * Measured on a real post: seven probed articles of one file carried seven
 * different header names and one identical size. So the header is authoritative
 * about *bytes*, and frequently says nothing useful about *names*.
 */

/** A name with no extension is the tell for an obfuscated post. */
function hasExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1;
}

/**
 * What to write the file as.
 *
 * The header name wins when it looks like a filename. When it does not and the
 * subject offers one that does, the subject wins — `show.mkv` beats a 31-character
 * random string, and nothing downstream can open a file with no extension.
 */
export function outputName(headerName: string, file: NzbFile): string {
  const hint = file.subjectHints.name;

  if (!hasExtension(headerName) && hint !== null && hasExtension(hint)) {
    return safeName(hint);
  }
  return safeName(headerName);
}

/**
 * Every name a `--include` pattern is allowed to match.
 *
 * Both, because either can be the useful one: a clean post names the file in
 * the header, an obfuscated post names it only in the subject, and a user
 * typing `--include '*.mkv'` means the same thing in both cases.
 */
export function matchableNames(headerName: string, file: NzbFile): readonly string[] {
  const hint = file.subjectHints.name;
  return hint === null || hint === headerName ? [headerName] : [headerName, hint];
}

/**
 * A name from an article or a subject is attacker-controlled, so it names a
 * file in the output directory and never a path.
 */
export function safeName(name: string): string {
  const base = basename(name.replaceAll('\\', '/')).trim();
  return base === '' || base === '.' || base === '..' ? 'unnamed' : base;
}
