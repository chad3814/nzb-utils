import { describe, expect, it } from 'vitest';

import { openNzbFile } from '../src/handle.ts';
import { buildPost } from './post.ts';

/**
 * Split out of handle.test.ts once `reading` pushed that file past the
 * repo's 300-line cap, the same way multi-pool-failures.test.ts split out of
 * multi-pool.test.ts in @chad3814/nntp. handle.test.ts covers opening a
 * handle and narrowing it with slice() -- neither does any I/O; everything
 * here pulls bytes through an already-open handle, which is the seam. Setup
 * is duplicated rather than shared, matching that precedent.
 */

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

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return Buffer.concat(chunks);
    }
    chunks.push(next.value);
  }
}

describe('reading', () => {
  it('reassembles the whole file byte for byte', async () => {
    const { handle, post } = await open();

    await expect(handle.bytes()).resolves.toEqual(new Uint8Array(post.data));
  });

  it('fetches only the segments a range overlaps', async () => {
    const { handle, post } = await open();

    await handle.slice(205, 215).bytes();

    expect(post.source.requested).toEqual([
      post.file.segments[0]?.messageId,
      post.file.segments[2]?.messageId,
    ]);
  });

  it('fetches both segments a range straddles, and no more', async () => {
    const { handle, post } = await open();

    await handle.slice(95, 105).bytes();

    // Segment 1 appears once: the probe's fetch, reused rather than repeated.
    expect(post.source.requested).toEqual([
      post.file.segments[0]?.messageId,
      post.file.segments[1]?.messageId,
    ]);
  });

  it('does not re-fetch segment 1, which opening already paid for', async () => {
    const { handle, post } = await open();

    await handle.slice(0, 10).bytes();

    expect(post.source.requested).toEqual([post.file.segments[0]?.messageId]);
  });

  it('reads the tail without touching any earlier article', async () => {
    // The point of the whole package: a preview of the end of a 7.9 GiB
    // release is one article, not 1868.
    const { handle, post } = await open();

    const tail = await handle.slice(-4).bytes();

    expect(tail).toEqual(new Uint8Array(post.data.subarray(336, 340)));
    expect(post.source.requested.slice(1)).toEqual([post.file.segments[3]?.messageId]);
  });

  it('matches a plain subarray for every sub-range', async () => {
    for (let start = 0; start <= 340; start += 17) {
      for (let end = start; end <= 340; end += 23) {
        const post = buildPost({ segmentSizes: SEGMENTS });
        const handle = await openNzbFile(post.file, post.source);

        const actual = await handle.slice(start, end).bytes();

        expect(
          Buffer.from(actual).equals(post.data.subarray(start, end)),
          `[${start}, ${end})`,
        ).toBe(true);
      }
    }
  });

  it('returns an ArrayBuffer sized to the slice, not to the segments behind it', async () => {
    // Handing back the underlying article buffer would expose neighbouring
    // bytes through .buffer and quietly retain the whole article.
    const { handle } = await open();

    const buffer = await handle.slice(95, 105).arrayBuffer();

    expect(buffer.byteLength).toBe(10);
  });

  it('decodes text', async () => {
    const post = buildPost({ segmentSizes: [16] });
    const handle = await openNzbFile(post.file, post.source);

    await expect(handle.text()).resolves.toBe(post.data.toString('utf8'));
  });

  it('streams the same bytes', async () => {
    const { handle, post } = await open();

    const streamed = await drain(handle.stream());

    expect(streamed.equals(post.data)).toBe(true);
  });

  it('yields the same bytes by async iteration', async () => {
    const { handle, post } = await open();

    expect((await collect(handle)).equals(post.data)).toBe(true);
  });

  it('yields one chunk per article, so a caller can consume as they arrive', async () => {
    const { handle } = await open();
    const chunks: number[] = [];

    for await (const chunk of handle.slice(50, 250)) {
      chunks.push(chunk.byteLength);
    }

    expect(chunks).toEqual([50, 100, 50]);
  });

  it('yields chunks that do not alias the article behind them', async () => {
    // Segment 1 is retained across reads, so handing out a view into it lets a
    // consumer that writes to a chunk -- decrypting or unpacking in place --
    // silently corrupt every later read of the same article.
    const { handle, post } = await open();

    for await (const chunk of handle.slice(0, 10)) {
      chunk.fill(0);
    }

    await expect(handle.slice(0, 10).bytes()).resolves.toEqual(
      new Uint8Array(post.data.subarray(0, 10)),
    );
  });

  it('yields nothing for an empty range', async () => {
    const { handle } = await open();
    const chunks: Uint8Array[] = [];

    for await (const chunk of handle.slice(10, 10)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
  });

  it('reads a single-part file, which has no =ypart line', async () => {
    const post = buildPost({ name: 'readme.nfo', segmentSizes: [37] });
    const handle = await openNzbFile(post.file, post.source);

    await expect(handle.slice(10, 20).bytes()).resolves.toEqual(
      new Uint8Array(post.data.subarray(10, 20)),
    );
  });
});
