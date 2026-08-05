import { describe, expect, it, vi } from 'vitest';
import type { Provider } from '@chad3814/secret-provider';

import { memoizeCredentials } from '../src/auth.ts';

const SECRET = 'horse-battery-staple-correct';

/** Counts resolutions so "how many trips to the vault?" is a plain assertion. */
function counting(value: string): { provider: Provider<string>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    provider: () => {
      calls += 1;
      return Promise.resolve(value);
    },
  };
}

describe('memoizeCredentials', () => {
  it('resolves a provider once however many times it is used', async () => {
    // The library's guidance: memoize once at the boundary, so a caller who
    // did not think about it does not get a vault round-trip per connection.
    const { provider, calls } = counting(SECRET);
    const credentials = memoizeCredentials({ user: 'someone', pass: provider });

    await Promise.all([credentials.pass(), credentials.pass(), credentials.pass()]);

    expect(calls()).toBe(1);
  });

  it('shares one in-flight resolution between concurrent callers', async () => {
    // Ten requests arriving at cold start must make one round-trip, not ten.
    // The provider suspends, so both callers really are in flight at once.
    let calls = 0;
    const credentials = memoizeCredentials({
      user: 'someone',
      pass: async () => {
        calls += 1;
        await Promise.resolve();
        return SECRET;
      },
    });

    await Promise.all([credentials.pass(), credentials.pass()]);

    expect(calls).toBe(1);
  });

  it('normalises a literal into a provider', async () => {
    const credentials = memoizeCredentials({ user: 'someone', pass: SECRET });

    await expect(credentials.user()).resolves.toBe('someone');
    await expect(credentials.pass()).resolves.toBe(SECRET);
  });

  it('re-resolves once the credential has outlived its ttl', async () => {
    // A vault credential has a lifetime. Caching it forever means the pool is
    // still presenting an expired token hours later, and the failure looks like
    // a wrong password rather than a stale one.
    vi.useFakeTimers();
    try {
      const { provider, calls } = counting(SECRET);
      const credentials = memoizeCredentials({ user: 'someone', pass: provider }, 60_000);

      await credentials.pass();
      vi.advanceTimersByTime(59_000);
      await credentials.pass();
      expect(calls()).toBe(1);

      vi.advanceTimersByTime(2_000);
      await credentials.pass();
      expect(calls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the ttl when the value arrives, not when it was asked for', async () => {
    // A vault that takes three seconds to answer must not spend three seconds
    // of a five-second lifetime before the credential is even in hand.
    vi.useFakeTimers();
    try {
      let calls = 0;
      const credentials = memoizeCredentials(
        {
          user: 'someone',
          pass: async () => {
            calls += 1;
            await vi.advanceTimersByTimeAsync(3_000);
            return SECRET;
          },
        },
        5_000,
      );

      await credentials.pass();
      await vi.advanceTimersByTimeAsync(4_000);
      await credentials.pass();

      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches forever when no ttl is given', async () => {
    vi.useFakeTimers();
    try {
      const { provider, calls } = counting(SECRET);
      const credentials = memoizeCredentials({ user: 'someone', pass: provider });

      await credentials.pass();
      vi.advanceTimersByTime(86_400_000);
      await credentials.pass();

      expect(calls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache a rejection, so a failed lookup stays retryable', async () => {
    let calls = 0;
    const credentials = memoizeCredentials({
      user: 'someone',
      pass: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('vault down')) : Promise.resolve(SECRET);
      },
    });

    await expect(credentials.pass()).rejects.toThrow('vault down');
    await expect(credentials.pass()).resolves.toBe(SECRET);
  });
});
