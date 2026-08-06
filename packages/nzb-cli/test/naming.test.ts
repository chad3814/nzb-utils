import { describe, expect, it } from 'vitest';

import type { NzbFile } from '@chad3814/nzb-parser';

import { matchableNames, outputName, safeName } from '../src/naming.ts';

function file(hint: string | null): NzbFile {
  return {
    poster: 'p',
    date: new Date(0),
    subject: 'subject',
    groups: [],
    segments: [],
    subjectHints: { name: hint, part: null, totalParts: null, declaredSize: null },
    totalEncodedBytes: 0,
    contiguous: true,
  };
}

describe('outputName', () => {
  it('uses the yEnc header name, which is the authoritative one', () => {
    expect(outputName('real.mkv', file('guess.mkv'))).toBe('real.mkv');
  });

  it('falls back to the subject when the header name is obfuscated', () => {
    // Measured on a real post: the header name of a 7.5 GiB feature was
    // "sGxlgomUUnf2DJFts7f8MxYZgurfWfu", and every article carried a different
    // one. Writing that to disk gives a file nothing can open.
    expect(outputName('sGxlgomUUnf2DJFts7f8MxYZgurfWfu', file('show.mkv'))).toBe('show.mkv');
  });

  it('keeps the header name when the subject has no extension either', () => {
    expect(outputName('abc123', file('def456'))).toBe('abc123');
  });

  it('keeps the header name when the subject offers nothing', () => {
    expect(outputName('abc123', file(null))).toBe('abc123');
  });

  it('does not mistake a leading dot for an extension', () => {
    expect(outputName('.hidden', file('real.nfo'))).toBe('real.nfo');
  });

  it('does not mistake a trailing dot for an extension', () => {
    expect(outputName('trailing.', file('real.nfo'))).toBe('real.nfo');
  });
});

describe('matchableNames', () => {
  it('offers both names, so --include works on obfuscated and clean posts alike', () => {
    expect(matchableNames('random', file('show.mkv'))).toEqual(['random', 'show.mkv']);
  });

  it('does not repeat an identical name', () => {
    expect(matchableNames('show.mkv', file('show.mkv'))).toEqual(['show.mkv']);
  });

  it('copes with no subject hint', () => {
    expect(matchableNames('show.mkv', file(null))).toEqual(['show.mkv']);
  });
});

describe('safeName', () => {
  it('strips a traversal attempt', () => {
    expect(safeName('../../.ssh/authorized_keys')).toBe('authorized_keys');
  });

  it('strips a Windows path', () => {
    expect(safeName(String.raw`C:\Windows\System32\hosts`)).toBe('hosts');
  });

  it('replaces a name that reduces to nothing', () => {
    expect(safeName('..')).toBe('unnamed');
    expect(safeName('   ')).toBe('unnamed');
  });
});
