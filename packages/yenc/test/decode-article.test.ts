import { describe, expect, it } from 'vitest';

import { decodeArticle } from '../src/decode-article.ts';
import { YencChecksumError, YencDecodeError } from '../src/errors.ts';

/** Reference encoder, as in decode-bytes.test.ts. */
function referenceEncode(data: Uint8Array): Buffer {
  const out: number[] = [];
  for (const byte of data) {
    const value = (byte + 42) % 256;
    if (value === 0x00 || value === 0x0a || value === 0x0d || value === 0x3d) {
      out.push(0x3d, (value + 64) % 256);
    } else {
      out.push(value);
    }
  }
  return Buffer.from(out);
}

/** Assemble an article from literal header/trailer lines and a decoded payload. */
function article(lines: readonly string[], payload: Uint8Array, trailer: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${lines.join('\r\n')}\r\n`, 'latin1'),
    referenceEncode(payload),
    Buffer.from(`\r\n${trailer}\r\n`, 'latin1'),
  ]);
}

const HELLO = Buffer.from('Hello, world!', 'latin1');
const HELLO_CRC = 0xebe6c6e6;

describe('decodeArticle on single-part posts', () => {
  const singlePart = (): Buffer =>
    article(
      ['=ybegin line=128 size=13 name=greeting.txt'],
      HELLO,
      `=yend size=13 crc32=${HELLO_CRC.toString(16)}`,
    );

  it('decodes a single-part article without an =ypart line', () => {
    // The reference implementation reads `props.part.end` unconditionally and
    // throws a TypeError here, which is exactly the .nfo and .jpg you want for
    // a cheap preview.
    const decoded = decodeArticle(singlePart());

    expect(decoded.data).toEqual(HELLO);
    expect(decoded.header.name).toBe('greeting.txt');
    expect(decoded.header.size).toBe(13);
  });

  it('reports a null part range rather than inventing one', () => {
    expect(decodeArticle(singlePart()).part).toBeNull();
  });

  it('verifies the whole-file crc32 a single-part trailer carries', () => {
    const checksum = decodeArticle(singlePart()).checksum;

    expect(checksum.expected).toBe(HELLO_CRC);
    expect(checksum.actual).toBe(HELLO_CRC);
    expect(checksum.matches).toBe(true);
  });
});

describe('decodeArticle on multipart posts', () => {
  const part = (n: number, begin: number, end: number, payload: Buffer, crc: number): Buffer =>
    article(
      [
        `=ybegin part=${n} total=2 line=128 size=32 name=split.bin`,
        `=ypart begin=${begin} end=${end}`,
      ],
      payload,
      `=yend size=${payload.length} part=${n} pcrc32=${crc.toString(16)}`,
    );

  const one = Buffer.from('part one payload', 'latin1');
  const two = Buffer.from('part two payload', 'latin1');

  it('converts the 1-based inclusive =ypart range to a 0-based half-open one', () => {
    // `begin=1 end=16` is bytes 1..16 of the file, inclusive, in yEnc's
    // 1-based numbering — which is [0, 16) to everything else in this repo.
    const decoded = decodeArticle(part(1, 1, 16, one, 0x9da599ae));

    expect(decoded.part).toEqual({ begin: 0, end: 16 });
  });

  it('places the second part at the right offset', () => {
    const decoded = decodeArticle(part(2, 17, 32, two, 0x5ee7fa9d));

    expect(decoded.part).toEqual({ begin: 16, end: 32 });
    expect(decoded.data).toEqual(two);
  });

  it('produces a part length that matches the decoded byte count', () => {
    const decoded = decodeArticle(part(1, 1, 16, one, 0x9da599ae));
    const range = decoded.part;

    expect(range).not.toBeNull();
    expect((range?.end ?? 0) - (range?.begin ?? 0)).toBe(decoded.data.length);
  });

  it('checks pcrc32, which covers this part rather than the whole file', () => {
    expect(decodeArticle(part(1, 1, 16, one, 0x9da599ae)).checksum.matches).toBe(true);
  });

  it('checks pcrc32, not crc32, on a final part that carries both', () => {
    // Real posters put crc32= (the whole reassembled file) on the last part
    // alongside pcrc32= (that part alone). Comparing the whole-file value
    // against one part's bytes fails verification on a perfectly good article.
    const raw = article(
      ['=ybegin part=2 total=2 line=128 size=32 name=split.bin', '=ypart begin=17 end=32'],
      two,
      '=yend size=16 part=2 pcrc32=5ee7fa9d crc32=d0c5f8c0',
    );

    const decoded = decodeArticle(raw);

    expect(decoded.trailer.crc32).toBe(0xd0c5f8c0);
    expect(decoded.trailer.pcrc32).toBe(0x5ee7fa9d);
    expect(decoded.checksum.expected).toBe(0x5ee7fa9d);
    expect(decoded.checksum.matches).toBe(true);
  });

  it('reads the part and total counters from the header', () => {
    const decoded = decodeArticle(part(2, 17, 32, two, 0x5ee7fa9d));

    expect(decoded.header.part).toBe(2);
    expect(decoded.header.total).toBe(2);
  });
});

describe('decodeArticle header field parsing', () => {
  const named = (name: string): Buffer =>
    article([`=ybegin line=128 size=13 name=${name}`], HELLO, '=yend size=13');

  it('keeps spaces in a filename', () => {
    // `name=` is last on the line precisely because filenames contain spaces.
    expect(decodeArticle(named('Some Movie (2026).mkv')).header.name).toBe('Some Movie (2026).mkv');
  });

  it('keeps an equals sign in a filename', () => {
    expect(decodeArticle(named('weird=name.bin')).header.name).toBe('weird=name.bin');
  });

  it('tolerates a missing line= field', () => {
    const decoded = decodeArticle(
      article(['=ybegin size=13 name=greeting.txt'], HELLO, '=yend size=13'),
    );

    expect(decoded.header.line).toBeNull();
    expect(decoded.header.name).toBe('greeting.txt');
  });

  it('ignores leading junk before the =ybegin line', () => {
    // Some servers prepend blank lines or a stray header remnant.
    const raw = Buffer.concat([
      Buffer.from('\r\n', 'latin1'),
      article(['=ybegin line=128 size=13 name=greeting.txt'], HELLO, '=yend size=13'),
    ]);

    expect(decodeArticle(raw).data).toEqual(HELLO);
  });
});

describe('decodeArticle checksum handling', () => {
  const withCrc = (crc: string): Buffer =>
    article(['=ybegin line=128 size=13 name=greeting.txt'], HELLO, `=yend size=13 crc32=${crc}`);

  it('reports a mismatch without throwing by default', () => {
    const decoded = decodeArticle(withCrc('deadbeef'));

    expect(decoded.checksum.matches).toBe(false);
    expect(decoded.checksum.expected).toBe(0xdeadbeef);
    expect(decoded.checksum.actual).toBe(HELLO_CRC);
  });

  it('throws when verification is requested and the checksum is wrong', () => {
    expect(() => decodeArticle(withCrc('deadbeef'), { verify: true })).toThrow(YencChecksumError);
  });

  it('does not throw when verification is requested and the checksum is right', () => {
    expect(() => decodeArticle(withCrc(HELLO_CRC.toString(16)), { verify: true })).not.toThrow();
  });

  it('reports a null match when the trailer carries no checksum at all', () => {
    const decoded = decodeArticle(
      article(['=ybegin line=128 size=13 name=greeting.txt'], HELLO, '=yend size=13'),
    );

    expect(decoded.checksum.expected).toBeNull();
    expect(decoded.checksum.matches).toBeNull();
  });

  it('does not throw on a missing checksum even when verification is requested', () => {
    // Nothing to verify against is not the same as failing verification.
    expect(() =>
      decodeArticle(
        article(['=ybegin line=128 size=13 name=greeting.txt'], HELLO, '=yend size=13'),
        { verify: true },
      ),
    ).not.toThrow();
  });
});

describe('decodeArticle rejects malformed articles', () => {
  it('rejects an article with no =ybegin line', () => {
    expect(() => decodeArticle(Buffer.from('just some text\r\n', 'latin1'))).toThrow(
      YencDecodeError,
    );
  });

  it('rejects an article with no =yend line', () => {
    const raw = Buffer.concat([
      Buffer.from('=ybegin line=128 size=13 name=greeting.txt\r\n', 'latin1'),
      referenceEncode(HELLO),
      Buffer.from('\r\n', 'latin1'),
    ]);

    expect(() => decodeArticle(raw)).toThrow(/=yend/u);
  });

  it('rejects a =ybegin line with no name', () => {
    expect(() =>
      decodeArticle(article(['=ybegin line=128 size=13'], HELLO, '=yend size=13')),
    ).toThrow(/name/u);
  });

  it('rejects a =ypart range that runs backwards', () => {
    expect(() =>
      decodeArticle(
        article(
          ['=ybegin part=1 total=2 line=128 size=32 name=split.bin', '=ypart begin=17 end=8'],
          HELLO,
          '=yend size=13 part=1',
        ),
      ),
    ).toThrow(YencDecodeError);
  });

  it('flags a trailer size that disagrees with the decoded byte count', () => {
    const decoded = decodeArticle(
      article(['=ybegin line=128 size=13 name=greeting.txt'], HELLO, '=yend size=999'),
    );

    expect(decoded.trailer.size).toBe(999);
    expect(decoded.data).toHaveLength(13);
    expect(decoded.sizeMatches).toBe(false);
  });
});
