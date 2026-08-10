import { describe, expect, it } from 'vitest';

import { Mutex } from '../src/mutex.ts';

const swallow = (): void => {};
const unset = (): void => {};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = unset;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('Mutex', () => {
  it('never runs two tasks at once', async () => {
    let running = 0;
    let peak = 0;
    const mutex = new Mutex();

    await Promise.all(
      Array.from({ length: 20 }, () =>
        mutex.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await Promise.resolve();
          running -= 1;
        }),
      ),
    );

    expect(peak).toBe(1);
  });

  it('runs them in the order they were queued', async () => {
    const order: number[] = [];
    const mutex = new Mutex();

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        mutex.run(async () => {
          // Later tasks resolve sooner if left unserialised.
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10 - index);
          });
          order.push(index);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('holds later tasks until an earlier one finishes', async () => {
    const mutex = new Mutex();
    const gate = deferred();
    const done: string[] = [];

    const first = mutex.run(async () => {
      await gate.promise;
      done.push('first');
    });
    const second = mutex.run(() => {
      done.push('second');
    });

    await Promise.resolve();
    expect(done).toEqual([]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(done).toEqual(['first', 'second']);
  });

  it('gives the caller its own task’s rejection', async () => {
    const mutex = new Mutex();
    const boom = new Error('write failed');

    await expect(mutex.run(() => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('keeps running after a task fails, rather than wedging the queue', async () => {
    // The failure mode this guards: swallowing the rejection into the tail
    // without isolating it leaves every later write chained onto a rejected
    // promise, and a download stops making progress with no error to show.
    const mutex = new Mutex();
    const done: string[] = [];

    const failed = mutex.run(() => Promise.reject(new Error('nope')));
    const after = mutex.run(() => {
      done.push('after');
    });

    await expect(failed).rejects.toThrow('nope');
    await after;
    expect(done).toEqual(['after']);
  });

  it('returns each task’s value', async () => {
    const mutex = new Mutex();

    const values = await Promise.all([mutex.run(() => 1), mutex.run(() => Promise.resolve(2))]);

    expect(values).toEqual([1, 2]);
  });

  it('leaves no unhandled rejection when a caller ignores a failure', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const mutex = new Mutex();
      mutex.run(() => Promise.reject(new Error('ignored'))).catch(swallow);
      await mutex.run(swallow);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });

      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
