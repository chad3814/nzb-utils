import { describe, expect, it } from 'vitest';

import { asCompleted } from '../src/prefetch.ts';

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

describe('asCompleted', () => {
  it('yields each result as soon as it is ready, not in order', async () => {
    // The point of the whole thing: a slow first item must not hold up the
    // ones behind it that have already arrived.
    const out = await collect(
      asCompleted(ITEMS, 8, async (item) => {
        await delay(item === 0 ? 40 : 1);
        return item;
      }),
    );

    expect(out.at(-1)).toBe(0);
    expect(out.toSorted((a, b) => a - b)).toEqual(ITEMS);
  });

  it('still yields every item exactly once', async () => {
    const out = await collect(asCompleted(ITEMS, 3, (item) => Promise.resolve(item)));

    expect(out.toSorted((a, b) => a - b)).toEqual(ITEMS);
  });

  it('keeps exactly `depth` requests in flight', async () => {
    const { work, release, live, started } = controllable();
    const iterator = asCompleted(ITEMS, 3, work);

    const first = iterator.next();
    expect(live()).toBe(3);
    expect(started).toEqual([0, 1, 2]);

    release(1);
    await first;
    expect(live()).toBe(3);
    expect(started).toEqual([0, 1, 2, 3]);

    for (const item of ITEMS) {
      release(item);
    }
    await collect(iterator);
  });

  it('refills the slot of whichever finished, not of the head', async () => {
    // With an ordered window, releasing item 2 while 0 and 1 are outstanding
    // starts nothing new. Here it does.
    const { work, release, started } = controllable();
    const iterator = asCompleted(ITEMS, 3, work);

    const first = iterator.next();
    release(2);
    await first;

    expect(started).toContain(3);
  });

  it('treats a depth below one as one', async () => {
    const out = await collect(asCompleted(ITEMS, 0, (item) => Promise.resolve(item)));

    expect(out.toSorted((a, b) => a - b)).toEqual(ITEMS);
  });

  it('yields nothing for no work', async () => {
    expect(await collect(asCompleted([], 4, () => Promise.resolve(1)))).toEqual([]);
  });

  it('propagates a failure', async () => {
    const boom = new Error('gone');

    await expect(
      collect(
        asCompleted(ITEMS, 4, (item) =>
          item === 2 ? Promise.reject(boom) : Promise.resolve(item),
        ),
      ),
    ).rejects.toBe(boom);
  });

  it('leaves no unhandled rejection when several fail', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      await collect(
        asCompleted(ITEMS, 8, (item) =>
          item >= 2 ? Promise.reject(new Error(`gone ${String(item)}`)) : Promise.resolve(item),
        ),
      ).catch(() => []);
      await delay(20);

      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
