import { Mutex } from './mutex.ts';
import type { ByteSink } from './models.ts';

/** A run of decoded bytes and where in the file it belongs. */
export interface FilePart {
  /** Absolute offset within the whole file. */
  readonly offset: number;
  readonly data: Uint8Array;
}

/** Marks a rejection as handled without acting on it. */
const ignore = (): void => {};

/**
 * Hand each part to `sink` at its offset, as the parts arrive.
 *
 * Parts may arrive in any order — that is the point of writing at offsets — but
 * `sink` is never entered twice at once, so an implementation needs no locking
 * of its own.
 *
 * @returns how many bytes were handed over.
 */
export async function writeParts(parts: AsyncIterable<FilePart>, sink: ByteSink): Promise<number> {
  const lock = new Mutex();
  let written = 0;

  // One write may be running while the next is queued behind it, so a sink that
  // takes a moment does not stall the fetches feeding it. Awaiting the previous
  // one before queueing another is the backpressure: at most two chunks are
  // held, however far the network runs ahead of the disk.
  let pending: Promise<void> = Promise.resolve();

  for await (const part of parts) {
    // Copied before queueing: the view aliases a decoded article, and segment
    // 1's article is retained across reads, so handing the view to a sink that
    // writes later would let it observe — or corrupt — shared bytes.
    const chunk = new Uint8Array(part.data);
    const { offset } = part;
    written += chunk.byteLength;

    const queued = lock.run(() => sink(offset, chunk));
    // Handled here as well as through `pending`, so that a failure arriving
    // while an earlier write is still being awaited is not reported as an
    // unhandled rejection before we get to it.
    queued.catch(ignore);
    // oxlint-disable-next-line no-await-in-loop -- awaiting it *is* the queue depth
    await pending;
    pending = queued;
  }
  await pending;

  return written;
}
