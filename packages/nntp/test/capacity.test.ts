import { afterEach, describe, expect, it } from 'vitest';

import { NntpClient } from '../src/client.ts';
import { NntpAuthError, NntpCapacityError } from '../src/errors.ts';
import { NntpPool } from '../src/pool.ts';
import { startFakeServer } from './fake-server.ts';
import type { FakeServer } from './fake-server.ts';

/**
 * A provider at its simultaneous-connection cap.
 *
 * Found against a real server: `-c 8` on an account allowing fewer answered
 * `AUTHINFO` with `502 Too many connections`, which the client reported as an
 * authentication failure and the pool propagated — so six of eight perfectly
 * available files came back as unopenable.
 */

let server: FakeServer | null = null;
let pool: NntpPool | null = null;
let client: NntpClient | null = null;

afterEach(async () => {
  client?.destroy();
  client = null;
  pool?.destroy();
  pool = null;
  await server?.close();
  server = null;
});

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

describe('a 502 refusal', () => {
  it('is not reported as an authentication failure', async () => {
    // The remedy is different: nothing is wrong with the password, and telling
    // someone to check it sends them to rotate a working credential.
    server = await startFakeServer({ respond: cappedServer(0) });
    client = new NntpClient({ host: '127.0.0.1', port: server.port, security: 'none' });
    await client.connect();

    const error = await client
      .authenticate({ user: 'someone', pass: 'secret' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NntpCapacityError);
    expect(error).not.toBeInstanceOf(NntpAuthError);
  });

  it('keeps the server’s own wording, which names the real cause', async () => {
    server = await startFakeServer({ respond: cappedServer(0) });
    client = new NntpClient({ host: '127.0.0.1', port: server.port, security: 'none' });
    await client.connect();

    await expect(client.authenticate({ user: 'someone', pass: 'secret' })).rejects.toThrow(
      /Too many connections/u,
    );
  });

  it('is still an auth error when the credential really is rejected', async () => {
    server = await startFakeServer({
      respond: (command) =>
        command.startsWith('AUTHINFO') ? '481 authentication rejected\r\n' : null,
    });
    client = new NntpClient({ host: '127.0.0.1', port: server.port, security: 'none' });
    await client.connect();

    await expect(client.authenticate({ user: 'someone', pass: 'wrong' })).rejects.toBeInstanceOf(
      NntpAuthError,
    );
  });
});

describe('NntpPool against a capped provider', () => {
  it('completes the work using the connections it is allowed', async () => {
    // The bug this replaces: asking for more connections than the account
    // permits failed the requests outright, rather than running them on the
    // connections that did open.
    server = await startFakeServer({ respond: cappedServer(2) });
    pool = new NntpPool({
      endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
      credentials: { user: 'someone', pass: 'secret' },
      connections: 8,
    });

    const bodies = await Promise.all(
      Array.from({ length: 6 }, (_, index) => pool?.body(`a${String(index)}@b`)),
    );

    expect(bodies).toHaveLength(6);
    for (const response of bodies) {
      expect(response?.body.toString('latin1')).toBe('hello\r\n');
    }
  });

  it('shrinks its limit to what the provider actually allows', async () => {
    server = await startFakeServer({ respond: cappedServer(2) });
    pool = new NntpPool({
      endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
      credentials: { user: 'someone', pass: 'secret' },
      connections: 8,
    });

    await Promise.all(Array.from({ length: 6 }, (_, index) => pool?.body(`a${String(index)}@b`)));

    expect(pool.limit).toBeLessThanOrEqual(2);
  });

  it('keeps the refusal in its failure history, so the cap is visible', async () => {
    // Silently degrading would leave someone wondering why -c 8 runs at the
    // speed of 2.
    server = await startFakeServer({ respond: cappedServer(2) });
    pool = new NntpPool({
      endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
      credentials: { user: 'someone', pass: 'secret' },
      connections: 8,
    });

    await Promise.all(Array.from({ length: 6 }, (_, index) => pool?.body(`a${String(index)}@b`)));

    expect(pool.failures.some((failure) => failure.reason.includes('Too many connections'))).toBe(
      true,
    );
  });

  it('still fails when not one connection can be opened', async () => {
    // Degrading needs something to degrade to. With nothing live, the caller
    // has to hear about it.
    server = await startFakeServer({ respond: cappedServer(0) });
    pool = new NntpPool({
      endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
      credentials: { user: 'someone', pass: 'secret' },
      connections: 4,
    });

    await expect(pool.body('a@b')).rejects.toBeInstanceOf(NntpCapacityError);
  });
});
