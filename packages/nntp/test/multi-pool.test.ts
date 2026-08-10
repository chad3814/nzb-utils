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
