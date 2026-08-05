import { readFile, readdir } from 'node:fs/promises';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { NntpClient } from '../src/client.ts';
import { NntpAuthError, NntpProtocolError, NntpTimeoutError } from '../src/errors.ts';
import { startFakeServer } from './fake-server.ts';
import type { FakeServer } from './fake-server.ts';

const PASSWORD = 'correct-horse-battery-staple';

let server: FakeServer | null = null;
let client: NntpClient | null = null;

afterEach(async () => {
  client?.destroy();
  client = null;
  await server?.close();
  server = null;
});

async function connect(
  respond: (command: string) => string | readonly string[] | null,
): Promise<NntpClient> {
  server = await startFakeServer({ respond });
  client = new NntpClient({ host: '127.0.0.1', port: server.port, security: 'none' });
  await client.connect();
  return client;
}

/** Replies for a well-behaved server holding one article. */
function standardResponses(command: string): string | readonly string[] | null {
  if (command.startsWith('AUTHINFO USER')) {
    return '381 password required\r\n';
  }
  if (command === `AUTHINFO PASS ${PASSWORD}`) {
    return '281 authentication accepted\r\n';
  }
  if (command.startsWith('AUTHINFO PASS')) {
    return '481 authentication rejected\r\n';
  }
  if (command === 'BODY <good@example.com>') {
    return '222 0 <good@example.com> body follows\r\nline one\r\n..stuffed\r\n.\r\n';
  }
  if (command === 'BODY <empty@example.com>') {
    return '222 0 <empty@example.com> body follows\r\n.\r\n';
  }
  if (command.startsWith('BODY')) {
    return '430 no such article\r\n';
  }
  if (command === 'STAT <good@example.com>') {
    return '223 0 <good@example.com>\r\n';
  }
  if (command.startsWith('GROUP')) {
    return '211 10 1 10 alt.binaries.test\r\n';
  }
  if (command === 'QUIT') {
    return '205 closing connection\r\n';
  }
  return '500 unknown command\r\n';
}

describe('NntpClient connection', () => {
  it('reads the greeting on connect', async () => {
    server = await startFakeServer({ respond: standardResponses });
    client = new NntpClient({ host: '127.0.0.1', port: server.port, security: 'none' });

    const greeting = await client.connect();

    expect(greeting.code).toBe(200);
  });

  it('rejects a greeting that refuses service', async () => {
    server = await startFakeServer({
      greeting: '502 service permanently unavailable\r\n',
      respond: standardResponses,
    });
    client = new NntpClient({ host: '127.0.0.1', port: server.port, security: 'none' });

    await expect(client.connect()).rejects.toThrow(NntpProtocolError);
  });
});

describe('NntpClient authentication', () => {
  it('sends USER then PASS and accepts 281', async () => {
    const nntp = await connect(standardResponses);

    const response = await nntp.authenticate({ user: 'someone', pass: PASSWORD });

    expect(response.code).toBe(281);
    expect(server?.commands).toContain('AUTHINFO USER someone');
  });

  it('throws NntpAuthError when the server rejects the password', async () => {
    const nntp = await connect(standardResponses);

    await expect(nntp.authenticate({ user: 'someone', pass: 'wrong' })).rejects.toThrow(
      NntpAuthError,
    );
  });

  it('never puts the password in the error message', async () => {
    // Hard rule: credentials live only in this package and must not escape
    // through a log line, an error string, or a stack trace.
    const nntp = await connect(standardResponses);

    const error = await nntp
      .authenticate({ user: 'someone', pass: PASSWORD.replace('correct', 'wrong') })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(NntpAuthError);
    const serialized = `${String(error)}${JSON.stringify(error)}${String(
      error instanceof Error ? error.stack : '',
    )}`;
    expect(serialized).not.toContain('horse-battery-staple');
  });

  it('exposes no credential on the enumerable surface of the client', async () => {
    // Catches the realistic slip -- `this.credentials = credentials` on a
    // public field -- but note the limit below: it cannot see #private fields.
    const nntp = await connect(standardResponses);
    await nntp.authenticate({ user: 'someone', pass: PASSWORD });

    expect(JSON.stringify(nntp)).not.toContain(PASSWORD);
    expect(inspectDeep(nntp)).not.toContain(PASSWORD);
    expect(inspect(nntp, { showHidden: true, depth: 4 })).not.toContain(PASSWORD);
  });

  it('never assigns credentials to a field anywhere in the package', async () => {
    // A `#private` field is invisible to JSON.stringify, Reflect.ownKeys and
    // util.inspect alike, so "the client does not retain the password" is not
    // observable at runtime -- verified: none of the three reveal it. The rule
    // is real and worth enforcing, so it is enforced against the source, which
    // is the only place it can be seen.
    const directory = new URL('../src/', import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.ts'));

    expect(files.length).toBeGreaterThan(0);
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        text: await readFile(new URL(file, directory), 'utf8'),
      })),
    );

    for (const { file, text } of sources) {
      expect(text, `${file} assigns credentials to a field`).not.toMatch(
        /(?:this|self)\s*\.\s*#?\w+\s*=\s*credentials\b/u,
      );
      // Providers made a second slip possible that the rule above cannot see:
      // stashing the *resolved* value, which is a plain string by then and no
      // longer called `credentials`. A resolved secret must stay a local.
      expect(text, `${file} retains a resolved secret on a field`).not.toMatch(
        /(?:this|self)\s*\.\s*#?\w+\s*=\s*(?:await\s+)?resolveSecret\b/u,
      );
    }
  });
});

describe('NntpClient article retrieval', () => {
  it('wraps the Message-ID in angle brackets on the wire', async () => {
    // NZBs store Message-IDs without brackets and the protocol requires them.
    // Forgetting is a 430 on every single article.
    const nntp = await connect(standardResponses);

    await nntp.body('good@example.com');

    expect(server?.commands).toContain('BODY <good@example.com>');
  });

  it('returns the body dot-unstuffed', async () => {
    const nntp = await connect(standardResponses);

    const response = await nntp.body('good@example.com');

    expect(response.code).toBe(222);
    expect(response.body).toEqual(Buffer.from('line one\r\n.stuffed\r\n', 'latin1'));
  });

  it('returns an empty body rather than hanging', async () => {
    // A terminator with no preceding line does not match a naive "\r\n.\r\n"
    // scan, so this is the case that hangs until the socket times out.
    const nntp = await connect(standardResponses);

    const response = await nntp.body('empty@example.com');

    expect(response.body).toHaveLength(0);
  });

  it('throws on 430 without waiting for a body that will never come', async () => {
    const nntp = await connect(standardResponses);

    await expect(nntp.body('missing@example.com')).rejects.toThrow(NntpProtocolError);
  });

  it('reports the status code on a protocol error', async () => {
    const nntp = await connect(standardResponses);

    const error = await nntp.body('missing@example.com').then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(NntpProtocolError);
    expect((error as NntpProtocolError).code).toBe(430);
  });

  it('transfers no payload for STAT', async () => {
    const nntp = await connect(standardResponses);

    const response = await nntp.stat('good@example.com');

    expect(response.code).toBe(223);
    expect(server?.commands).toContain('STAT <good@example.com>');
  });

  it('reuses one connection for consecutive requests', async () => {
    // Pipelining on a single socket is the whole reason a downloader can go
    // fast; reconnecting per article would be an order of magnitude slower.
    const nntp = await connect(standardResponses);

    await nntp.body('good@example.com');
    await nntp.body('good@example.com');
    const response = await nntp.body('good@example.com');

    expect(response.body).toEqual(Buffer.from('line one\r\n.stuffed\r\n', 'latin1'));
    expect(server?.commands.filter((c) => c.startsWith('BODY'))).toHaveLength(3);
  });

  it('reassembles a body delivered in awkward chunks', async () => {
    const nntp = await connect((command) =>
      command === 'BODY <split@example.com>'
        ? ['222 0 <split@example.com> body foll', 'ows\r\nab', 'c\r', '\n', '.', '\r\n']
        : standardResponses(command),
    );

    const response = await nntp.body('split@example.com');

    expect(response.body).toEqual(Buffer.from('abc\r\n', 'latin1'));
  });
});

describe('NntpClient timeouts', () => {
  it('times out instead of waiting forever on a silent server', async () => {
    server = await startFakeServer({ respond: () => null });
    client = new NntpClient({
      host: '127.0.0.1',
      port: server.port,
      security: 'none',
      timeoutMs: 100,
    });
    await client.connect();

    await expect(client.body('good@example.com')).rejects.toThrow(NntpTimeoutError);
  });
});

/** Walk own properties one level deep, to catch a credential stashed on a field. */
function inspectDeep(value: object): string {
  const parts: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    const entry = Reflect.get(value, key) as unknown;
    parts.push(String(key), String(entry));
    if (entry !== null && typeof entry === 'object') {
      for (const inner of Reflect.ownKeys(entry)) {
        parts.push(String(inner), String(Reflect.get(entry, inner)));
      }
    }
  }
  return parts.join('|');
}
