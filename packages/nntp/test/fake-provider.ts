import { startFakeServer } from './fake-server.ts';
import type { FakeServer } from './fake-server.ts';
import type { NntpServerOptions } from '../src/multi-pool-models.ts';

/**
 * A fake provider.
 *
 * `logins` is how many AUTHINFO exchanges it accepts before answering 502,
 * which is how a provider reports its simultaneous-connection cap. `has: false`
 * makes it answer 430, which is a retained-article question, not a capacity one.
 * `capacityReason` overrides the 502 text — tests that run two saturated fakes
 * side by side need distinct text to tell, from the outside, which server's
 * refusal actually surfaced.
 */
export interface FakeOptions {
  readonly logins?: number;
  readonly has?: boolean;
  readonly refuseAuth?: boolean;
  readonly body?: string;
  readonly capacityReason?: string;
}

export function articleServer(options: FakeOptions = {}): (command: string) => string | null {
  const allowed = options.logins ?? Number.POSITIVE_INFINITY;
  const has = options.has ?? true;
  const payload = options.body ?? 'hello';
  const capacityReason = options.capacityReason ?? 'Too many connections.';
  let logins = 0;

  return (command: string): string | null => {
    if (command.startsWith('AUTHINFO')) {
      if (options.refuseAuth === true) {
        return '481 authentication rejected\r\n';
      }
      if (command.startsWith('AUTHINFO PASS')) {
        return '281 authentication accepted\r\n';
      }
      logins += 1;
      return logins > allowed ? `502 ${capacityReason}\r\n` : '381 password required\r\n';
    }
    if (command.startsWith('BODY') || command.startsWith('ARTICLE') || command.startsWith('HEAD')) {
      return has ? `222 0 <a@b> body follows\r\n${payload}\r\n.\r\n` : '430 No Such Article\r\n';
    }
    if (command.startsWith('STAT')) {
      return has ? '223 0 <a@b>\r\n' : '430 No Such Article\r\n';
    }
    if (command === 'QUIT') {
      return '205 closing\r\n';
    }
    return '500 unknown command\r\n';
  };
}

/**
 * Start a fake provider and return the options that point a pool at it,
 * alongside the fake server itself.
 *
 * Returning the server rather than closing over a shared collector keeps this
 * module stateless: each test file owns the lifetime of the servers it starts
 * and is free to choose its own cleanup strategy (an `afterEach` that drains
 * an array, in the callers this has today).
 */
export async function provider(
  name: string,
  options: FakeOptions = {},
  extra: Partial<NntpServerOptions> = {},
): Promise<{ options: NntpServerOptions; server: FakeServer }> {
  const fake = await startFakeServer({ respond: articleServer(options) });
  return {
    server: fake,
    options: {
      name,
      endpoint: { host: '127.0.0.1', port: fake.port, security: 'none' },
      credentials: { user: 'someone', pass: 'secret' },
      connections: 2,
      ...extra,
    },
  };
}
