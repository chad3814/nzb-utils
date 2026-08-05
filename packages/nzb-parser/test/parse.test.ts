import { describe, expect, it } from 'vitest';

import { parseNzb } from '../src/parse.ts';

const MINIMAL_NZB = `<?xml version="1.0" encoding="iso-8859-1"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="Joe &lt;joe@example.invalid&gt;" date="1071674882" subject="[1/1] - &quot;abc.txt&quot; yEnc (1/1) 1024">
    <groups>
      <group>alt.binaries.misc</group>
    </groups>
    <segments>
      <segment bytes="1058" number="1">abc123@news.example.com</segment>
    </segments>
  </file>
</nzb>`;

describe('parseNzb', () => {
  it('parses a single-file, single-segment document', () => {
    const nzb = parseNzb(MINIMAL_NZB);

    expect(nzb.files).toHaveLength(1);
    const [file] = nzb.files;
    expect(file?.poster).toBe('Joe <joe@example.invalid>');
    expect(file?.subject).toBe('[1/1] - "abc.txt" yEnc (1/1) 1024');
    expect(file?.date).toEqual(new Date(1071674882 * 1000));
    expect(file?.groups).toEqual(['alt.binaries.misc']);
    expect(file?.segments).toEqual([
      { number: 1, bytes: 1058, messageId: 'abc123@news.example.com' },
    ]);
  });
});
