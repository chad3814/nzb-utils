import { crc32 } from 'node:zlib';

/**
 * A synthetic post, as both an NZB document and the articles that back it.
 *
 * The CLI tests need both halves to line up, so they are generated together
 * here. CRCs come from `node:zlib` rather than from `@chad3814/yenc`, so a
 * fixture cannot agree with a broken decoder by construction.
 */

const LINE = 128;

function encodePayload(data: Buffer): Buffer {
  const out: number[] = [];
  let column = 0;

  for (const byte of data) {
    const value = (byte + 42) % 256;
    const escaped = value === 0x00 || value === 0x0a || value === 0x0d || value === 0x3d;

    if (column >= LINE) {
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

export interface FileSpec {
  readonly name: string;
  readonly segmentSizes: readonly number[];
}

export interface Post {
  readonly xml: string;
  /** Message-ID (without brackets) to complete article bytes. */
  readonly articles: ReadonlyMap<string, Buffer>;
  /** Filename to its complete decoded contents. */
  readonly contents: ReadonlyMap<string, Buffer>;
  /** Message-IDs that should answer 430, for retention tests. */
  readonly missing: ReadonlySet<string>;
}

export interface PostOptions {
  readonly files: readonly FileSpec[];
  /** Message-IDs to serve as absent. */
  readonly missing?: ReadonlySet<string>;
}

function fill(size: number, seed: number): Buffer {
  const data = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    data[index] = (state >>> 16) & 0xff;
  }
  return data;
}

export function buildPost(options: PostOptions): Post {
  const articles = new Map<string, Buffer>();
  const contents = new Map<string, Buffer>();
  const entries: string[] = [];

  for (const [fileIndex, spec] of options.files.entries()) {
    const total = spec.segmentSizes.reduce((sum, size) => sum + size, 0);
    const data = fill(total, 0x2545_f491 + fileIndex);
    contents.set(spec.name, data);

    const multipart = spec.segmentSizes.length > 1;
    const segments: string[] = [];
    let offset = 0;

    for (const [index, size] of spec.segmentSizes.entries()) {
      const payload = data.subarray(offset, offset + size);
      const messageId = `f${String(fileIndex)}s${String(index + 1)}@fixture.invalid`;
      const checksum = crc32(payload).toString(16).padStart(8, '0');

      const head = multipart
        ? `=ybegin part=${String(index + 1)} total=${String(spec.segmentSizes.length)} line=${String(LINE)} size=${String(total)} name=${spec.name}\r\n` +
          `=ypart begin=${String(offset + 1)} end=${String(offset + size)}\r\n`
        : `=ybegin line=${String(LINE)} size=${String(total)} name=${spec.name}\r\n`;
      const tail = multipart
        ? `\r\n=yend size=${String(size)} part=${String(index + 1)} pcrc32=${checksum}\r\n`
        : `\r\n=yend size=${String(size)} crc32=${checksum}\r\n`;

      const article = Buffer.concat([
        Buffer.from(head, 'latin1'),
        encodePayload(payload),
        Buffer.from(tail, 'latin1'),
      ]);
      articles.set(messageId, article);

      segments.push(
        `      <segment bytes="${String(article.length)}" number="${String(index + 1)}">${messageId}</segment>`,
      );
      offset += size;
    }

    entries.push(
      `  <file poster="p &lt;p@example.invalid&gt;" date="1767225600" ` +
        `subject="Fixture [${String(fileIndex + 1)}/${String(options.files.length)}] - &quot;${spec.name}&quot; yEnc (1/${String(spec.segmentSizes.length)})">\n` +
        `    <groups><group>alt.binaries.test</group></groups>\n` +
        `    <segments>\n${segments.join('\n')}\n    </segments>\n` +
        `  </file>`,
    );
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head><meta type="title">Fixture</meta></head>
${entries.join('\n')}
</nzb>`;

  return { xml, articles, contents, missing: options.missing ?? new Set() };
}

/**
 * Dot-stuff a body, as any real server does.
 *
 * Encoded yEnc lines beginning with `.` occur about once in 256 in random data,
 * so a fake server that skipped this would be sending something no real server
 * sends — and a line that is exactly `.` would terminate the response early.
 * Stuffing here means the transport's unstuffing is exercised end to end.
 */
function stuff(article: Buffer): string {
  return article
    .toString('latin1')
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/** Reply function for `startFakeServer`, serving a post over NNTP. */
export function responder(post: Post): (command: string) => string | null {
  return (command: string): string | null => {
    if (command.startsWith('AUTHINFO USER')) {
      return '381 password required\r\n';
    }
    if (command.startsWith('AUTHINFO PASS')) {
      return '281 authentication accepted\r\n';
    }

    const match = /^(BODY|STAT) <(.+)>$/u.exec(command);
    if (match !== null) {
      const [, verb, messageId = ''] = match;
      const article = post.articles.get(messageId);
      if (article === undefined || post.missing.has(messageId)) {
        return '430 no such article\r\n';
      }
      if (verb === 'STAT') {
        return `223 0 <${messageId}>\r\n`;
      }
      return `222 0 <${messageId}> body follows\r\n${stuff(article)}.\r\n`;
    }

    if (command === 'QUIT') {
      return '205 closing\r\n';
    }
    return '500 unknown command\r\n';
  };
}
