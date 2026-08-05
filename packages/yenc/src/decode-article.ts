import { crc32 } from './crc32.ts';
import { decodeBytes } from './decode-bytes.ts';
import { YencChecksumError, YencDecodeError } from './errors.ts';
import type {
  DecodeArticleOptions,
  YencArticle,
  YencChecksum,
  YencHeader,
  YencPartRange,
  YencTrailer,
} from './models.ts';

const BEGIN = '=ybegin';
const PART = '=ypart';
const END = '=yend';

/**
 * Decode a complete yEnc article: `=ybegin`, optional `=ypart`, payload, `=yend`.
 *
 * Expects the article body as delivered by NNTP with dot-stuffing **already
 * removed** — see `@chad3814/nntp`, which owns that invariant.
 */
export function decodeArticle(raw: Uint8Array, options: DecodeArticleOptions = {}): YencArticle {
  // yEnc is 8-bit binary, so the payload must never be decoded as text. Only
  // the control lines are read as characters, and latin1 is the one encoding
  // that round-trips every byte value.
  const text = Buffer.from(raw).toString('latin1');
  const lines = splitLines(text);

  const beginIndex = lines.findIndex((line) => line.text.startsWith(BEGIN));
  if (beginIndex < 0) {
    throw new YencDecodeError('article has no =ybegin line');
  }

  const endIndex = lines.findIndex((line) => line.text.startsWith(END));
  if (endIndex < 0) {
    throw new YencDecodeError('article has no =yend line');
  }

  const beginLine = lines[beginIndex];
  const endLine = lines[endIndex];
  if (beginLine === undefined || endLine === undefined) {
    throw new YencDecodeError('article has no =ybegin line');
  }

  const header = parseHeader(beginLine.text);

  const partLine = lines[beginIndex + 1];
  const hasPart = partLine !== undefined && partLine.text.startsWith(PART);
  const part = hasPart && partLine !== undefined ? parsePart(partLine.text) : null;

  const payloadStart = hasPart ? beginIndex + 2 : beginIndex + 1;
  const data = decodePayload(raw, lines, payloadStart, endIndex);
  const trailer = parseTrailer(endLine.text);

  const checksum = compare(trailer, part !== null, data);
  if (options.verify === true && checksum.matches === false) {
    throw new YencChecksumError(checksum.expected ?? 0, checksum.actual);
  }

  return {
    header,
    part,
    trailer,
    data,
    checksum,
    sizeMatches: trailer.size === data.length,
  };
}

interface Line {
  readonly text: string;
  /** Byte offset of the line's first character within the article. */
  readonly start: number;
  /** Byte offset one past the line's last character, excluding the break. */
  readonly end: number;
}

/**
 * Split on CR, LF, or CRLF, recording byte offsets.
 *
 * Offsets matter because the payload is sliced out of the original bytes rather
 * than round-tripped through the latin1 string — decoding operates on the
 * untouched buffer.
 */
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;

  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    const atEnd = index === text.length;

    if (!atEnd && char !== '\r' && char !== '\n') {
      continue;
    }

    lines.push({ text: text.slice(start, index), start, end: index });

    if (char === '\r' && text[index + 1] === '\n') {
      index += 1;
    }
    start = index + 1;
  }

  return lines;
}

function decodePayload(raw: Uint8Array, lines: readonly Line[], from: number, to: number): Buffer {
  const first = lines[from];
  const last = lines[to];

  if (first === undefined || last === undefined || from >= to) {
    return Buffer.alloc(0);
  }

  // One slice across every payload line: decodeBytes already skips the CR and
  // LF separators, so there is no need to decode line by line and concatenate.
  return decodeBytes(raw.subarray(first.start, last.start));
}

/**
 * Read `keyword=value` pairs from a control line.
 *
 * `name=` is deliberately excluded: a filename may contain both spaces and `=`,
 * which is exactly why the spec puts it last on the line. It is taken verbatim
 * by {@link parseHeader} instead.
 */
function fields(line: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const match of line.matchAll(/(\w+)=([^\s]*)/gu)) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined && !found.has(key)) {
      found.set(key, value);
    }
  }

  return found;
}

function parseHeader(line: string): YencHeader {
  const nameAt = line.indexOf('name=');
  if (nameAt < 0) {
    throw new YencDecodeError('=ybegin line has no name= field');
  }

  const name = line.slice(nameAt + 'name='.length).trim();
  if (name.length === 0) {
    throw new YencDecodeError('=ybegin line has an empty name= field');
  }

  const found = fields(line.slice(0, nameAt));

  return {
    part: optionalInteger(found, 'part', BEGIN),
    total: optionalInteger(found, 'total', BEGIN),
    line: optionalInteger(found, 'line', BEGIN),
    size: requiredInteger(found, 'size', BEGIN),
    name,
  };
}

function parsePart(line: string): YencPartRange {
  const found = fields(line);
  const begin = requiredInteger(found, 'begin', PART);
  const end = requiredInteger(found, 'end', PART);

  if (begin < 1) {
    throw new YencDecodeError(`=ypart begin=${begin} is not a 1-based offset`);
  }
  if (end < begin) {
    throw new YencDecodeError(`=ypart range runs backwards: begin=${begin} end=${end}`);
  }

  // Wire format is 1-based inclusive; everything downstream is 0-based
  // half-open.
  return { begin: begin - 1, end };
}

function parseTrailer(line: string): YencTrailer {
  const found = fields(line);

  return {
    size: requiredInteger(found, 'size', END),
    part: optionalInteger(found, 'part', END),
    crc32: optionalHex(found, 'crc32'),
    pcrc32: optionalHex(found, 'pcrc32'),
  };
}

/**
 * Pick the checksum that actually covers the decoded bytes.
 *
 * On a multipart article `pcrc32` covers this part while `crc32`, when present,
 * covers the whole reassembled file — comparing the latter against one part's
 * bytes reports a failure on a perfectly good article.
 */
function compare(trailer: YencTrailer, multipart: boolean, data: Buffer): YencChecksum {
  const expected = multipart ? trailer.pcrc32 : (trailer.crc32 ?? trailer.pcrc32);
  const actual = crc32(data);

  return {
    expected,
    actual,
    matches: expected === null ? null : expected === actual,
  };
}

function requiredInteger(found: ReadonlyMap<string, string>, key: string, line: string): number {
  const value = optionalInteger(found, key, line);
  if (value === null) {
    throw new YencDecodeError(`${line} line has no ${key}= field`);
  }
  return value;
}

function optionalInteger(
  found: ReadonlyMap<string, string>,
  key: string,
  line: string,
): number | null {
  const raw = found.get(key);
  if (raw === undefined) {
    return null;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new YencDecodeError(`${line} field ${key}= is not a number: "${raw}"`);
  }
  return Number(raw);
}

function optionalHex(found: ReadonlyMap<string, string>, key: string): number | null {
  const raw = found.get(key);
  if (raw === undefined) {
    return null;
  }
  if (!/^[0-9a-fA-F]{1,8}$/u.test(raw)) {
    return null;
  }
  return Number.parseInt(raw, 16) >>> 0;
}
