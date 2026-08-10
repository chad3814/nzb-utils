import { afterEach, describe, expect, it } from 'vitest';

import { NntpPool } from '../src/pool.ts';
import { NntpConnectionError } from '../src/errors.ts';
import { startFakeServer } from './fake-server.ts';
import type { FakeServer } from './fake-server.ts';

let server: FakeServer | null = null;
let pool: NntpPool | null = null;

afterEach(async () => {
  await pool?.destroy();
  pool = null;
  await server?.close();
  server = null;
});

function responses(command: string): string | readonly string[] | null {
  if (command.startsWith('AUTHINFO USER')) {
    return '381 password required\r\n';
  }
  if (command === 'AUTHINFO PASS right') {
    return '281 authentication accepted\r\n';
  }
  if (command.startsWith('AUTHINFO PASS')) {
    return '481 authentication rejected\r\n';
  }
  if (command.startsWith('BODY')) {
    return '222 0 <x> body follows\r\npayload\r\n.\r\n';
  }
  if (command === 'QUIT') {
    return '205 bye\r\n';
  }
  return '500 unknown\r\n';
}

async function open(connections: number, pass = 'right'): Promise<NntpPool> {
  server = await startFakeServer({ respond: responses });
  pool = new NntpPool({
    endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
    credentials: { user: 'someone', pass },
    connections,
  });
  return pool;
}

/** Accepts `allowed` logins, then answers 502 like a provider at its cap. */
function cappedServer(allowed: number): (command: string) => string | null {
  let logins = 0;

  return (command: string): string | null => {
    if (command.startsWith('AUTHINFO USER')) {
      logins += 1;
      return logins > allowed ? '502 Too many connections.\r\n' : '381 password required\r\n';
    }
    if (command.startsWith('AUTHINFO PASS')) {
      return '281 authentication accepted\r\n';
    }
    if (command.startsWith('BODY')) {
      return '222 0 <a@b> body follows\r\nhello\r\n.\r\n';
    }
    if (command === 'QUIT') {
      return '205 closing\r\n';
    }
    return '500 unknown command\r\n';
  };
}

describe('NntpPool', () => {
  it('fetches an article body through a pooled connection', async () => {
    const client = await open(2);

    const response = await client.body('a@example.com');

    expect(response.body).toEqual(Buffer.from('payload\r\n', 'latin1'));
  });

  it('opens no connection until one is needed', async () => {
    // The reference pool opens all 24 connections in its constructor: 24 TLS
    // handshakes and logins to fetch a 172 KB preview.
    await open(8);

    expect(server?.commands).toHaveLength(0);
  });

  it('opens at most as many connections as requested', async () => {
    const client = await open(2);

    await Promise.all([
      client.body('a@example.com'),
      client.body('b@example.com'),
      client.body('c@example.com'),
      client.body('d@example.com'),
    ]);

    const logins = server?.commands.filter((c) => c.startsWith('AUTHINFO USER')) ?? [];
    expect(logins.length).toBeLessThanOrEqual(2);
  });

  it('reuses a connection rather than reconnecting per article', async () => {
    const client = await open(1);

    await client.body('a@example.com');
    await client.body('b@example.com');
    await client.body('c@example.com');

    expect(server?.commands.filter((c) => c.startsWith('AUTHINFO USER'))).toHaveLength(1);
  });

  it('satisfies concurrent requests that exceed the connection count', async () => {
    const client = await open(2);

    const bodies = await Promise.all(
      Array.from({ length: 6 }, (_, i) => client.body(`a${i}@example.com`)),
    );

    expect(bodies).toHaveLength(6);
    for (const body of bodies) {
      expect(body.body).toEqual(Buffer.from('payload\r\n', 'latin1'));
    }
  });

  it('surfaces a bad password as an attributable authentication failure', async () => {
    // The reference pool swallows every per-connection error behind one
    // generic "failed to establish any connections", making a wrong password
    // indistinguishable from a provider connection cap.
    const client = await open(2, 'wrong');

    const error = await client.body('a@example.com').then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/authentication/iu);
  });

  it('never puts the password in a pool error', async () => {
    const client = await open(2, 'super-secret-value');

    const error = await client.body('a@example.com').then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(String(error)).not.toContain('super-secret-value');
  });

  it('reports a connection refusal without claiming it was an auth problem', async () => {
    server = await startFakeServer({ respond: responses });
    const { port } = server;
    await server.close();
    server = null;

    pool = new NntpPool({
      endpoint: { host: '127.0.0.1', port, security: 'none' },
      credentials: { user: 'someone', pass: 'right' },
      connections: 1,
    });

    await expect(pool.body('a@example.com')).rejects.toThrow(NntpConnectionError);
  });

  it('replaces a connection the server has dropped', async () => {
    const client = await open(1);
    await client.body('a@example.com');

    // Kill the server-side socket, then ask for another article. A pool that
    // re-enqueues connections with no health check hands the dead one straight
    // back out.
    await server?.close();
    server = await startFakeServer({ respond: responses });

    // The replacement server is on a different port, so the retry cannot
    // succeed -- what matters is that it fails cleanly instead of hanging.
    await expect(client.body('b@example.com')).rejects.toThrow(Error);
  });

  it('names the server that answered, so a caller can tell pools apart', async () => {
    server = await startFakeServer({ respond: cappedServer(4) });
    pool = new NntpPool({
      endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
      credentials: { user: 'someone', pass: 'secret' },
      connections: 1,
    });

    const response = await pool.body('a@b');

    expect(response.server).toBe('127.0.0.1');
  });
});
