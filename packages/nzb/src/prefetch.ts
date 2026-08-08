/**
 * A bounded, order-preserving prefetch window.
 *
 * Articles have to be emitted in file order, so the naive way to go faster —
 * `Promise.all` over the whole range — is wrong twice: it buffers the entire
 * read in memory, and on a 7.8 GiB file that is 7.8 GiB of RSS. What is wanted
 * is a sliding window: keep `depth` fetches in flight, hand results to the
 * consumer strictly in order, and start a new fetch only as an old one is
 * consumed.
 *
 * Backpressure falls out of being a generator. Nothing beyond the window is
 * started until the consumer pulls, so a slow disk throttles the network rather
 * than filling memory with articles waiting to be written.
 *
 * Results are awaited in order, so the error a caller sees is the first *in the
 * items*, not whichever request happened to fail soonest. Anything still in
 * flight when that happens is abandoned — its result is unreachable, and the
 * `ArticleSource` seam has no cancellation, so the best available is to let it
 * settle and be discarded.
 */
/** Marks a promise handled without doing anything with the rejection. */
const noop = (): void => {};

export async function* prefetch<T, R>(
  items: readonly T[],
  depth: number,
  work: (item: T, index: number) => Promise<R>,
): AsyncGenerator<R> {
  const window: Promise<R>[] = [];
  let next = 0;

  const start = (): void => {
    const item = items[next];
    if (item === undefined) {
      return;
    }

    const promise = work(item, next);
    next += 1;
    // A sink, so that a rejection nobody awaits -- because an earlier article
    // failed first and we stopped -- does not surface as an unhandled rejection
    // and take the process down. The original promise still rejects when
    // awaited below; this only marks it as handled.
    promise.catch(noop);
    window.push(promise);
  };

  for (let index = 0; index < Math.max(1, depth); index += 1) {
    start();
  }

  for (;;) {
    const head = window.shift();
    if (head === undefined) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- serialising results is the point
    const value = await head;

    // Refilled only once the head has resolved. Doing it before the await would
    // hold `depth + 1` articles at once, since the one being awaited is still
    // in flight and still occupying memory — which is exactly the bound this
    // function exists to keep.
    start();

    yield value;
  }
}
