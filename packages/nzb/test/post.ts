import { crc32 } from 'node:zlib';

import type { NzbFile, NzbSegment } from '@chad3814/nzb-parser';

import type { ArticleBody, ArticleSource } from '../src/models.ts';

/**
 * Synthetic Usenet posts for testing.
 *
 * Builds real yEnc articles and a real `NzbFile` around them, so a test can
 * assert on bytes rather than on a mock's call log. CRCs come from `node:zlib`
 * rather than from `@chad3814/yenc`, so a fixture cannot agree with a broken
 * decoder by construction.
 */

const LINE_LENGTH = 128;

function encodePayload(data: Uint8Array): Buffer {
  const out: number[] = [];
  let column = 0;

  for (const byte of data) {
    const value = (byte + 42) % 256;
    const escaped = value === 0x00 || value === 0x0a || value === 0x0d || value === 0x3d;

    if (column >= LINE_LENGTH) {
      out.push(0x0d, 0x0a);
      column = 0;
    }
    if (escaped) {
      out.push(0x3d, (value + 64) % 256);
      column += 2;
    } else {
      out.push(value);
      column += 1;
    }
  }

  return Buffer.from(out);
}

/** A `[begin, end)` range as it should appear on the wire, or null for no `=ypart`. */
export type WireRange = readonly [number, number] | null;

export interface PostOptions {
  /** Authoritative filename, as it appears in `=ybegin name=`. */
  readonly name?: string;
  /** Decoded bytes per segment. Length is the segment count. */
  readonly segmentSizes: readonly number[];
  readonly date?: Date;
  /**
   * Override the `=ybegin size=` each article declares. Defaults to the real
   * total. Used to build the posts where the declared size and the segment
   * layout disagree.
   */
  readonly declaredTotalSize?: number;
  /**
   * Override the `=ypart` range of individual articles, keyed by 0-based index.
   * A `null` entry omits the `=ypart` line entirely. Used to build the posts
   * where an article is not where the geometry predicts.
   */
  readonly declaredRanges?: ReadonlyMap<number, WireRange>;
  /** Override the `=ybegin name=` of individual articles, keyed by 0-based index. */
  readonly declaredNames?: ReadonlyMap<number, string>;
  /** Override the `=ybegin size=` of individual articles, keyed by 0-based index. */
  readonly declaredSizes?: ReadonlyMap<number, number>;
  /** Corrupt the payload of individual articles, keyed by 0-based index. */
  readonly corrupt?: ReadonlySet<number>;
}

export interface Post {
  readonly file: NzbFile;
  readonly source: RecordingArticleSource;
  /** The complete decoded file the articles reassemble into. */
  readonly data: Buffer;
}

/** An `ArticleSource` that serves a fixed set of articles and records requests. */
export class RecordingArticleSource implements ArticleSource {
  readonly #articles: ReadonlyMap<string, Buffer>;
  readonly #requested: string[] = [];

  constructor(articles: ReadonlyMap<string, Buffer>) {
    this.#articles = articles;
  }

  /** Message-IDs requested so far, in order, including repeats. */
  get requested(): readonly string[] {
    return this.#requested;
  }

  get requestCount(): number {
    return this.#requested.length;
  }

  body(messageId: string): Promise<ArticleBody> {
    this.#requested.push(messageId);
    const article = this.#articles.get(messageId);
    if (article === undefined) {
      return Promise.reject(new Error(`no such article: ${messageId}`));
    }
    return Promise.resolve({ body: article });
  }
}

/** Deterministic pseudo-random bytes, so a wrong offset produces a wrong byte. */
function fill(size: number): Buffer {
  const data = Buffer.alloc(size);
  let state = 0x2545_f491;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    data[index] = (state >>> 16) & 0xff;
  }
  return data;
}

export function buildPost(options: PostOptions): Post {
  const name = options.name ?? 'payload.bin';
  const date = options.date ?? new Date('2026-01-02T03:04:05.000Z');
  const total = options.segmentSizes.reduce((sum, size) => sum + size, 0);
  const data = fill(total);
  const declaredTotal = options.declaredTotalSize ?? total;
  const multipart = options.segmentSizes.length > 1;

  const articles = new Map<string, Buffer>();
  const segments: NzbSegment[] = [];
  let offset = 0;

  for (const [index, size] of options.segmentSizes.entries()) {
    const payload = data.subarray(offset, offset + size);
    const wire: WireRange = options.declaredRanges?.has(index)
      ? (options.declaredRanges.get(index) ?? null)
      : multipart
        ? [offset, offset + size]
        : null;

    const article = buildArticle({
      name: options.declaredNames?.get(index) ?? name,
      declaredTotal: options.declaredSizes?.get(index) ?? declaredTotal,
      part: multipart ? index + 1 : null,
      partCount: options.segmentSizes.length,
      payload: options.corrupt?.has(index) ? corrupted(payload) : payload,
      // The trailer always describes the bytes as posted, so a corrupted
      // article is one whose own checksum no longer matches -- which is what
      // an article damaged in transit looks like.
      checksumOver: payload,
      wire,
    });

    const messageId = `seg${index + 1}.${name}@fixture.invalid`;
    articles.set(messageId, article);
    segments.push({ number: index + 1, bytes: article.length, messageId });
    offset += size;
  }

  const file: NzbFile = {
    poster: 'fixture <fixture@example.invalid>',
    date,
    subject: `Fixture [1/1] - "${name}" yEnc (1/${String(options.segmentSizes.length)})`,
    groups: ['alt.binaries.test'],
    segments,
    subjectHints: {
      name,
      part: 1,
      totalParts: options.segmentSizes.length,
      declaredSize: null,
    },
    totalEncodedBytes: segments.reduce((sum, segment) => sum + segment.bytes, 0),
    contiguous: true,
  };

  return { file, source: new RecordingArticleSource(articles), data };
}

function corrupted(payload: Buffer): Buffer {
  const copy = Buffer.from(payload);
  const first = copy[0];
  if (first !== undefined) {
    copy[0] = first ^ 0xff;
  }
  return copy;
}

interface ArticleOptions {
  readonly name: string;
  readonly declaredTotal: number;
  readonly part: number | null;
  readonly partCount: number;
  readonly payload: Buffer;
  /** Bytes the trailer's CRC32 covers. Differs from `payload` only for a corrupt article. */
  readonly checksumOver: Buffer;
  readonly wire: WireRange;
}

function buildArticle(options: ArticleOptions): Buffer {
  const { name, declaredTotal, part, partCount, payload, wire } = options;
  const checksum = crc32(options.checksumOver).toString(16).padStart(8, '0');

  const lines: string[] = [
    part === null
      ? `=ybegin line=${String(LINE_LENGTH)} size=${String(declaredTotal)} name=${name}`
      : `=ybegin part=${String(part)} total=${String(partCount)} line=${String(LINE_LENGTH)} size=${String(declaredTotal)} name=${name}`,
  ];

  if (wire !== null) {
    // The wire format is 1-based and inclusive; the fixture takes half-open.
    lines.push(`=ypart begin=${String(wire[0] + 1)} end=${String(wire[1])}`);
  }

  const trailer =
    part === null
      ? `=yend size=${String(payload.length)} crc32=${checksum}`
      : `=yend size=${String(payload.length)} part=${String(part)} pcrc32=${checksum}`;

  return Buffer.concat([
    Buffer.from(`${lines.join('\r\n')}\r\n`, 'latin1'),
    encodePayload(payload),
    Buffer.from(`\r\n${trailer}\r\n`, 'latin1'),
  ]);
}
