import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderError } from '@chad3814/secret-provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PASSWORD_ENV,
  PASSWORD_FILE,
  USERNAME_ENV,
  credentialsFor,
  defaultPassword,
  providerFor,
} from '../src/credentials.ts';
import type { ServerSettings } from '../src/options.ts';

const SECRET = 'correct-horse-battery-staple';

let directory = '';

function settings(overrides: Partial<ServerSettings> = {}): ServerSettings {
  return {
    host: 'h',
    port: 563,
    security: 'implicit',
    connections: 1,
    user: null,
    password: null,
    credentialTtlMs: null,
    ...overrides,
  };
}

function resolve(value: string | (() => Promise<string>)): Promise<string> {
  return typeof value === 'string' ? Promise.resolve(value) : value();
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nzb-cred-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  delete process.env[PASSWORD_ENV];
  delete process.env[USERNAME_ENV];
});

describe('providerFor', () => {
  it('reads an environment variable', async () => {
    process.env[PASSWORD_ENV] = SECRET;

    await expect(providerFor({ env: PASSWORD_ENV })()).resolves.toBe(SECRET);
  });

  it('falls through when the variable is unset, so a chain can continue', async () => {
    const error = await providerFor({ env: PASSWORD_ENV })().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).tryNextLink).toBe(true);
  });

  it('reads a file, without the trailing newline an editor adds', async () => {
    const file = join(directory, 'secret');
    await writeFile(file, `${SECRET}\n`);

    await expect(providerFor({ file })()).resolves.toBe(SECRET);
  });

  it('falls through when the file is absent', async () => {
    const error = await providerFor({ file: join(directory, 'absent') })().catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ProviderError);
  });
});

describe('the default password chain', () => {
  it('prefers the environment variable', async () => {
    process.env[PASSWORD_ENV] = SECRET;

    await expect(defaultPassword()()).resolves.toBe(SECRET);
  });

  it('names every source it tried when none of them answer', async () => {
    // There is no terminal under vitest, so the prompt falls through too and
    // the chain runs out. The message is the whole diagnostic: it has to say
    // which three places were looked at.
    const error = await defaultPassword()().catch((caught: unknown) => caught);
    const message = (error as Error).message;

    expect(message).toContain(PASSWORD_ENV);
    expect(message).toContain(PASSWORD_FILE);
  });

  it('does not hang when there is no terminal to prompt on', async () => {
    // The reason a prompt is safe to have in a default: in CI, behind a pipe or
    // in a daemon it falls through rather than waiting forever on stdin.
    await expect(defaultPassword()()).rejects.toThrow(ProviderError);
  });
});

describe('credentialsFor', () => {
  it('uses the default chain when nothing is named', async () => {
    process.env[PASSWORD_ENV] = SECRET;

    await expect(resolve(credentialsFor(settings()).pass)).resolves.toBe(SECRET);
  });

  it('uses only the named source, ignoring the environment entirely', async () => {
    // Having said where the password is, falling back to somewhere else could
    // authenticate as an account the user did not choose.
    process.env[PASSWORD_ENV] = 'from-the-environment';
    const file = join(directory, 'chosen');
    await writeFile(file, SECRET);

    const credentials = credentialsFor(settings({ password: { file } }));

    await expect(resolve(credentials.pass)).resolves.toBe(SECRET);
  });

  it('fails rather than falling back when the named source is empty', async () => {
    process.env[PASSWORD_ENV] = 'from-the-environment';

    const credentials = credentialsFor(settings({ password: { env: 'NZB_TEST_UNSET' } }));

    await expect(resolve(credentials.pass)).rejects.toThrow(ProviderError);
  });

  it('passes a literal username straight through', () => {
    expect(credentialsFor(settings({ user: 'someone' })).user).toBe('someone');
  });

  it('resolves a username from the environment by default', async () => {
    process.env[USERNAME_ENV] = 'someone';

    await expect(resolve(credentialsFor(settings()).user)).resolves.toBe('someone');
  });

  it('never prompts for a username, which would be typed blind', async () => {
    // fromPrompt suppresses echo. Right for a secret, unusable for a name, so
    // the username chain stops at the file.
    const error = await resolve(credentialsFor(settings()).user).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(USERNAME_ENV);
    expect((error as Error).message).not.toContain('Username:');
  });
});
