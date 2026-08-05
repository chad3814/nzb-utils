import { afterEach, describe, expect, it } from 'vitest';
import { chain, fromEnv, fromStatic, memoize, ProviderError } from '@chad3814/secret-provider';

import { NntpClient } from '../src/client.ts';
import { NntpPool } from '../src/pool.ts';
import { startFakeServer } from './fake-server.ts';
import type { FakeServer } from './fake-server.ts';

/**
 * Authenticating from `@chad3814/secret-provider`-shaped providers.
 *
 * These run against the real package rather than a hand-rolled thunk, so the
 * structural `NntpSecret` type is proven compatible with the thing it exists to
 * accept — the dependency is dev-only and no runtime dependency is added.
 */

const USER = 'someone';
const PASSWORD = 'correct-horse-battery-staple';

let server: FakeServer | null = null;
let client: NntpClient | null = null;
let pool: NntpPool | null = null;

afterEach(async () => {
  client?.destroy();
  client = null;
  pool?.destroy();
  pool = null;
  await server?.close();
  server = null;
});

function respond(command: string): string | null {
  if (command.startsWith('AUTHINFO USER')) {
    return command === `AUTHINFO USER ${USER}`
      ? '381 password required\r\n'
      : '481 unknown user\r\n';
  }
  if (command === `AUTHINFO PASS ${PASSWORD}`) {
    return '281 authentication accepted\r\n';
  }
  if (command.startsWith('AUTHINFO PASS')) {
    return '481 authentication rejected\r\n';
  }
  if (command.startsWith('BODY')) {
    return '222 0 <a@b> body follows\r\nhello\r\n.\r\n';
  }
  if (command === 'QUIT') {
    return '205 closing\r\n';
  }
  return '500 unknown command\r\n';
}

/** A server that accepts the bare username and never asks for a password. */
function acceptsBareUser(command: string): string | null {
  if (command.startsWith('AUTHINFO USER')) {
    return '281 authentication accepted\r\n';
  }
  return '500 unknown command\r\n';
}

async function connect(
  responder: (command: string) => string | null = respond,
): Promise<NntpClient> {
  server = await startFakeServer({ respond: responder });
  client = new NntpClient({ host: '127.0.0.1', port: server.port, security: 'none' });
  await client.connect();
  return client;
}

describe('authenticating from providers', () => {
  it('resolves both fields from providers', async () => {
    const nntp = await connect();

    const response = await nntp.authenticate({
      user: fromStatic(USER),
      pass: fromStatic(PASSWORD),
    });

    expect(response.code).toBe(281);
    expect(server?.commands).toContain(`AUTHINFO USER ${USER}`);
    expect(server?.commands).toContain(`AUTHINFO PASS ${PASSWORD}`);
  });

  it('accepts a literal and a provider side by side', async () => {
    const nntp = await connect();

    const response = await nntp.authenticate({ user: USER, pass: fromStatic(PASSWORD) });

    expect(response.code).toBe(281);
  });

  it('resolves a memoized chain that falls through to a later link', async () => {
    const nntp = await connect();
    const pass = memoize(chain(fromEnv('NNTP_TEST_UNSET_VARIABLE'), fromStatic(PASSWORD)));

    await expect(nntp.authenticate({ user: USER, pass })).resolves.toMatchObject({ code: 281 });
  });

  it('does not resolve anything until authenticate is called', async () => {
    // The reason to take a provider at all: nothing is fetched by constructing
    // a client, so a config object can name a vault the process may never read.
    let calls = 0;
    const pass = (): Promise<string> => {
      calls += 1;
      return Promise.resolve(PASSWORD);
    };

    const nntp = await connect();
    expect(calls).toBe(0);

    await nntp.authenticate({ user: USER, pass });
    expect(calls).toBe(1);
  });

  it('does not resolve the password when the server accepts a bare username', async () => {
    // Some servers answer 281 to AUTHINFO USER alone. Resolving the password
    // anyway would make a vault round-trip for a secret that is never sent.
    let calls = 0;
    const pass = (): Promise<string> => {
      calls += 1;
      return Promise.resolve(PASSWORD);
    };

    const nntp = await connect(acceptsBareUser);
    await nntp.authenticate({ user: USER, pass });

    expect(calls).toBe(0);
  });

  it("surfaces the chain's own ProviderError when nothing resolves", async () => {
    // Not wrapped in an NntpCredentialError: tryNextLink and the aggregated
    // source list are the diagnosable part, and a wrapper would bury both.
    const nntp = await connect();
    const pass = chain(fromEnv('NNTP_TEST_UNSET_VARIABLE'), fromEnv('NNTP_TEST_ALSO_UNSET'));

    await expect(nntp.authenticate({ user: USER, pass })).rejects.toBeInstanceOf(ProviderError);
  });

  it('names every source the chain tried', async () => {
    // What the aggregation in chain() is for: "which of my four sources was
    // supposed to have this?" is the question a failed lookup has to answer.
    // It is also what identifies the failing credential, since the variables
    // are named.
    const nntp = await connect();
    const pass = chain(fromEnv('NNTP_TEST_UNSET_VARIABLE'), fromEnv('NNTP_TEST_ALSO_UNSET'));

    const error = await nntp.authenticate({ user: USER, pass }).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('NNTP_TEST_UNSET_VARIABLE');
    expect((error as Error).message).toContain('NNTP_TEST_ALSO_UNSET');
  });

  it('sends no AUTHINFO at all when the username provider fails', async () => {
    const nntp = await connect();

    await expect(
      nntp.authenticate({ user: fromEnv('NNTP_TEST_UNSET_VARIABLE'), pass: PASSWORD }),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(server?.commands.filter((c) => c.startsWith('AUTHINFO'))).toEqual([]);
  });

  it('refuses a provider whose value would inject a second command', async () => {
    const nntp = await connect();
    const pass = fromStatic(`${PASSWORD}\r\nAUTHINFO USER attacker`);

    await expect(nntp.authenticate({ user: USER, pass })).rejects.toThrow(/line break/u);
    expect(server?.commands).not.toContain('AUTHINFO USER attacker');
  });

  it('keeps a resolved secret out of the failure it reports', async () => {
    const nntp = await connect();
    const pass = fromStatic(`${PASSWORD}\r\nAUTHINFO USER attacker`);

    const error = await nntp.authenticate({ user: USER, pass }).catch((caught: unknown) => caught);

    const serialized = `${String(error)}${JSON.stringify(error)}${String(
      error instanceof Error ? error.stack : '',
    )}`;
    expect(serialized).not.toContain(PASSWORD);
  });
});

describe('NntpPool with providers', () => {
  it('authenticates a pooled connection from providers', async () => {
    server = await startFakeServer({ respond });
    pool = new NntpPool({
      endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
      credentials: { user: fromStatic(USER), pass: fromStatic(PASSWORD) },
      connections: 1,
    });

    const { body } = await pool.body('a@b');

    expect(body.toString('latin1')).toBe('hello\r\n');
    expect(server.commands).toContain(`AUTHINFO PASS ${PASSWORD}`);
  });

  it('resolves once for the whole pool, not once per connection', async () => {
    // The pool memoizes at its boundary, so a caller who passed an `op read`
    // subprocess does not get one spawn per connection.
    let calls = 0;
    const pass = (): Promise<string> => {
      calls += 1;
      return Promise.resolve(PASSWORD);
    };

    server = await startFakeServer({ respond });
    pool = new NntpPool({
      endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
      credentials: { user: USER, pass },
      connections: 2,
    });

    await Promise.all([pool.body('a@b'), pool.body('c@d')]);

    expect(calls).toBe(1);
  });

  it('re-resolves for a connection opened after the credential expires', async () => {
    // A pool outliving its token must not keep presenting the expired one.
    let calls = 0;
    const pass = (): Promise<string> => {
      calls += 1;
      return Promise.resolve(PASSWORD);
    };

    server = await startFakeServer({ respond });
    pool = new NntpPool({
      endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
      credentials: { user: USER, pass },
      credentialTtlMs: 0,
      connections: 2,
    });

    await Promise.all([pool.body('a@b'), pool.body('c@d')]);

    expect(calls).toBe(2);
  });

  it('keeps providers out of the enumerable surface of the pool', async () => {
    server = await startFakeServer({ respond });
    pool = new NntpPool({
      endpoint: { host: '127.0.0.1', port: server.port, security: 'none' },
      credentials: { user: USER, pass: fromStatic(PASSWORD) },
      connections: 1,
    });

    await pool.body('a@b');

    expect(JSON.stringify(pool)).not.toContain(PASSWORD);
  });
});
