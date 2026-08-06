import { describe, expect, it } from 'vitest';

import { matchesAny } from '../src/match.ts';

describe('matchesAny', () => {
  it('matches everything when no patterns are given', () => {
    // `--include` absent means "all files", not "no files".
    expect(matchesAny('anything.mkv', [])).toBe(true);
  });

  it('matches a literal name', () => {
    expect(matchesAny('movie.mkv', ['movie.mkv'])).toBe(true);
    expect(matchesAny('movie.mkv', ['other.mkv'])).toBe(false);
  });

  it('matches a star against any run of characters', () => {
    expect(matchesAny('movie.mkv', ['*.mkv'])).toBe(true);
    expect(matchesAny('movie.mkv', ['mov*'])).toBe(true);
    expect(matchesAny('movie.mkv', ['*.par2'])).toBe(false);
  });

  it('matches a question mark against exactly one character', () => {
    expect(matchesAny('a.nfo', ['?.nfo'])).toBe(true);
    expect(matchesAny('ab.nfo', ['?.nfo'])).toBe(false);
  });

  it('matches if any pattern matches', () => {
    expect(matchesAny('cover.jpg', ['*.mkv', '*.jpg'])).toBe(true);
  });

  it('is case-insensitive, because Usenet filenames are not consistent', () => {
    expect(matchesAny('MOVIE.MKV', ['*.mkv'])).toBe(true);
  });

  it('treats a star as crossing separators, since these are names not paths', () => {
    // The subject of the match is a decoded filename, never a path, so there is
    // no directory boundary for a star to respect.
    expect(matchesAny('dir/movie.mkv', ['*movie*'])).toBe(true);
  });

  it('does not let a pattern character escape into the regexp', () => {
    // A filename is attacker-controlled: it comes from a yEnc header in an NZB
    // from an indexer. A pattern built by naive concatenation would let `.` or
    // `(` change what gets matched, or hang on a crafted backreference.
    expect(matchesAny('a+b.mkv', ['a+b.mkv'])).toBe(true);
    expect(matchesAny('axb.mkv', ['a+b.mkv'])).toBe(false);
    expect(matchesAny('file.mkv', ['file.mkv'])).toBe(true);
    expect(matchesAny('fileXmkv', ['file.mkv'])).toBe(false);
  });

  it('handles a pattern that is only stars', () => {
    expect(matchesAny('anything', ['*'])).toBe(true);
    expect(matchesAny('anything', ['**'])).toBe(true);
  });

  it('matches an empty name only against a matching pattern', () => {
    expect(matchesAny('', ['*'])).toBe(true);
    expect(matchesAny('', ['?'])).toBe(false);
  });
});
