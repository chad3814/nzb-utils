import { afterEach, describe, expect, it } from 'vitest';

import { NntpMultiPool } from '../src/multi-pool.ts';
import type { NntpServerOptions } from '../src/multi-pool-models.ts';
import { provider as startProvider } from './fake-provider.ts';
import type { FakeOptions } from './fake-provider.ts';
import type { FakeServer } from './fake-server.ts';

// head() and article() arrived with the multi-pool and no test called either
// one. Both could have returned the pool's host instead of the configured
// name, and both could have stopped walking the candidate list, without a
// single failure anywhere in the suite. Its own file rather than an addition
// to multi-pool.test.ts, which is within a few lines of the repo's 300-line
// cap; setup is duplicated rather than shared, matching the precedent
// multi-pool-failures.test.ts set.

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

describe('NntpMultiPool article methods', () => {
  it('attributes every method to the configured name, not the host that answered', async () => {
    // Every fake runs on 127.0.0.1, which is exactly what NntpPool sets
    // `server` to, so a method that hands its pool's response straight back
    // reports the host. That is not cosmetic: the name is the only handle the
    // `exclude` list has, so a caller retrying elsewhere with the reported
    // value would exclude nothing and ask the same server again.
    pool = new NntpMultiPool({ servers: [await provider('primary'), await provider('backup')] });

    await expect(pool.head('a@b')).resolves.toMatchObject({ code: 221, server: 'primary' });
    await expect(pool.article('a@b')).resolves.toMatchObject({ code: 220, server: 'primary' });
    await expect(pool.body('a@b')).resolves.toMatchObject({ code: 222, server: 'primary' });
    await expect(pool.stat('a@b')).resolves.toMatchObject({ code: 223, server: 'primary' });
  });

  it('walks to the next server on a 430 for head and article as well as body', async () => {
    // Each method passes its own callback into the same walk. Sharing the walk
    // is the design, but nothing enforces that a new method uses it rather
    // than reaching for `#servers[0]` directly.
    pool = new NntpMultiPool({
      servers: [await provider('primary', { has: false }), await provider('backup')],
    });

    await expect(pool.head('a@b')).resolves.toMatchObject({ code: 221, server: 'backup' });
    await expect(pool.article('a@b')).resolves.toMatchObject({ code: 220, server: 'backup' });
  });

  it('returns the head and the article, not merely a status line', async () => {
    // A multi-line command whose body were dropped would still satisfy the
    // attribution assertions above.
    pool = new NntpMultiPool({ servers: [await provider('primary', { body: 'payload' })] });

    const head = await pool.head('a@b');
    const article = await pool.article('a@b');

    expect(head.body.toString('latin1')).toBe('Subject: fake\r\n');
    expect(article.body.toString('latin1')).toBe('Subject: fake\r\n\r\npayload\r\n');
  });
});
