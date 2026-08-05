import { fromStatic, memoize } from '@chad3814/secret-provider';
import type { Provider } from '@chad3814/secret-provider';

import { NntpAuthError, NntpCredentialError } from './errors.ts';
import { NNTP_STATUS } from './models.ts';
import type { NntpCredentials, NntpResponse, NntpSecret } from './models.ts';

/**
 * Obtaining a credential and spending it on an `AUTHINFO` exchange.
 *
 * Socket-free, like `ResponseBuffer`: {@link runAuthInfo} takes a callback that
 * sends a command line and returns a parsed response, so the whole exchange —
 * which server codes mean what, when the password is needed, what never reaches
 * an error — is testable without a network.
 */

/** Sends one command line and parses the reply. `label` is what errors report. */
export type SendCommand = (line: string, label: string) => Promise<NntpResponse>;

/** Both credentials as providers, ready to resolve at each point of use. */
export interface CredentialProviders {
  readonly user: Provider<string>;
  readonly pass: Provider<string>;
}

/**
 * Normalise credentials at the boundary and memoize them once, as
 * `@chad3814/secret-provider` prescribes for a library that accepts a provider.
 *
 * Doing it here rather than leaving it to the caller is the difference between a
 * pool of eight connections making one trip to the vault and making eight. A
 * caller who did not think about memoization should not be punished with a
 * subprocess spawn per connection.
 *
 * The cost is honest and worth stating: a memoized provider holds the resolved
 * credential in its closure. That is a real retention, not a thunk — which is
 * why `ttlMs` exists.
 *
 * @param ttlMs Re-resolve once a cached credential is this old. Vault-issued
 *   credentials have lifetimes, and caching one forever means presenting an
 *   expired token hours later, where the failure looks like a wrong password
 *   rather than a stale one. Omit for no expiry, matching `memoize`'s default.
 */
export function memoizeCredentials(
  credentials: NntpCredentials,
  ttlMs?: number,
): CredentialProviders {
  return {
    user: cache(toProvider(credentials.user), ttlMs),
    pass: cache(toProvider(credentials.pass), ttlMs),
  };
}

function toProvider(secret: NntpSecret): Provider<string> {
  return typeof secret === 'string' ? fromStatic(secret) : secret;
}

function cache(provider: Provider<string>, ttlMs: number | undefined): Provider<string> {
  if (ttlMs === undefined) {
    return memoize(provider);
  }

  // `isExpired` only sees the value, and a credential string carries no expiry
  // of its own, so the clock is kept here. Stamped after the await, not before:
  // a vault that takes three seconds to answer must not spend three seconds of
  // a five-second lifetime before the credential is even in hand.
  let resolvedAt = 0;

  return memoize(
    async () => {
      const value = await provider();
      resolvedAt = Date.now();
      return value;
    },
    () => Date.now() - resolvedAt >= ttlMs,
  );
}

/**
 * The `AUTHINFO USER` / `AUTHINFO PASS` exchange (RFC 4643).
 *
 * The password is resolved only after the server has asked for one. Some
 * servers answer `281` to the username alone, and making a vault round-trip for
 * a secret that will not be sent is both slow and an unnecessary moment for a
 * credential to exist in memory.
 */
export async function runAuthInfo(
  credentials: NntpCredentials,
  send: SendCommand,
): Promise<NntpResponse> {
  // Built inline, so the secret exists only as an argument and the redacted
  // label is what any error or timeout reports.
  const user = await send(
    `AUTHINFO USER ${await resolveSecret(credentials.user, 'username')}`,
    'AUTHINFO USER',
  );

  if (user.code === NNTP_STATUS.authenticationAccepted) {
    return user;
  }
  if (user.code !== NNTP_STATUS.passwordRequired) {
    throw new NntpAuthError(user.code, user.message);
  }

  const pass = await send(
    `AUTHINFO PASS ${await resolveSecret(credentials.pass, 'password')}`,
    'AUTHINFO PASS',
  );
  if (pass.code !== NNTP_STATUS.authenticationAccepted) {
    throw new NntpAuthError(pass.code, pass.message);
  }

  return pass;
}

/**
 * Turn an {@link NntpSecret} into the string that goes on the wire.
 *
 * A provider's rejection is **not** caught. Wrapping it would throw away
 * `ProviderError.tryNextLink` and, from a chain, the aggregated list of every
 * source that was tried and why it did not answer — which is the part that makes
 * a misconfiguration diagnosable, and is also what identifies which credential
 * failed, since the list names the variables and paths involved.
 *
 * This does not cache. Caching belongs at the boundary, once, in
 * {@link memoizeCredentials} — a resolved secret here lives as a local for the
 * length of one command and is never written to a field.
 */
export async function resolveSecret(secret: NntpSecret, label: string): Promise<string> {
  return check(typeof secret === 'string' ? secret : await secret(), label);
}

/**
 * Reject anything that cannot safely be interpolated into a command.
 *
 * The line-break check is the load-bearing one. `AUTHINFO PASS ${secret}` is
 * built by interpolation, so a credential carrying CR or LF does not merely
 * fail to authenticate — it terminates the line early and appends whatever
 * follows as a second NNTP command. A literal in source is unlikely to contain
 * one; a value read from a file, an environment variable or a subprocess is
 * exactly where a stray newline comes from, which is why this arrived alongside
 * provider support.
 *
 * Takes `unknown` rather than `string` on purpose: the type says a provider
 * returns a string, but nothing stops an untyped caller returning an object,
 * and interpolating one would send `[object Object]` as the password.
 */
function check(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new NntpCredentialError(`the ${label} resolved to a ${typeof value}, not a string`);
  }
  if (value === '') {
    throw new NntpCredentialError(`the ${label} resolved to an empty string`);
  }
  if (/[\r\n]/u.test(value)) {
    throw new NntpCredentialError(
      `the ${label} contains a line break, which would inject a second NNTP command`,
    );
  }
  return value;
}
