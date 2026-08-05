import { describe, expect, it } from 'vitest';
import { chain, fromEnv, fromStatic, memoize, ProviderError } from '@chad3814/secret-provider';

import { NntpAuthError, NntpCredentialError } from '../src/errors.ts';
import { resolveSecret, runAuthInfo } from '../src/auth.ts';
import type { NntpResponse } from '../src/models.ts';

const SECRET = 'horse-battery-staple-correct';

describe('resolveSecret', () => {
  it('passes a literal through', async () => {
    await expect(resolveSecret(SECRET, 'password')).resolves.toBe(SECRET);
  });

  it('awaits a provider', async () => {
    await expect(resolveSecret(() => Promise.resolve(SECRET), 'password')).resolves.toBe(SECRET);
  });

  it('accepts a real @chad3814/secret-provider provider', async () => {
    // The point of the structural type: a Provider<string> is just an async
    // thunk, so it satisfies NntpSecret without this package depending on it.
    await expect(resolveSecret(fromStatic(SECRET), 'password')).resolves.toBe(SECRET);
  });

  it('accepts a memoized chain', async () => {
    const provider = memoize(chain(fromEnv('NNTP_TEST_UNSET_VARIABLE'), fromStatic(SECRET)));

    await expect(resolveSecret(provider, 'password')).resolves.toBe(SECRET);
  });

  it('resolves the provider once per call and does not cache on its behalf', async () => {
    // Caching a secret in this package would retain it beyond the caller's
    // control. memoize() is the caller's decision to make.
    let calls = 0;
    const provider = (): Promise<string> => {
      calls += 1;
      return Promise.resolve(SECRET);
    };

    await resolveSecret(provider, 'password');
    await resolveSecret(provider, 'password');

    expect(calls).toBe(2);
  });

  it('rejects an empty literal', async () => {
    await expect(resolveSecret('', 'password')).rejects.toThrow(NntpCredentialError);
  });

  it('rejects a provider that resolves to an empty string', async () => {
    await expect(resolveSecret(fromStatic(''), 'password')).rejects.toThrow(NntpCredentialError);
  });

  it('rejects a value containing CRLF, which would inject a second command', async () => {
    // AUTHINFO PASS is built by interpolation, so a credential carrying a line
    // break appends an arbitrary command to the session. A provider reading
    // from a file or a subprocess is exactly where a stray newline arrives.
    const injected = `${SECRET}\r\nAUTHINFO USER someone-else`;

    await expect(resolveSecret(injected, 'password')).rejects.toThrow(/line break/u);
    await expect(resolveSecret(fromStatic(injected), 'password')).rejects.toThrow(/line break/u);
  });

  it('rejects a bare LF as well as a full CRLF', async () => {
    await expect(resolveSecret(`${SECRET}\nDATA`, 'password')).rejects.toThrow(NntpCredentialError);
  });

  it('rejects a trailing CR on its own', async () => {
    await expect(resolveSecret(`${SECRET}\r`, 'username')).rejects.toThrow(NntpCredentialError);
  });

  it('lets a ProviderError through untouched', async () => {
    // Wrapping it would destroy the two things that make a misconfiguration
    // diagnosable: `tryNextLink`, and the list of every source a chain tried.
    // The source names in that list are also what say which credential failed.
    const reason = new ProviderError('no provider resolved a value (NNTP_PASS not set)', false);

    const error = await resolveSecret(() => Promise.reject(reason), 'password').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBe(reason);
    expect((error as ProviderError).tryNextLink).toBe(false);
  });

  it('lets an ordinary provider rejection through too', async () => {
    const reason = new Error('the vault is unreachable');

    await expect(resolveSecret(() => Promise.reject(reason), 'username')).rejects.toBe(reason);
  });

  it('rejects a provider that resolves to something that is not a string', async () => {
    // Untyped JavaScript callers exist, and interpolating an object into a
    // command line would send "[object Object]" as the password.
    const provider = (): Promise<string> =>
      Promise.resolve({ toString: () => SECRET } as unknown as string);

    await expect(resolveSecret(provider, 'password')).rejects.toThrow(NntpCredentialError);
  });

  it('never puts the value in the error it throws', async () => {
    const injected = `${SECRET}\r\nAUTHINFO USER someone-else`;

    const error = await resolveSecret(injected, 'password').catch((caught: unknown) => caught);

    const serialized = `${String(error)}${JSON.stringify(error)}${String(
      error instanceof Error ? error.stack : '',
    )}`;
    expect(serialized).not.toContain(SECRET);
  });
});

/** Records the command lines an exchange produces, and replies by script. */
function recorder(replies: readonly NntpResponse[]): {
  send: (line: string, label: string) => Promise<NntpResponse>;
  lines: string[];
} {
  const lines: string[] = [];
  let index = 0;

  return {
    lines,
    send: (line: string): Promise<NntpResponse> => {
      lines.push(line);
      const reply = replies[index];
      index += 1;
      if (reply === undefined) {
        throw new Error(`unscripted command: ${line}`);
      }
      return Promise.resolve(reply);
    },
  };
}

const NEEDS_PASSWORD: NntpResponse = { code: 381, message: 'password required' };
const ACCEPTED: NntpResponse = { code: 281, message: 'authentication accepted' };
const REJECTED: NntpResponse = { code: 481, message: 'authentication rejected' };

describe('runAuthInfo', () => {
  it('sends USER then PASS and returns the accepting response', async () => {
    const { send, lines } = recorder([NEEDS_PASSWORD, ACCEPTED]);

    const response = await runAuthInfo({ user: 'someone', pass: SECRET }, send);

    expect(lines).toEqual(['AUTHINFO USER someone', `AUTHINFO PASS ${SECRET}`]);
    expect(response).toBe(ACCEPTED);
  });

  it('stops after the username when the server accepts it outright', async () => {
    const { send, lines } = recorder([ACCEPTED]);

    await runAuthInfo({ user: 'someone', pass: SECRET }, send);

    expect(lines).toEqual(['AUTHINFO USER someone']);
  });

  it('does not resolve the password when it is never asked for', async () => {
    // A vault round-trip for a secret that will not be sent is both slow and an
    // avoidable moment for the credential to exist at all.
    const { send } = recorder([ACCEPTED]);
    let resolved = false;

    await runAuthInfo(
      {
        user: 'someone',
        pass: () => {
          resolved = true;
          return Promise.resolve(SECRET);
        },
      },
      send,
    );

    expect(resolved).toBe(false);
  });

  it('throws NntpAuthError when the username is refused', async () => {
    const { send } = recorder([REJECTED]);

    await expect(runAuthInfo({ user: 'someone', pass: SECRET }, send)).rejects.toThrow(
      NntpAuthError,
    );
  });

  it('throws NntpAuthError when the password is refused', async () => {
    const { send } = recorder([NEEDS_PASSWORD, REJECTED]);

    await expect(runAuthInfo({ user: 'someone', pass: SECRET }, send)).rejects.toThrow(
      NntpAuthError,
    );
  });

  it('sends nothing when the username cannot be resolved', async () => {
    const { send, lines } = recorder([ACCEPTED]);
    const reason = new Error('no source');

    await expect(
      runAuthInfo({ user: () => Promise.reject(reason), pass: SECRET }, send),
    ).rejects.toBe(reason);
    expect(lines).toEqual([]);
  });

  it('sends no password when the password cannot be resolved', async () => {
    const { send, lines } = recorder([NEEDS_PASSWORD, ACCEPTED]);
    const reason = new Error('no source');

    await expect(
      runAuthInfo({ user: 'someone', pass: () => Promise.reject(reason) }, send),
    ).rejects.toBe(reason);
    expect(lines).toEqual(['AUTHINFO USER someone']);
  });

  it('labels each command without its argument, so errors stay clean', async () => {
    const labels: string[] = [];
    const replies = [NEEDS_PASSWORD, ACCEPTED];
    let index = 0;

    await runAuthInfo({ user: 'someone', pass: SECRET }, (_line, label) => {
      labels.push(label);
      const reply = replies[index];
      index += 1;
      return Promise.resolve(reply ?? ACCEPTED);
    });

    expect(labels).toEqual(['AUTHINFO USER', 'AUTHINFO PASS']);
    expect(labels.join(' ')).not.toContain(SECRET);
  });
});
