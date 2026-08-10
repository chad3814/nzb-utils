import { afterEach, describe, expect, it } from 'vitest';

import { NntpMultiPool } from '../src/multi-pool.ts';
import type { NntpServerOptions } from '../src/multi-pool.ts';
import { NntpAuthError, NntpCapacityError } from '../src/errors.ts';
import { provider as startProvider } from './fake-provider.ts';
import type { FakeOptions } from './fake-provider.ts';
import { startFakeServer } from './fake-server.ts';
import type { FakeServer } from './fake-server.ts';

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

describe('NntpMultiPool construction', () => {
  it('reports each server as ready before anything is fetched', async () => {
    pool = new NntpMultiPool({ servers: [await provider('primary'), await provider('backup')] });

    expect(pool.servers.map((entry) => entry.name)).toEqual(['primary', 'backup']);
    expect(pool.servers.every((entry) => entry.state === 'ready')).toBe(true);
    expect(pool.servers.every((entry) => entry.downReason === null)).toBe(true);
  });

  it('defaults a name to the host', async () => {
    const first = await provider('ignored');
    const { name: _drop, ...unnamed } = first;
    pool = new NntpMultiPool({ servers: [unnamed] });

    expect(pool.servers[0]?.name).toBe('127.0.0.1');
  });

  it('rejects duplicate names, because exclusion is by name', async () => {
    // Two servers called the same thing would make one exclusion remove both,
    // silently turning a CRC retry into "no candidates left".
    const first = await provider('same');
    const second = await provider('same');

    expect(() => new NntpMultiPool({ servers: [first, second] })).toThrow(/duplicate/u);
  });

  it('rejects an empty server list', () => {
    expect(() => new NntpMultiPool({ servers: [] })).toThrow(/at least one/u);
  });
});

describe('NntpMultiPool selection', () => {
  it('never contacts the backup when the primary has the article', async () => {
    // The assertion that protects a metered account, and the first casualty of
    // any "make it faster by asking everyone at once" change.
    pool = new NntpMultiPool({
      servers: [await provider('primary'), await provider('backup')],
    });

    await pool.body('a@b');

    const backup = servers[1];
    expect(backup?.commands).toEqual([]);
  });

  it('falls back to the next server on a 430', async () => {
    pool = new NntpMultiPool({
      servers: [await provider('primary', { has: false }), await provider('backup')],
    });

    const response = await pool.body('a@b');

    expect(response.server).toBe('backup');
    expect(response.body.toString('latin1')).toBe('hello\r\n');
  });

  it('skips a server named in exclude', async () => {
    pool = new NntpMultiPool({
      servers: [await provider('primary'), await provider('backup')],
    });

    const response = await pool.body('a@b', { exclude: ['primary'] });

    expect(response.server).toBe('backup');
    expect(servers[0]?.commands.some((command) => command.startsWith('BODY'))).toBe(false);
  });

  it('attributes the response even when the primary served it', async () => {
    pool = new NntpMultiPool({ servers: [await provider('primary'), await provider('backup')] });

    await expect(pool.body('a@b')).resolves.toMatchObject({ server: 'primary' });
  });

  it('applies the same walk to stat', async () => {
    pool = new NntpMultiPool({
      servers: [await provider('primary', { has: false }), await provider('backup')],
    });

    await expect(pool.stat('a@b')).resolves.toMatchObject({ code: 223, server: 'backup' });
  });
});

describe('NntpMultiPool at a connection cap', () => {
  it('does not spill onto a server that has not opted in', async () => {
    // logins: 0 means the primary can open nothing at all, which is the only
    // case where NntpCapacityError escapes the pool -- a partial cap is
    // absorbed by the pool shrinking its limit and queueing.
    pool = new NntpMultiPool({
      servers: [await provider('primary', { logins: 0 }), await provider('block')],
    });

    await expect(pool.body('a@b')).rejects.toBeInstanceOf(NntpCapacityError);
    expect(servers[1]?.commands).toEqual([]);
  });

  it('spills onto a server that has opted in', async () => {
    pool = new NntpMultiPool({
      servers: [
        await provider('primary', { logins: 0 }),
        await provider('second', {}, { spillover: true }),
      ],
    });

    await expect(pool.body('a@b')).resolves.toMatchObject({ server: 'second' });
  });

  it('still falls back to a non-spillover server for a genuine gap', async () => {
    // The flag gates overflow only. A 430 is a gap, and that is what the
    // backup is for.
    pool = new NntpMultiPool({
      servers: [await provider('primary', { has: false }), await provider('block')],
    });

    await expect(pool.body('a@b')).resolves.toMatchObject({ server: 'block' });
  });

  it('reports the first saturated server, not the last, when more than one is full', async () => {
    // The primary's cap is the actionable fact -- it names the account worth
    // adding capacity to. A downstream server's cap is just where the walk
    // gave up next; surfacing that one instead would send someone to
    // investigate the wrong account, which is exactly the misattribution
    // NntpCapacityError exists to prevent.
    pool = new NntpMultiPool({
      servers: [
        await provider('primary', { logins: 0, capacityReason: 'primary is full' }),
        await provider(
          'second',
          { logins: 0, capacityReason: 'second is full' },
          { spillover: true },
        ),
      ],
    });

    let caught: unknown;
    try {
      await pool.body('a@b');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NntpCapacityError);
    expect(caught).toMatchObject({ message: expect.stringContaining('primary is full') });
    // Confirms the walk actually reached the second server (spillover let it
    // through), so the assertion above is exercising the overwrite, not a
    // walk that stopped at the primary regardless.
    expect(pool.servers[1]?.failures).toHaveLength(1);
  });

  it('cannot reach a non-spillover server past a saturated primary, even across an intervening 430', async () => {
    // This looks like a bug at a glance: the third server has the article and
    // never gets asked. It is intended. The primary never got to answer
    // "do you have this article" -- it never opened a connection at all -- so
    // there is no demonstrated gap, only an unproven maybe. Spending a metered
    // account's bytes on a maybe is exactly what spillover being opt-in exists
    // to prevent. The 430 in the middle is a red herring: the third server is
    // unreachable this run purely because it never opted in, with or without
    // a middle server present at all.
    pool = new NntpMultiPool({
      servers: [
        await provider('primary', { logins: 0 }),
        await provider('middle', { has: false }, { spillover: true }),
        await provider('third'),
      ],
    });

    await expect(pool.body('a@b')).rejects.toBeInstanceOf(NntpCapacityError);
    expect(servers[2]?.commands).toEqual([]);
  });
});

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
});
