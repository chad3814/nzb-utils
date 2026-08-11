import { describe, expect, it } from 'vitest';

import { openNzbFile } from '../src/handle.ts';
import { buildPost } from './post.ts';

/** Four 100-byte segments and a 40-byte tail: 340 bytes over 4 articles. */
const SEGMENTS = [100, 100, 100, 40];

async function open(): Promise<{
  handle: Awaited<ReturnType<typeof openNzbFile>>;
  post: ReturnType<typeof buildPost>;
}> {
  const post = buildPost({ name: 'payload.bin', segmentSizes: SEGMENTS });
  const handle = await openNzbFile(post.file, post.source);
  return { handle, post };
}

describe('openNzbFile', () => {
  it('reports the authoritative name and size from the yEnc header', async () => {
    const { handle } = await open();

    expect(handle.name).toBe('payload.bin');
    expect(handle.size).toBe(340);
  });

  it('takes lastModified from the article posting date', async () => {
    const date = new Date('2026-03-04T05:06:07.000Z');
    const post = buildPost({ segmentSizes: [10], date });

    const handle = await openNzbFile(post.file, post.source);

    expect(handle.lastModified).toBe(date.getTime());
  });

  it('infers a MIME type from the authoritative filename', async () => {
    const post = buildPost({ name: 'show.s01e01.mkv', segmentSizes: [10] });

    const handle = await openNzbFile(post.file, post.source);

    expect(handle.type).toBe('video/x-matroska');
  });

  it('uses an empty type for an unrecognized extension, as Blob does', async () => {
    const post = buildPost({ name: 'payload.bin', segmentSizes: [10] });

    const handle = await openNzbFile(post.file, post.source);

    expect(handle.type).toBe('');
  });

  it('keeps the parsed NZB entry reachable', async () => {
    const { handle, post } = await open();

    expect(handle.source).toBe(post.file);
  });
});

describe('slicing', () => {
  it('performs no I/O', async () => {
    const { handle, post } = await open();
    const before = post.source.requestCount;

    handle.slice(0, 200).slice(10, 20).slice(-5);

    expect(post.source.requestCount).toBe(before);
  });

  it('makes slice(0, 0) empty', async () => {
    // The audit case. nzb-file short-circuits on end === 0 and returns a
    // full-size clone, so this reads the entire file.
    const { handle } = await open();

    expect(handle.slice(0, 0).size).toBe(0);
  });

  it('fetches nothing at all for an empty slice', async () => {
    const { handle, post } = await open();
    const before = post.source.requestCount;

    await expect(handle.slice(0, 0).bytes()).resolves.toEqual(new Uint8Array(0));
    expect(post.source.requestCount).toBe(before);
  });

  it('clamps a nested slice to its parent window, not to the file', async () => {
    // nzb-file clamps to the original file size, so this sub-slice would run
    // to byte 340 and hand back 190 bytes the caller never asked for.
    const { handle, post } = await open();
    const middle = handle.slice(100, 200);

    const overrun = middle.slice(50, 500);

    expect(overrun.size).toBe(50);
    await expect(overrun.bytes()).resolves.toEqual(new Uint8Array(post.data.subarray(150, 200)));
  });

  it('resolves a negative offset against this handle, not the file', async () => {
    const { handle, post } = await open();
    const middle = handle.slice(100, 200);

    const tail = middle.slice(-10);

    expect(tail.size).toBe(10);
    await expect(tail.bytes()).resolves.toEqual(new Uint8Array(post.data.subarray(190, 200)));
  });

  it('never escapes the original window however deeply nested', async () => {
    const { handle, post } = await open();

    const deep = handle.slice(50, 300).slice(10, 999).slice(-1000).slice(5, 15);

    expect(deep.size).toBe(10);
    await expect(deep.bytes()).resolves.toEqual(new Uint8Array(post.data.subarray(65, 75)));
  });

  it('returns an equivalent handle for slice() with no arguments', async () => {
    const { handle } = await open();

    const copy = handle.slice();

    expect(copy.size).toBe(handle.size);
    expect(copy.name).toBe(handle.name);
  });

  it('overrides the MIME type when asked', async () => {
    const { handle } = await open();

    expect(handle.slice(0, 10, 'application/octet-stream').type).toBe('application/octet-stream');
  });

  it('inherits the parent MIME type when not asked', async () => {
    const post = buildPost({ name: 'clip.mkv', segmentSizes: [10] });
    const handle = await openNzbFile(post.file, post.source);

    expect(handle.slice(0, 5).type).toBe('video/x-matroska');
  });
});
