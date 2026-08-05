import { describe, expect, it } from 'vitest';

import { ResponseBuffer } from '../src/response-buffer.ts';

function bytes(text: string): Buffer {
  return Buffer.from(text, 'latin1');
}

function fed(...chunks: readonly string[]): ResponseBuffer {
  const buffer = new ResponseBuffer();
  for (const chunk of chunks) {
    buffer.push(bytes(chunk));
  }
  return buffer;
}

describe('ResponseBuffer status lines', () => {
  it('returns a complete line without its CRLF', () => {
    expect(fed('200 ready\r\n').takeLine()).toBe('200 ready');
  });

  it('returns null while the line is incomplete', () => {
    expect(fed('200 rea').takeLine()).toBeNull();
  });

  it('reassembles a line split across chunks', () => {
    expect(fed('200 re', 'ady\r\n').takeLine()).toBe('200 ready');
  });

  it('returns consecutive lines in order', () => {
    const buffer = fed('381 more\r\n281 ok\r\n');

    expect(buffer.takeLine()).toBe('381 more');
    expect(buffer.takeLine()).toBe('281 ok');
    expect(buffer.takeLine()).toBeNull();
  });

  it('decodes status text as latin1 so no byte is mangled', () => {
    expect(fed('200 caf\u00E9\r\n').takeLine()).toBe('200 caf\u00E9');
  });
});

describe('ResponseBuffer multi-line blocks', () => {
  it('returns block content without the terminating dot line', () => {
    expect(fed('one\r\ntwo\r\n.\r\n').takeBlock()).toEqual(bytes('one\r\ntwo\r\n'));
  });

  it('returns null while the terminator has not arrived', () => {
    expect(fed('one\r\ntwo\r\n').takeBlock()).toBeNull();
  });

  it('returns an empty buffer for a body that is only a terminator', () => {
    // A naive scan for "\r\n.\r\n" never matches this, because there is no
    // preceding line. STAT-like empty bodies then hang until the socket times
    // out.
    const block = fed('.\r\n').takeBlock();

    expect(block).not.toBeNull();
    expect(block).toHaveLength(0);
  });

  it('reassembles a block split mid-line', () => {
    expect(fed('on', 'e\r\ntw', 'o\r\n.\r\n').takeBlock()).toEqual(bytes('one\r\ntwo\r\n'));
  });

  it('reassembles a block whose terminator is split across chunks', () => {
    // The terminator can arrive as "\r\n." then "\r\n". A scanner that only
    // looks at each chunk in isolation misses it.
    expect(fed('one\r\n', '.', '\r\n').takeBlock()).toEqual(bytes('one\r\n'));
  });

  it('reassembles a block whose terminator is split one byte at a time', () => {
    expect(fed('one\r', '\n', '.', '\r', '\n').takeBlock()).toEqual(bytes('one\r\n'));
  });

  it('finds a split terminator when polled after every chunk', () => {
    // How the client actually drives this: try to read on each 'data' event
    // rather than once at the end. A scanner that advances its search cursor
    // to the end of the buffer on a failed attempt steps past the '.' that
    // arrives mid-terminator and then never matches, hanging the request until
    // the socket times out.
    const buffer = new ResponseBuffer();
    const polled: (Buffer | null)[] = [];

    for (const chunk of ['one\r', '\n', '.', '\r', '\n']) {
      buffer.push(bytes(chunk));
      polled.push(buffer.takeBlock());
    }

    expect(polled.at(-1)).toEqual(bytes('one\r\n'));
    expect(polled.slice(0, -1).every((value) => value === null)).toBe(true);
  });

  it('finds a terminator when polled after every chunk of a long body', () => {
    const buffer = new ResponseBuffer();
    let block: Buffer | null = null;

    for (const chunk of ['aaa\r\nbbb', '\r\nccc\r', '\n', '.\r\n']) {
      buffer.push(bytes(chunk));
      block ??= buffer.takeBlock();
    }

    expect(block).toEqual(bytes('aaa\r\nbbb\r\nccc\r\n'));
  });

  it('leaves bytes after the terminator for the next read', () => {
    const buffer = fed('one\r\n.\r\n205 bye\r\n');

    expect(buffer.takeBlock()).toEqual(bytes('one\r\n'));
    expect(buffer.takeLine()).toBe('205 bye');
  });
});

describe('ResponseBuffer dot-unstuffing', () => {
  it('removes the added dot from a line that begins with one', () => {
    // NNTP transmits a body line starting with "." as "..". yEnc decoders do
    // not undo this -- @thaunknown/yencode calls its decoder with
    // stripDots = false -- so the transport has to, or roughly one article in
    // a few hundred is silently corrupted.
    expect(fed('..hidden\r\n.\r\n').takeBlock()).toEqual(bytes('.hidden\r\n'));
  });

  it('reduces a line of only dots by exactly one', () => {
    expect(fed('...\r\n.\r\n').takeBlock()).toEqual(bytes('..\r\n'));
  });

  it('leaves a dot that is not at the start of a line alone', () => {
    expect(fed('a.b\r\nc..d\r\n.\r\n').takeBlock()).toEqual(bytes('a.b\r\nc..d\r\n'));
  });

  it('unstuffs every affected line in a block', () => {
    expect(fed('..a\r\nb\r\n..c\r\n.\r\n').takeBlock()).toEqual(bytes('.a\r\nb\r\n.c\r\n'));
  });
});

describe('ResponseBuffer binary safety', () => {
  it('preserves all 256 byte values in a block', () => {
    // Usenet is 8-bit clean and yEnc output spans the whole range. Anything
    // that round-trips the payload through a UTF-8 decode destroys it.
    const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const buffer = new ResponseBuffer();
    buffer.push(Buffer.concat([payload, bytes('\r\n.\r\n')]));

    expect(buffer.takeBlock()).toEqual(Buffer.concat([payload, bytes('\r\n')]));
  });

  it('does not treat a 0x2E byte inside binary data as a stuffed dot', () => {
    const payload = Buffer.from([0x00, 0xff, 0x2e, 0x80]);
    const buffer = new ResponseBuffer();
    buffer.push(Buffer.concat([payload, bytes('\r\n.\r\n')]));

    expect(buffer.takeBlock()).toEqual(Buffer.concat([payload, bytes('\r\n')]));
  });
});
