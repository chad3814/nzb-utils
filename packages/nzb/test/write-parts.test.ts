import { describe, expect, it } from 'vitest';

import { writeParts } from '../src/write.ts';
import type { FilePart } from '../src/write.ts';

const unset = (): void => {};
const discard = (): void => {};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = unset;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A source of parts that records how many have been pulled from it. */
function counted(count: number): { parts: AsyncIterable<FilePart>; pulled: () => number } {
  let pulled = 0;
  async function* generate(): AsyncGenerator<FilePart> {
    for (let index = 0; index < count; index += 1) {
      pulled += 1;
      await Promise.resolve();
      yield { offset: index * 10, data: new Uint8Array(10).fill(index) };
    }
  }
  return { parts: generate(), pulled: () => pulled };
}

describe('writeParts', () => {
  it('holds at most two chunks when the sink is slower than the source', async () => {
    // Backpressure. Without it a fast source and a slow sink queue every chunk
    // of the range in memory — 7.8 GiB for a whole-file get — and the bound
    // that prevents it is invisible to every other test here, because they all
    // have sinks that keep up.
    const source = counted(50);
    const gate = deferred();
    let entered = 0;

    const done = writeParts(source.parts, async () => {
      entered += 1;
      await gate.promise;
    });

    // Let the source run as far ahead as it is allowed to.
    for (let tick = 0; tick < 100; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- draining the microtask queue
      await Promise.resolve();
    }

    // One write running, one queued behind it, and nothing else pulled.
    expect(entered).toBe(1);
    expect(source.pulled()).toBeLessThanOrEqual(2);

    gate.resolve();
    await done;
  });

  it('resumes pulling once the sink catches up', async () => {
    const source = counted(5);
    const written = await writeParts(source.parts, discard);

    expect(written).toBe(50);
    expect(source.pulled()).toBe(5);
  });

  it('waits for the last queued write before resolving', async () => {
    // The final `await pending`: the write queued on the last iteration has
    // nothing after it to await it, so dropping that line reports a byte count
    // for a write that has not landed.
    const source = counted(3);
    let finished = 0;

    await writeParts(source.parts, async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2);
      });
      finished += 1;
    });

    expect(finished).toBe(3);
  });
});
