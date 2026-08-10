import { afterEach, describe, expect, it } from 'vitest';

import { NntpMultiPool } from '../src/multi-pool.ts';
import type { NntpServerOptions } from '../src/multi-pool.ts';
import { NntpAuthError, NntpProtocolError } from '../src/errors.ts';
import { provider as startProvider } from './fake-provider.ts';
import type { FakeOptions } from './fake-provider.ts';
import { startFakeServer } from './fake-server.ts';
import type { FakeServer } from './fake-server.ts';

// Split out of multi-pool.test.ts once auth/failure-threshold coverage pushed
// that file past the repo's 300-line cap, the same way capacity.test.ts split
// out of pool.test.ts. Setup is duplicated rather than shared, matching that
// precedent.

const servers: FakeServer[] = [];
let pool: NntpMultiPool | null = null;

afterEach(async () => {
  pool?.destroy();
  pool = null;
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Start a fake provider, track it for cleanup, and return the pool-facing options. */
async function provider(
  name: string,
  options: FakeOptions = {},
  extra: Partial<NntpServerOptions> = {},
): Promise<NntpServerOptions> {
  const started = await startProvider(name, options, extra);
  servers.push(started.server);
  return started.options;
}

describe('NntpMultiPool with a bad server', () => {
  it('treats an auth failure on the primary as fatal and never uses a backup', async () => {
    // Failing over here would quietly run a whole download on a metered
    // account because the primary's password was mistyped.
    pool = new NntpMultiPool({
      servers: [await provider('primary', { refuseAuth: true }), await provider('backup')],
    });

    await expect(pool.body('a@b')).rejects.toBeInstanceOf(NntpAuthError);
    expect(servers[1]?.commands).toEqual([]);
  });

  it('keeps the primary auth failure sticky', async () => {
    pool = new NntpMultiPool({
      servers: [await provider('primary', { refuseAuth: true }), await provider('backup')],
    });

    await expect(pool.body('a@b')).rejects.toBeInstanceOf(NntpAuthError);
    const afterFirst = servers[0]?.commands.length ?? 0;

    await expect(pool.body('b@b')).rejects.toBeInstanceOf(NntpAuthError);

    // The primary is not contacted again at all, not merely refused again --
    // without stickiness, the second call would retry the primary and hit the
    // same refusal, which every assertion below would also be true of.
    expect(servers[0]?.commands.length).toBe(afterFirst);
    expect(servers[1]?.commands).toEqual([]);
  });

  it('marks a backup down on its first auth failure and stops asking it', async () => {
    // Deterministic: a password that was wrong a moment ago will be wrong
    // again, so retrying it once per article is pure noise.
    pool = new NntpMultiPool({
      servers: [
        await provider('primary', { has: false }),
        await provider('bad', { refuseAuth: true }),
        await provider('good'),
      ],
    });

    await expect(pool.body('a@b')).resolves.toMatchObject({ server: 'good' });
    const afterFirst = servers[1]?.commands.length ?? 0;

    await expect(pool.body('b@b')).resolves.toMatchObject({ server: 'good' });

    expect(servers[1]?.commands.length).toBe(afterFirst);
    expect(pool.servers[1]?.state).toBe('down');
    expect(pool.servers[1]?.downReason).toBeInstanceOf(NntpAuthError);
  });

  it('leaves a server up when its failures are not consecutive', async () => {
    // A fake that accepts the connection and then refuses every command with a
    // 400 forces the pool to discard the connection and the multi-pool to count
    // a connection-level failure. Scripted fail, fail, succeed, fail, fail: two
    // failures alone would pass whether or not success resets the count, since
    // two is already below the threshold of three. Only the trailing pair makes
    // the reset load-bearing -- without it, attempt four stacks onto the first
    // two for three consecutive failures and the server goes down.
    let attempt = 0;
    const flaky = await startFakeServer({
      respond: (command) => {
        if (command.startsWith('AUTHINFO PASS')) return '281 authentication accepted\r\n';
        if (command.startsWith('AUTHINFO')) return '381 password required\r\n';
        if (command.startsWith('BODY')) {
          attempt += 1;
          return attempt === 3
            ? '222 0 <a@b> body follows\r\nhello\r\n.\r\n'
            : '400 unavailable\r\n';
        }
        return '500 unknown command\r\n';
      },
    });
    servers.push(flaky);

    pool = new NntpMultiPool({
      servers: [
        {
          name: 'flaky',
          endpoint: { host: '127.0.0.1', port: flaky.port, security: 'none' },
          credentials: { user: 'someone', pass: 'secret' },
          connections: 1,
        },
        await provider('backup'),
      ],
    });

    // flaky fails once, backup serves
    await pool.body('a@b');
    // twice
    await pool.body('b@b');
    // third call succeeds on flaky, resetting the count
    await pool.body('c@b');
    // fourth and fifth calls fail again; without the reset above, this is a
    // third *consecutive* failure and would take flaky down
    await pool.body('d@b');
    await pool.body('e@b');

    expect(pool.servers[0]?.state).toBe('ready');
  });

  it('marks a server down after three consecutive connection failures and stops asking it', async () => {
    // No success anywhere in this run: three genuine consecutive
    // connection-level failures is the threshold itself, not a scenario
    // below it, so this is the positive half "leaves a server up" cannot
    // exercise on its own.
    const broken = await startFakeServer({
      respond: (command) => {
        if (command.startsWith('AUTHINFO PASS')) return '281 authentication accepted\r\n';
        if (command.startsWith('AUTHINFO')) return '381 password required\r\n';
        if (command.startsWith('BODY')) return '400 unavailable\r\n';
        return '500 unknown command\r\n';
      },
    });
    servers.push(broken);

    pool = new NntpMultiPool({
      servers: [
        {
          name: 'broken',
          endpoint: { host: '127.0.0.1', port: broken.port, security: 'none' },
          credentials: { user: 'someone', pass: 'secret' },
          connections: 1,
        },
        await provider('backup'),
      ],
    });

    await pool.body('a@b');
    await pool.body('b@b');
    await pool.body('c@b');

    expect(pool.servers[0]?.state).toBe('down');
    expect(pool.servers[0]?.downReason).toBeInstanceOf(NntpProtocolError);

    const afterThree = servers[0]?.commands.length ?? 0;
    await pool.body('d@b');

    // A down server is skipped, not retried -- that is the entire point of
    // taking it out of rotation.
    expect(servers[0]?.commands.length).toBe(afterThree);
  });
});
