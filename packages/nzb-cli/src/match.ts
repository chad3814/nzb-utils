/**
 * Glob matching for `--include`.
 *
 * Just `*` and `?`, matched against a decoded filename rather than a path — so
 * there are no separators for a star to respect and no need for `**`. Written
 * here rather than pulled in, both to keep the dependency list honest and
 * because the input is untrusted: the name comes from a yEnc header in an NZB
 * an indexer supplied.
 */

/** Everything a regexp treats specially, so a pattern cannot smuggle syntax in. */
const SPECIAL = /[\\^$.*+?()[\]{}|]/gu;

const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }

  // Escape first, then reinstate the two wildcards. Doing it the other way
  // round would let a `.` in the filename pattern match any character, so
  // `file.mkv` would also match `fileXmkv`.
  const source = pattern
    .replaceAll(SPECIAL, String.raw`\$&`)
    .replaceAll(String.raw`\*`, '.*')
    .replaceAll(String.raw`\?`, '.');

  const compiled = new RegExp(`^${source}$`, 'iu');
  cache.set(pattern, compiled);
  return compiled;
}

/** True when `name` matches any pattern, or when there are no patterns at all. */
export function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.length === 0 || patterns.some((pattern) => compile(pattern).test(name));
}
