import { describe, expect, it } from 'vitest';

import { openNzbFile } from '../src/handle.ts';
import { buildPost } from './post.ts';

/** A sink that does nothing with what it is given. */
const discard = (): void => {};

/** Four 100-byte segments and a 40-byte tail: 340 bytes over 4 articles. */
const SEGMENTS = [100, 100, 100, 40];

/** Assemble what a sink received into one buffer, as a real file would. */
function assemble(writes: readonly { offset: number; chunk: Uint8Array }[], size: number): Buffer {
  const out = Buffer.alloc(size);
  for (const write of writes) {
    Buffer.from(write.chunk).copy(out, write.offset);
  }
  return out;
}

describe('writeTo', () => {
  it('hands over every byte at its true offset', async () => {
    const post = buildPost({ segmentSizes: SEGMENTS });
    const handle = await openNzbFile(post.file, post.source);
    const writes: { offset: number; chunk: Uint8Array }[] = [];

    const total = await handle.writeTo((offset, chunk) => {
      writes.push({ offset, chunk });
    });

    expect(total).toBe(340);
    expect(assemble(writes, 340).equals(post.data)).toBe(true);
  });

  it('uses absolute offsets, so a slice lands in the right part of the file', async () => {
    // The reason offsets are file-absolute rather than window-relative: a
    // sparse tail fetch has to write at 200, not at 0.
    const post = buildPost({ segmentSizes: SEGMENTS });
    const handle = await openNzbFile(post.file, post.source);
    const writes: { offset: number; chunk: Uint8Array }[] = [];

    await handle.slice(200, 260).writeTo((offset, chunk) => {
      writes.push({ offset, chunk });
    });

    expect(Math.min(...writes.map((write) => write.offset))).toBe(200);
    const whole = assemble(writes, 340);
    expect(whole.subarray(200, 260).equals(post.data.subarray(200, 260))).toBe(true);
  });

  it('does not wait for order — a slow article does not hold up later ones', async () => {
    // The whole point. Segment 2 is slow; the articles behind it must be handed
    // over before it, not queued behind it.
    const post = buildPost({ segmentSizes: SEGMENTS });
    const slow = {
      body: async (id: string) => {
        const isSecond = id === post.file.segments[1]?.messageId;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, isSecond ? 50 : 1);
        });
        return post.source.body(id);
      },
    };
    const handle = await openNzbFile(post.file, slow, { prefetch: 4 });
    const order: number[] = [];

    await handle.writeTo((offset) => {
      order.push(offset);
    });

    // Segment 2 covers [100, 200); it is the slowest, so it must come out
    // last. Merely "not first" is satisfied by strict order too, and would let
    // an order-preserving implementation pass.
    expect(order.at(-1)).toBe(100);
    expect(order.toSorted((a, b) => a - b)).toEqual([0, 100, 200, 300]);
  });

  it('still produces the right bytes when the order is scrambled', async () => {
    const post = buildPost({ segmentSizes: SEGMENTS });
    const jittered = {
      body: async (id: string) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, (id.codePointAt(3) ?? 0) % 7);
        });
        return post.source.body(id);
      },
    };
    const handle = await openNzbFile(post.file, jittered, { prefetch: 4 });
    const writes: { offset: number; chunk: Uint8Array }[] = [];

    await handle.writeTo((offset, chunk) => {
      writes.push({ offset, chunk });
    });

    expect(assemble(writes, 340).equals(post.data)).toBe(true);
  });

  it('never calls the sink concurrently', async () => {
    // The contract that lets a sink skip its own locking.
    const post = buildPost({ segmentSizes: SEGMENTS });
    const handle = await openNzbFile(post.file, post.source, { prefetch: 4 });
    let inSink = 0;
    let peak = 0;

    await handle.writeTo(async () => {
      inSink += 1;
      peak = Math.max(peak, inSink);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2);
      });
      inSink -= 1;
    });

    expect(peak).toBe(1);
  });

  it('waits for a slow sink before finishing', async () => {
    const post = buildPost({ segmentSizes: SEGMENTS });
    const handle = await openNzbFile(post.file, post.source);
    let finished = 0;

    await handle.writeTo(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2);
      });
      finished += 1;
    });

    expect(finished).toBe(4);
  });

  it('hands the sink a copy, not a view into a retained article', async () => {
    // Segment 1's article is kept across reads. A sink that writes later, or
    // transforms in place, must not be able to corrupt it.
    const post = buildPost({ segmentSizes: SEGMENTS });
    const handle = await openNzbFile(post.file, post.source);

    await handle.writeTo((_offset, chunk) => {
      chunk.fill(0);
    });

    await expect(handle.slice(0, 10).bytes()).resolves.toEqual(
      new Uint8Array(post.data.subarray(0, 10)),
    );
  });

  it('writes nothing for an empty range', async () => {
    const post = buildPost({ segmentSizes: SEGMENTS });
    const handle = await openNzbFile(post.file, post.source);
    let calls = 0;

    const total = await handle.slice(0, 0).writeTo(() => {
      calls += 1;
    });

    expect(total).toBe(0);
    expect(calls).toBe(0);
  });

  it('propagates a fetch failure', async () => {
    const post = buildPost({ segmentSizes: SEGMENTS });
    const gone = post.file.segments[2]?.messageId;
    const flaky = {
      body: (id: string) =>
        id === gone ? Promise.reject(new Error('NNTP 430')) : post.source.body(id),
    };
    const handle = await openNzbFile(post.file, flaky);

    await expect(handle.writeTo(discard)).rejects.toThrow('NNTP 430');
  });

  it('propagates a sink failure', async () => {
    const post = buildPost({ segmentSizes: SEGMENTS });
    const handle = await openNzbFile(post.file, post.source);

    await expect(
      handle.writeTo(() => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
  });

  it('verifies placement before handing anything over', async () => {
    // The geometry check still gates every byte; going unordered must not
    // sneak past it.
    const post = buildPost({
      segmentSizes: SEGMENTS,
      declaredRanges: new Map([[2, [190, 290] as const]]),
    });
    const handle = await openNzbFile(post.file, post.source);

    await expect(handle.writeTo(discard)).rejects.toThrow(/segment 3/u);
  });
});
