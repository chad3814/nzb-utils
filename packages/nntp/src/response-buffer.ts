const CR = 0x0d;
const LF = 0x0a;
const DOT = 0x2e;

/** `.` followed by CRLF — the multi-line terminator, when it starts a line. */
const TERMINATOR = Buffer.from([DOT, CR, LF]);
const CRLF = Buffer.from([CR, LF]);

/**
 * Incremental parser for NNTP wire responses.
 *
 * Synchronous and socket-free on purpose: framing a line-oriented protocol with
 * dot-stuffed multi-line blocks is where the subtle bugs live, so it is kept as
 * a pure function of the bytes fed in and tested without a network.
 *
 * Two invariants this owns:
 *
 * 1. **Dot-unstuffing.** A body line beginning with `.` was transmitted with an
 *    extra one. Blocks handed out here have already had it removed. yEnc
 *    decoders do not do this — `@thaunknown/yencode` calls its decoder with
 *    `stripDots = false` — so skipping it corrupts roughly one article in a few
 *    hundred.
 * 2. **Bytes, not text.** Block payloads stay `Buffer` end to end. Only status
 *    lines become strings, and as `latin1`, the one encoding that round-trips
 *    every byte value.
 */
export class ResponseBuffer {
  #buffer: Buffer = Buffer.alloc(0);

  /**
   * How far {@link takeBlock} has already searched for a terminator, so a block
   * arriving in many chunks costs one pass overall rather than one per chunk.
   */
  #searched = 0;

  push(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
  }

  /** Bytes received but not yet consumed. */
  get pending(): number {
    return this.#buffer.length;
  }

  /** @returns The next CRLF-terminated line without its terminator, or null. */
  takeLine(): string | null {
    const end = this.#buffer.indexOf(CRLF);
    if (end < 0) {
      return null;
    }

    const line = this.#buffer.subarray(0, end).toString('latin1');
    this.#consume(end + CRLF.length);
    return line;
  }

  /**
   * @returns The block's payload with dot-stuffing removed and the terminating
   *   `.` line excluded, or null if the terminator has not arrived yet. An
   *   empty block is a zero-length buffer, which is not the same as null.
   */
  takeBlock(): Buffer | null {
    const terminator = this.#findTerminator();
    if (terminator < 0) {
      return null;
    }

    const raw = this.#buffer.subarray(0, terminator);
    this.#consume(terminator + TERMINATOR.length);
    this.#searched = 0;
    return unstuff(raw);
  }

  /**
   * Locate a `.` line, i.e. `.\r\n` at the very start or immediately after a
   * CRLF. Requiring the line start is what stops a `.` inside binary payload
   * from truncating an article.
   */
  #findTerminator(): number {
    let index = this.#searched;

    for (;;) {
      const found = this.#buffer.indexOf(TERMINATOR, index);
      if (found < 0) {
        // A terminator can straddle chunks, so retain the last two bytes as
        // possible lead-in on the next pass.
        this.#searched = Math.max(0, this.#buffer.length - TERMINATOR.length);
        return -1;
      }

      if (found === 0 || (this.#buffer[found - 1] === LF && this.#buffer[found - 2] === CR)) {
        return found;
      }

      index = found + 1;
    }
  }

  #consume(count: number): void {
    this.#buffer = this.#buffer.subarray(count);
    this.#searched = 0;
  }
}

/**
 * Remove one leading `.` from every line that has one.
 *
 * RFC 3977 §3.1.1 stuffs any line whose first character is `.`, so unstuffing
 * strips the first character rather than looking specifically for `..`.
 */
function unstuff(raw: Buffer): Buffer {
  if (!startsStuffedLine(raw)) {
    return raw;
  }

  const out = Buffer.allocUnsafe(raw.length);
  let length = 0;
  let start = 0;

  while (start < raw.length) {
    let end = raw.indexOf(CRLF, start);
    if (end < 0) {
      end = raw.length;
    }

    const from = raw[start] === DOT ? start + 1 : start;
    const copied = raw.copy(out, length, from, Math.min(end + CRLF.length, raw.length));
    length += copied;
    start = end + CRLF.length;
  }

  return out.subarray(0, length);
}

/** Cheap check so the common unstuffed block is returned without copying. */
function startsStuffedLine(raw: Buffer): boolean {
  if (raw[0] === DOT) {
    return true;
  }

  let index = raw.indexOf(CRLF);
  while (index >= 0) {
    if (raw[index + CRLF.length] === DOT) {
      return true;
    }
    index = raw.indexOf(CRLF, index + CRLF.length);
  }

  return false;
}
