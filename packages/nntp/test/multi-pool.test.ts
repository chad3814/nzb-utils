import { afterEach, describe, expect, it } from 'vitest';

import { NntpMultiPool } from '../src/multi-pool.ts';
import type { NntpServerOptions } from '../src/multi-pool.ts';
import { NntpCapacityError, NntpProtocolError, NntpUnavailableError } from '../src/errors.ts';
import { provider as startProvider } from './fake-provider.ts';
import type { FakeOptions } from './fake-provider.ts';
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

describe('NntpMultiPool when no server can supply the article', () => {
  it('throws a 430 when every server said 430', async () => {
    // nzb get depends on this error type to skip a file and carry on -- it is
    // how a run survives an expired .nfo. A new error type here would turn a
    // skip into a crash.
    pool = new NntpMultiPool({
      servers: [
        await provider('primary', { has: false }),
        await provider('backup', { has: false }),
      ],
    });

    const error = await pool.body('a@b').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NntpProtocolError);
    expect((error as NntpProtocolError).code).toBe(430);
  });

  it('throws NntpUnavailableError naming each server on a mixed failure', async () => {
    pool = new NntpMultiPool({
      servers: [
        await provider('gone', { has: false }),
        await provider('broken', { refuseAuth: true }),
      ],
    });

    const error = await pool.body('a@b').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NntpUnavailableError);
    expect((error as NntpUnavailableError).attempts.map((attempt) => attempt.server)).toEqual([
      'gone',
      'broken',
    ]);
    expect((error as NntpUnavailableError).message).toContain('broken');
  });

  it('throws NntpUnavailableError when every candidate was excluded', async () => {
    pool = new NntpMultiPool({ servers: [await provider('only')] });

    await expect(pool.body('a@b', { exclude: ['only'] })).rejects.toBeInstanceOf(
      NntpUnavailableError,
    );
  });

  it('surfaces a non-NNTP bug through NntpUnavailableError instead of disguising it as a missing article', async () => {
    // A credential provider that throws a plain bug rather than answering
    // with a protocol status -- resolveSecret (auth.ts) deliberately lets a
    // provider's rejection through uncaught, so this is a realistic source of
    // an error #handleFailure has never classified before. It must still
    // reach the caller identifiably, not fall out the bottom of #run as a
    // misleading "no such article".
    pool = new NntpMultiPool({
      servers: [
        await provider(
          'buggy',
          {},
          {
            credentials: {
              user: () => {
                throw new TypeError('boom: not a real credential provider');
              },
              pass: 'secret',
            },
          },
        ),
      ],
    });

    const error = await pool.body('a@b').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NntpUnavailableError);
    const attempts = (error as NntpUnavailableError).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.reason).toBeInstanceOf(TypeError);
    expect((error as NntpUnavailableError).message).toContain('boom');
  });
});
