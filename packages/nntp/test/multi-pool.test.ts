import { afterEach, describe, expect, it } from 'vitest';

import { NntpMultiPool } from '../src/multi-pool.ts';
import type { NntpServerOptions } from '../src/multi-pool.ts';
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
