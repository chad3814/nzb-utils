import { describe, expect, it } from 'vitest';

import { parseSubject } from '../src/subject.ts';

describe('parseSubject', () => {
  it('reads the quoted filename, part counter, and trailing size', () => {
    expect(parseSubject('[1/1] - "abc.txt" yEnc (1/1) 1024')).toEqual({
      name: 'abc.txt',
      part: 1,
      totalParts: 1,
      declaredSize: 1024,
    });
  });

  it('takes the parenthesized part counter, not the bracketed file counter', () => {
    // `[2/7]` is "file 2 of 7 in this set"; `(1/9)` is "article 1 of 9 for this
    // file". Conflating them makes a 9-segment file look like a 7-segment one.
    expect(parseSubject('Some.Release [2/7] - "file.par2" yEnc (1/9) 34624863')).toEqual({
      name: 'file.par2',
      part: 1,
      totalParts: 9,
      declaredSize: 34624863,
    });
  });

  it('ignores parentheses inside the filename', () => {
    expect(parseSubject('"Some Movie (2026).mkv" yEnc (3/1868)')).toEqual({
      name: 'Some Movie (2026).mkv',
      part: 3,
      totalParts: 1868,
      declaredSize: null,
    });
  });

  it('reports a null name when the subject quotes nothing', () => {
    expect(parseSubject('an unquoted subject yEnc (3/1868)')).toEqual({
      name: null,
      part: 3,
      totalParts: 1868,
      declaredSize: null,
    });
  });

  it('reports all nulls for a subject with no conventional structure', () => {
    expect(parseSubject('just some words')).toEqual({
      name: null,
      part: null,
      totalParts: null,
      declaredSize: null,
    });
  });
});
