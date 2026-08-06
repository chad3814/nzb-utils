import { chain, fromEnv, fromFile, fromPrompt } from '@chad3814/secret-provider';
import type { Provider } from '@chad3814/secret-provider';
import type { NntpCredentials } from '@chad3814/nntp';

import type { SecretRef, ServerSettings } from './options.ts';

/**
 * Turning credential *references* into providers.
 *
 * Nothing here ever holds a secret. A reference names where to look; the
 * provider goes and looks at the moment `@chad3814/nntp` needs it, and the pool
 * memoizes the result. The secret's only path is source → provider → one
 * `AUTHINFO` command.
 *
 * There is no "run this command" source. Spawning a program named by a config
 * file buys a convenience `op run -- nzb …` already provides, at the cost of
 * turning "someone can write my config" into "someone can run code as me".
 * Vault access belongs in dedicated provider packages.
 */

/** Where the default chain looks for a password, in order. */
export const PASSWORD_ENV = 'NNTP_PASSWORD';
export const PASSWORD_FILE = '/run/secret/nntp_password';

/** And for a username, which is not a secret but is equally worth not retyping. */
export const USERNAME_ENV = 'NNTP_USERNAME';
export const USERNAME_FILE = '/run/secret/nntp_username';

/**
 * The default password source: environment, then secret mount, then ask.
 *
 * Ordered by how deliberate each one is. An environment variable is what a
 * `op run --` wrapper or a systemd unit sets. `/run/secret/nntp_password` is
 * where Docker and Kubernetes mount one. The prompt is the interactive last
 * resort, and it is a genuine fallback rather than a hang: `fromPrompt` falls
 * through when there is no terminal, so this same chain is correct in CI,
 * behind a pipe, and in a daemon, where it simply fails with all three sources
 * named.
 *
 * The prompt is asked at most once per run, because `NntpPool` memoizes at its
 * boundary. Setting `credentialTtlMs` will make it ask again when the cached
 * value expires, which is the right behaviour for a rotating credential and a
 * surprising one for a typed password — so do not set both.
 */
export function defaultPassword(): Provider<string> {
  return chain(fromEnv(PASSWORD_ENV), fromFile(PASSWORD_FILE), fromPrompt('NNTP Password: '));
}

/**
 * The default username source.
 *
 * No prompt: `fromPrompt` suppresses echo, which is right for a secret and
 * wrong for a username — typing one blind is worse than being told which
 * variable to set.
 */
export function defaultUsername(): Provider<string> {
  return chain(fromEnv(USERNAME_ENV), fromFile(USERNAME_FILE));
}

export function providerFor(ref: SecretRef): Provider<string> {
  return 'env' in ref ? fromEnv(ref.env) : fromFile(ref.file);
}

/**
 * Build the credentials `@chad3814/nntp` takes.
 *
 * A named source *replaces* the default chain rather than joining it: someone
 * who writes `--pass-file /run/secret/other` has said where the password is,
 * and silently falling back to an environment variable or a prompt could
 * authenticate as an account they did not choose.
 *
 * A literal username stays a literal — it is not a secret, and routing it
 * through a provider would only obscure it in a stack trace.
 */
export function credentialsFor(server: ServerSettings): NntpCredentials {
  return {
    user: username(server.user),
    pass: server.password === null ? defaultPassword() : providerFor(server.password),
  };
}

function username(user: ServerSettings['user']): string | Provider<string> {
  if (user === null) {
    return defaultUsername();
  }
  return typeof user === 'string' ? user : providerFor(user);
}
