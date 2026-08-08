import { describe, expect, it } from 'vitest';

import { prefetch } from '../src/prefetch.ts';

/** A worker whose completions can be released in any order the test likes. */
function controllable(): {
  work: (item: number) => Promise<number>;
  release: (item: number) => void;
  started: number[];
  live: () => number;
} {
  const pending = new Map<number, () => void>();
  // Items released before they were started. Without this, draining at the end
  // of a test releases work that has not begun, and the release is lost -- the
  // generator then waits forever on a promise nobody will ever resolve.
  const releasedEarly = new Set<number>();
  const started: number[] = [];
  let live = 0;

  return {
    started,
    live: () => live,
    release: (item: number): void => {
      const resolve = pending.get(item);
      if (resolve === undefined) {
        releasedEarly.add(item);
        return;
      }
      pending.delete(item);
      resolve();
    },
    work: (item: number): Promise<number> => {
      started.push(item);
      live += 1;

      if (releasedEarly.delete(item)) {
        live -= 1;
        return Promise.resolve(item);
      }

      return new Promise<number>((resolve) => {
        pending.set(item, () => {
          live -= 1;
          resolve(item);
        });
      });
    },
  };
}

async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of source) {
    out.push(value);
  }
  return out;
}

/** A timer that does not trip the no-return-in-executor rule. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const ITEMS = [0, 1, 2, 3, 4, 5, 6, 7];

describe('prefetch', () => {
  it('yields in order however the work completes', async () => {
    // The whole point: articles must reach the caller in file order even though
    // a later request may well finish first.
    const out = await collect(
      prefetch(ITEMS, 4, async (item) => {
        // Reverse the natural completion order.
        await delay((8 - item) % 4);
        return item;
      }),
    );

    expect(out).toEqual(ITEMS);
  });

  it('keeps exactly `depth` requests in flight', async () => {
    const { work, release, live, started } = controllable();
    const iterator = prefetch(ITEMS, 3, work);

    const first = iterator.next();
    expect(live()).toBe(3);
    expect(started).toEqual([0, 1, 2]);

    release(0);
    await first;
    // One consumed, one started: still three.
    expect(live()).toBe(3);
    expect(started).toEqual([0, 1, 2, 3]);

    for (const item of ITEMS) {
      release(item);
    }
    await collect(iterator);
  });

  it('never starts more than the window even when the consumer is slow', async () => {
    // Backpressure: a consumer writing to disk must throttle the network, not
    // accumulate articles in memory while it catches up.
    let live = 0;
    let peak = 0;

    const out = await collect(
      prefetch(ITEMS, 2, async (item) => {
        live += 1;
        peak = Math.max(peak, live);
        await Promise.resolve();
        live -= 1;
        return item;
      }),
    );

    // Consume slowly.
    expect(out).toEqual(ITEMS);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('is sequential at depth 1', async () => {
    const { work, release, live, started } = controllable();
    const iterator = prefetch(ITEMS, 1, work);

    const first = iterator.next();
    expect(live()).toBe(1);
    expect(started).toEqual([0]);

    release(0);
    await first;
    expect(started).toEqual([0, 1]);

    for (const item of ITEMS) {
      release(item);
    }
    await collect(iterator);
  });

  it('treats a depth below one as one, rather than stalling forever', async () => {
    const out = await collect(prefetch(ITEMS, 0, (item) => Promise.resolve(item)));

    expect(out).toEqual(ITEMS);
  });

  it('handles a window larger than the work', async () => {
    const out = await collect(prefetch([1, 2], 99, (item) => Promise.resolve(item)));

    expect(out).toEqual([1, 2]);
  });

  it('yields nothing for no work, and starts nothing', async () => {
    const { work, started } = controllable();

    expect(await collect(prefetch([], 4, work))).toEqual([]);
    expect(started).toEqual([]);
  });

  it('reports the first failure in file order, not the first to reject', async () => {
    // Item 5 fails immediately and item 2 fails later. The caller must be told
    // about 2, because that is where the file actually stops being readable.
    const failure = new Error('article 2 is gone');

    const error = await collect(
      prefetch(ITEMS, 8, async (item) => {
        if (item === 5) {
          throw new Error('article 5 is gone');
        }
        if (item === 2) {
          await delay(5);
          throw failure;
        }
        return item;
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBe(failure);
  });

  it('yields everything before the failure', async () => {
    const out: number[] = [];

    await collect(
      prefetch(ITEMS, 4, (item) => {
        if (item === 3) {
          return Promise.reject(new Error('gone'));
        }
        out.push(item);
        return Promise.resolve(item);
      }),
    ).catch(() => []);

    expect(out.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it('leaves no unhandled rejection when a later request also fails', async () => {
    // Every in-flight promise is abandoned when an earlier one throws. Without
    // a sink on each, those rejections surface as unhandled and can take the
    // process down well after the error was handled.
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      await collect(
        prefetch(ITEMS, 8, (item) =>
          item >= 2 ? Promise.reject(new Error(`gone ${String(item)}`)) : Promise.resolve(item),
        ),
      ).catch(() => []);

      // Unhandled rejections are reported on a later turn of the loop.
      await delay(20);

      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('starts nothing further once the consumer stops early', async () => {
    const { work, release, started } = controllable();
    const iterator = prefetch(ITEMS, 2, work);

    const first = iterator.next();
    release(0);
    await first;

    await iterator.return(undefined as never);
    const after = [...started];
    release(1);
    release(2);
    await delay(5);

    expect(started).toEqual(after);
  });

  it('passes the index alongside the item', async () => {
    const indices: number[] = [];

    await collect(
      prefetch(['a', 'b', 'c'], 2, (item, index) => {
        indices.push(index);
        return Promise.resolve(item);
      }),
    );

    expect(indices).toEqual([0, 1, 2]);
  });
});
