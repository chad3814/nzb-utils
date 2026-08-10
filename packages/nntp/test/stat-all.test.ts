import { afterEach, describe, expect, it } from 'vitest';

import { NntpMultiPool } from '../src/multi-pool.ts';
import type { NntpServerOptions } from '../src/multi-pool-models.ts';
import { provider as startProvider } from './fake-provider.ts';
import type { FakeOptions } from './fake-provider.ts';
import type { FakeServer } from './fake-server.ts';

// Split out of multi-pool.test.ts, matching multi-pool-failures.test.ts's
// precedent for staying under the repo's 300-line cap. Setup is duplicated
// rather than shared.

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

describe('statAll', () => {
  it('separates absent from unknown, which one server cannot', async () => {
    // stat throws on a 430 today, so "does not have it" and "could not ask"
    // are both errors. Across servers that is the difference between gone
    // everywhere and gone from the ones that answered -- and only the first
    // justifies giving up on a file.
    const unreachable = await provider('unreachable', { refuseAuth: true });
    pool = new NntpMultiPool({
      servers: [await provider('has-it'), await provider('lost-it', { has: false }), unreachable],
    });

    const report = await pool.statAll('a@b');

    expect(report).toEqual([
      { server: 'has-it', status: 'present' },
      { server: 'lost-it', status: 'absent' },
      { server: 'unreachable', status: 'unknown', reason: expect.any(Error) },
    ]);
  });

  it('reports a server already marked down as unknown, with its reason', async () => {
    pool = new NntpMultiPool({
      servers: [
        await provider('primary', { has: false }),
        await provider('bad', { refuseAuth: true }),
        await provider('good'),
      ],
    });

    // Marks 'bad' down.
    await pool.body('a@b');
    const report = await pool.statAll('a@b');

    expect(report[1]).toMatchObject({ server: 'bad', status: 'unknown' });
  });

  it('does not mark a server down as a side effect of reporting', async () => {
    // statAll is diagnostic. A report that changes what it reports on is a
    // trap.
    pool = new NntpMultiPool({ servers: [await provider('flaky', { refuseAuth: true })] });

    await pool.statAll('a@b');
    await pool.statAll('a@b');

    expect(pool.servers[0]?.state).toBe('ready');
  });
});
