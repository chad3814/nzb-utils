/**
 * Run tasks one at a time, in the order they were handed over.
 *
 * Used to serialise writes to a file. Two positional writes at different
 * offsets are `pwrite` calls and do not share a seek pointer, so they are safe
 * in principle — but Node documents that using `write()` repeatedly on one
 * handle without awaiting is unsafe, and that is not a guarantee worth
 * relying on the fine print of when the cost of a lock is nil. Fetching an
 * article takes tens of milliseconds; writing it takes microseconds, so
 * serialising the writes costs nothing measurable and removes the question.
 *
 * It does not serialise the *fetching*, which is the whole point: articles
 * arrive concurrently and out of order, and only the handover is queued.
 */
export class Mutex {
  /** The tail of the queue: whatever must finish before the next task starts. */
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    // `task` is passed as both handlers, so a failed task does not wedge the
    // queue behind it *and* its rejection is always handled — which is why the
    // tail needs no `catch` of its own. A caller that ignores the promise `run`
    // returns still sees its own unhandled rejection, as it should.
    const result = this.#tail.then(task, task);
    this.#tail = result;
    return result;
  }
}
