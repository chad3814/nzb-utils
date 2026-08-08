import { describe, expect, it } from 'vitest';

import { openNzbFile } from '../src/handle.ts';
import { buildPost } from './post.ts';

/** Four 100-byte segments and a 40-byte tail: 340 bytes over 4 articles. */
const SEGMENTS = [100, 100, 100, 40];

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Records how many fetches overlap, without gating them into a deadlock. */
function counting(post: ReturnType<typeof buildPost>): {
  source: { body: (id: string) => Promise<{ body: Buffer }> };
  peak: () => number;
} {
  let inFlight = 0;
  let peak = 0;

  return {
    peak: () => peak,
    source: {
      body: async (id: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
        inFlight -= 1;
        return post.source.body(id);
      },
    },
  };
}

describe('prefetching', () => {
  it('overlaps article fetches instead of waiting for each in turn', async () => {
    // Three articles remain after the probe, and all three should be in flight
    // at once rather than one after another.
    const post = buildPost({ segmentSizes: SEGMENTS });
    const gate = counting(post);
    const handle = await openNzbFile(post.file, gate.source, { prefetch: 3 });

    await handle.bytes();

    expect(gate.peak()).toBe(3);
  });

  it('never exceeds the window, so memory stays bounded', async () => {
    // The bound is what makes this safe on a 7.3 GiB file: the cost is prefetch
    // times the segment size, not the size of the range.
    const post = buildPost({ segmentSizes: SEGMENTS });
    const gate = counting(post);
    const handle = await openNzbFile(post.file, gate.source, { prefetch: 2 });

    await handle.bytes();

    expect(gate.peak()).toBe(2);
  });

  it('is sequential when the window is one', async () => {
    const post = buildPost({ segmentSizes: SEGMENTS });
    const gate = counting(post);
    const handle = await openNzbFile(post.file, gate.source, { prefetch: 1 });

    await handle.bytes();

    expect(gate.peak()).toBe(1);
  });

  it('still yields bytes in file order', async () => {
    const post = buildPost({ segmentSizes: SEGMENTS });
    const handle = await openNzbFile(post.file, post.source, { prefetch: 4 });

    await expect(handle.bytes()).resolves.toEqual(new Uint8Array(post.data));
  });

  it('still yields chunks in order when streamed', async () => {
    const post = buildPost({ segmentSizes: SEGMENTS });
    const handle = await openNzbFile(post.file, post.source, { prefetch: 4 });

    expect((await collect(handle)).equals(post.data)).toBe(true);
  });

  it('fetches no more articles than the range needs, however deep the window', async () => {
    // Prefetch must not read ahead past the end of the requested range: on a
    // 4 MiB preview of a 7.3 GiB file that would turn 1 article into 5.
    const post = buildPost({ segmentSizes: SEGMENTS });
    const handle = await openNzbFile(post.file, post.source, { prefetch: 8 });

    await handle.slice(0, 10).bytes();

    expect(post.source.requested).toEqual([post.file.segments[0]?.messageId]);
  });

  it('reports the first failure in file order, not the first to fail', async () => {
    // With several requests in flight, a later article can fail sooner. The
    // caller must be told where the file actually stops being readable.
    const post = buildPost({
      segmentSizes: SEGMENTS,
      declaredRanges: new Map([[1, [190, 290] as const]]),
    });
    const handle = await openNzbFile(post.file, post.source, { prefetch: 4 });

    await expect(handle.bytes()).rejects.toThrow(/segment 2/u);
  });
});
