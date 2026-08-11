import { afterEach, describe, expect, it } from 'vitest';

import { NntpMultiPool } from '../src/multi-pool.ts';
import type { NntpServerOptions, NntpServerStat } from '../src/multi-pool-models.ts';
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

  it('reports a server already marked down as unknown, without re-contacting it', async () => {
    pool = new NntpMultiPool({
      servers: [
        await provider('primary', { has: false }),
        await provider('bad', { refuseAuth: true }),
        await provider('good'),
      ],
    });

    // Marks 'bad' down.
    await pool.body('a@b');
    const downReason = pool.servers[1]?.downReason;
    const commandsBeforeStatAll = servers[1]?.commands.length;

    const report = await pool.statAll('a@b');

    // Re-contacting 'bad' would reproduce the same auth refusal and also
    // classify as unknown, which would make this indistinguishable from
    // statAll asking anyway. Only asserting identity of the stored reason
    // -- not merely its shape -- and that no command was sent, pins
    // "reported from stored state" rather than "asked again and happened
    // to get the same kind of answer."
    const entry = report[1];
    expect(entry).toMatchObject({ server: 'bad', status: 'unknown' });
    const unknownEntry = entry as Extract<NntpServerStat, { readonly status: 'unknown' }>;
    expect(unknownEntry.reason).toBe(downReason);
    expect(servers[1]?.commands.length).toBe(commandsBeforeStatAll);
  });

  it('does not mark a server down as a side effect of reporting', async () => {
    // statAll is diagnostic. A report that changes what it reports on is a
    // trap. Four calls, not two: consecutiveFailures only turns a server
    // down at DOWN_AFTER (3), so fewer calls would pass even if statAll
    // wired the same counter into its catch as #run does.
    pool = new NntpMultiPool({ servers: [await provider('flaky', { refuseAuth: true })] });

    await pool.statAll('a@b');
    await pool.statAll('a@b');
    await pool.statAll('a@b');
    await pool.statAll('a@b');

    expect(pool.servers[0]?.state).toBe('ready');
  });
});
