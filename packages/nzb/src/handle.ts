import { decodeArticle } from '@chad3814/yenc';
import type { YencArticle } from '@chad3814/yenc';
import type { NzbFile } from '@chad3814/nzb-parser';

import { NzbGeometryError } from './errors.ts';
import { probeGeometry, verifyPlacement } from './geometry.ts';
import type { FileHeader } from './geometry.ts';
import { mimeTypeFor } from './mime.ts';
import { normalizeSlice, resolveRange } from './range.ts';
import type {
  ArticleSource,
  ByteRange,
  NzbFileHandle,
  SegmentGeometry,
  SegmentSlice,
} from './models.ts';

export interface OpenNzbFileOptions {
  /**
   * Verify each article against the CRC32 in its own `=yend` trailer.
   * Defaults to true — the check costs nothing next to the fetch, and it is the
   * only integrity guarantee available without PAR2. Set false only for posts
   * with trailers known to be wrong.
   */
  readonly verify?: boolean;
  /** Override the MIME type inferred from the yEnc filename. */
  readonly type?: string;
}

/**
 * Open one file inside an NZB as a `File`-like handle.
 *
 * Costs exactly one article: segment 1, which carries the authoritative
 * filename and total size the NZB does not have, and which pins down the
 * segment layout for {@link probeGeometry} to predict from. That article is
 * kept, so a head read — the common case — costs nothing further.
 */
export async function openNzbFile(
  file: NzbFile,
  source: ArticleSource,
  options: OpenNzbFileOptions = {},
): Promise<NzbFileHandle> {
  const verify = options.verify ?? true;
  const probe = await probeGeometry(file, source, { verify });

  const context: HandleContext = {
    file,
    source,
    verify,
    geometry: probe.geometry,
    header: { name: probe.name, size: probe.geometry.totalSize },
    lastModified: file.date.getTime(),
    first: probe.first,
  };

  return new Handle(
    context,
    { start: 0, end: probe.geometry.totalSize },
    options.type ?? mimeTypeFor(probe.name),
  );
}

/** State every handle derived from one file shares, including its slices. */
interface HandleContext {
  readonly file: NzbFile;
  readonly source: ArticleSource;
  readonly verify: boolean;
  readonly geometry: SegmentGeometry;
  readonly header: FileHeader;
  readonly lastModified: number;
  /** Segment 1, decoded during the probe and retained rather than re-fetched. */
  readonly first: YencArticle;
}

class Handle implements NzbFileHandle {
  readonly #context: HandleContext;
  /** Absolute byte range within the whole file, never within the parent slice. */
  readonly #window: ByteRange;
  readonly #type: string;

  constructor(context: HandleContext, window: ByteRange, type: string) {
    this.#context = context;
    this.#window = window;
    this.#type = type;
  }

  get name(): string {
    return this.#context.header.name;
  }

  get size(): number {
    return this.#window.end - this.#window.start;
  }

  get type(): string {
    return this.#type;
  }

  get lastModified(): number {
    return this.#context.lastModified;
  }

  get geometry(): SegmentGeometry {
    return this.#context.geometry;
  }

  get source(): NzbFile {
    return this.#context.file;
  }

  /**
   * Narrow the window. Performs no I/O.
   *
   * Bounds are resolved against **this** handle's size, then translated into
   * the file's coordinates, so a nested slice can only ever shrink. The
   * reference implementation resolves against the original file instead, which
   * lets a sub-slice read past the range it was derived from.
   */
  slice(start?: number, end?: number, contentType?: string): NzbFileHandle {
    const local = normalizeSlice(this.size, start, end);

    return new Handle(
      this.#context,
      { start: this.#window.start + local.start, end: this.#window.start + local.end },
      contentType ?? this.#type,
    );
  }

  async bytes(): Promise<Uint8Array> {
    const { segments } = this.#resolve();
    const out = new Uint8Array(this.size);
    await this.#fill(out, segments);
    return out;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    // Filled through a view rather than copied out of `bytes()`, so a
    // multi-gigabyte range is allocated once instead of twice.
    const { segments } = this.#resolve();
    const buffer = new ArrayBuffer(this.size);
    await this.#fill(new Uint8Array(buffer), segments);
    return buffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }

  stream(): ReadableStream<Uint8Array> {
    const chunks = this[Symbol.asyncIterator]();

    return new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        const next = await chunks.next();
        if (next.done === true) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      },
      async cancel(reason: unknown): Promise<void> {
        await chunks.return?.(reason);
      },
    });
  }

  /** One chunk per article, so a consumer can start work before the range ends. */
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    const { segments } = this.#resolve();

    for await (const part of this.#parts(segments)) {
      // Copied, because the underlying article is retained across reads when it
      // is segment 1 and a handed-out view would alias it.
      yield new Uint8Array(part);
    }
  }

  #resolve(): { readonly segments: readonly SegmentSlice[] } {
    return resolveRange(this.#context.geometry, this.#window);
  }

  /** Uncopied views into decoded articles. Internal: callers must not retain them. */
  async *#parts(segments: readonly SegmentSlice[]): AsyncGenerator<Uint8Array> {
    for (const slice of segments) {
      // Sequential on purpose. Articles must be yielded in file order, so
      // fetching them together would mean buffering the whole range in memory
      // -- exactly what stream() exists to avoid. Parallelism belongs one layer
      // down, in the pool, or in a future prefetch window with a bounded depth.
      // oxlint-disable-next-line no-await-in-loop
      const article = await this.#articleFor(slice.number);
      yield article.data.subarray(slice.offsetInSegment, slice.offsetInSegment + slice.byteLength);
    }
  }

  async #fill(out: Uint8Array, segments: readonly SegmentSlice[]): Promise<void> {
    let offset = 0;
    for await (const part of this.#parts(segments)) {
      out.set(part, offset);
      offset += part.byteLength;
    }
  }

  /**
   * Fetch and decode one segment, then confirm it is where the geometry said.
   *
   * Verification happens here rather than at the call sites so that no path can
   * copy bytes out of an unchecked article — that omission is the whole bug.
   */
  async #articleFor(number: number): Promise<YencArticle> {
    const context = this.#context;
    const segment = context.file.segments[number - 1];
    if (segment === undefined) {
      throw new NzbGeometryError(
        `the file has no segment ${String(number)}, but its geometry says it should`,
      );
    }

    const article =
      number === 1
        ? context.first
        : decodeArticle((await context.source.body(segment.messageId)).body, {
            verify: context.verify,
          });

    verifyPlacement(article, number, context.geometry, context.header);
    return article;
  }
}
