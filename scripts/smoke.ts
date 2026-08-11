#!/usr/bin/env node
/**
 * Live smoke test: a real NZB, a real provider, real articles.
 *
 * Not part of `npm run check` — it needs credentials, a network, and an NZB
 * whose articles are still retained, none of which belong in CI. Run it by
 * hand when the fetch path changes.
 *
 *   npm run build
 *   op run --env-file=smoke.env -- node scripts/smoke.ts path/to/file.nzb
 *
 * where `smoke.env` (keep it out of the repo) reads:
 *
 *   NNTP_HOST=news.example.com
 *   NNTP_PORT=563
 *   NNTP_USER=op://Private/Provider/username
 *   NNTP_PASS=op://Private/Provider/password
 *
 * Optional: NNTP_SECURITY (implicit by default), NNTP_CONNECTIONS (4), and
 * NNTP_PROBE_CAP=1 to add a check that deliberately saturates the account's
 * connection limit. Leave the last one off unless that is what you are
 * testing -- it opens as many connections as NNTP_CONNECTIONS asks for.
 *
 * Optional second provider, for proving the fill-the-gap path against a real
 * expired article: NNTP2_HOST, NNTP2_PORT, NNTP2_USER, NNTP2_PASS, and
 * optionally NNTP2_SECURITY (implicit by default) and NNTP2_CONNECTIONS (4).
 * Present only when NNTP2_HOST is set -- most runs have one account, and a
 * second is a real purchase.
 *
 * Credentials must arrive this way — injected into the environment by `op run`
 * — so they never enter a file, a transcript, or a shell history. As a backstop
 * every line of output goes through `scrub()`: if a credential ever did reach
 * an error message, the report would say so instead of printing it.
 */
import { readFile } from 'node:fs/promises';

import { NntpMultiPool, NntpPool } from '@chad3814/nntp';
import type { NntpEndpoint, NntpServerOptions } from '@chad3814/nntp';
import { parseNzb } from '@chad3814/nzb-parser';
import { openNzbFile } from '@chad3814/nzb';
import { fromEnv } from '@chad3814/secret-provider';

import {
  boundaryJoin,
  describeGeometry,
  emptySlice,
  headSlice,
  mib,
  nestedClamp,
  placement,
  readWhole,
  retention,
  tailSlice,
} from './checks.ts';
import { capacity, fillsTheGap } from './server-checks.ts';

const PREVIEW = 4 * 1024 * 1024;

const SECRETS = ['NNTP_PASS', 'NNTP_USER', 'NNTP2_PASS', 'NNTP2_USER']
  .map((name) => process.env[name])
  .filter((value): value is string => value !== undefined && value.length > 3);

function scrub(text: string): string {
  return SECRETS.reduce((out, secret) => out.split(secret).join('[REDACTED-CREDENTIAL]'), text);
}

function say(line = ''): void {
  console.log(scrub(line));
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; see the header of this file for how to supply it`);
  }
  return value;
}

/**
 * Shared by `endpoint()` and `secondServer()`, so the primary and the second
 * provider validate `*_SECURITY` the same way instead of drifting apart as
 * one gets edited and the other does not.
 */
function security(envVar: string): 'implicit' | 'starttls' | 'none' {
  const value = process.env[envVar] ?? 'implicit';
  if (value !== 'implicit' && value !== 'starttls' && value !== 'none') {
    throw new Error(`${envVar} must be implicit, starttls or none; got ${value}`);
  }
  return value;
}

function endpoint(): NntpEndpoint {
  return {
    host: required('NNTP_HOST'),
    port: Number(required('NNTP_PORT')),
    security: security('NNTP_SECURITY'),
  };
}

/**
 * The optional second provider.
 *
 * Present only when NNTP2_HOST is set. Opt-in in the same spirit as
 * NNTP_PROBE_CAP: most runs have one account, and a second one is a real
 * purchase.
 */
function secondServer(): NntpServerOptions | null {
  const host = process.env['NNTP2_HOST'];
  if (host === undefined || host === '') {
    return null;
  }

  return {
    name: host,
    endpoint: { host, port: Number(required('NNTP2_PORT')), security: security('NNTP2_SECURITY') },
    credentials: { user: fromEnv('NNTP2_USER'), pass: fromEnv('NNTP2_PASS') },
    connections: Number(process.env['NNTP2_CONNECTIONS'] ?? '4'),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

let failures = 0;

async function check(label: string, run: () => Promise<string> | string): Promise<void> {
  const started = performance.now();
  try {
    const note = await run();
    say(`  ok    ${label.padEnd(34)}  ${note}  [${(performance.now() - started).toFixed(0)} ms]`);
  } catch (error) {
    failures += 1;
    say(`  FAIL  ${label.padEnd(34)}  ${describe(error)}`);
  }
}

const path = process.argv[2];
if (path === undefined) {
  say('usage: node scripts/smoke.ts <path-to.nzb>');
  process.exit(2);
}

const nzb = parseNzb(await readFile(path, 'utf8'));
const segments = nzb.files.reduce((total, file) => total + file.segments.length, 0);
const encoded = nzb.files.reduce((total, file) => total + file.totalEncodedBytes, 0);

say(
  `NZB: ${String(nzb.files.length)} files, ${String(segments)} segments, ${mib(encoded)} encoded`,
);
say(`groups: ${nzb.groups.join(', ')}`);

function connectionCount(): number {
  return Number(process.env['NNTP_CONNECTIONS'] ?? '4');
}

/**
 * The primary, reshaped as a server entry.
 *
 * Reused both for the top-level `pool` below and for the `NntpMultiPool` the
 * second-provider check builds, so the primary's credentials, endpoint and
 * connection count are defined in exactly one place.
 */
function primaryServer(): NntpServerOptions {
  const host = endpoint();
  return {
    name: host.host,
    endpoint: host,
    credentials: { user: fromEnv('NNTP_USER'), pass: fromEnv('NNTP_PASS') },
    connections: connectionCount(),
  };
}

// `name` is dropped rather than spread through: it belongs to
// NntpServerOptions, and NntpPool has no such option. Passing it is inert, but
// it reads as though a lone pool were named, which it is not.
const { name: _poolName, ...primaryPool } = primaryServer();

const pool = new NntpPool({
  // Providers rather than literals, which is what the credential path is built
  // for: nothing is read until a connection is actually opened. No memoize()
  // here on purpose — the pool normalises and memoizes at its own boundary, and
  // this harness exists partly to check that it does.
  ...primaryPool,
  timeoutMs: 30_000,
});

try {
  say('\n-- retention (STAT, no body transferred) --');
  for (const row of await retention(nzb, pool)) {
    say(row);
  }

  // Single-segment posts have no =ypart line at all, which is the case
  // nzb-file@1.1.18 throws a TypeError on.
  const single = nzb.files.filter((file) => file.segments.length === 1);
  say(`\n-- ${String(single.length)} single-segment files (no =ypart line) --`);
  for (const file of single) {
    await check(file.subjectHints.name ?? '(unnamed)', () => readWhole(file, pool));
  }

  const largest = nzb.files.toSorted((a, b) => b.totalEncodedBytes - a.totalEncodedBytes)[0];
  if (largest === undefined) {
    throw new Error('the NZB lists no files');
  }

  say(`\n-- largest file: ${String(largest.segments.length)} articles --`);
  const handle = await openNzbFile(largest, pool);

  await check('geometry from one article', () => describeGeometry(handle, largest));
  await check('placement across the span', () => placement(largest, pool, handle));
  await check('slice(0, 0) fetches nothing', () => emptySlice(handle, pool));
  await check('head 4 MiB', () => headSlice(handle, PREVIEW));
  await check('tail 4 MiB', () => tailSlice(handle, PREVIEW));
  await check('nested slice clamps to parent', () => nestedClamp(handle));

  if (largest.segments.length >= 3) {
    await check('join across a segment boundary', () => boundaryJoin(largest, pool, handle));
  }

  // Opt-in: this deliberately trips the provider's connection cap, which is
  // rude to do on every run and slow. Set NNTP_PROBE_CAP=1 with
  // NNTP_CONNECTIONS above your account's real limit.
  if (process.env['NNTP_PROBE_CAP'] === '1') {
    say('\n-- connection cap --');
    await check('saturating the account settles every request', () =>
      capacity(nzb, pool, connectionCount()),
    );
  }

  const second = secondServer();
  if (second !== null) {
    say('\n-- second provider --');
    const multi = new NntpMultiPool({ servers: [primaryServer(), second] });
    try {
      await check('an article the primary lost is fetched from the second', () =>
        fillsTheGap(nzb, multi),
      );
    } finally {
      multi.destroy();
    }
  }
} finally {
  if (pool.failures.length > 0) {
    // Grouped, not listed: saturating a 100-connection account produces a
    // hundred identical refusals, and a hundred identical lines say no more
    // than one line and a count.
    const byReason = new Map<string, number>();
    for (const failure of pool.failures) {
      byReason.set(failure.reason, (byReason.get(failure.reason) ?? 0) + 1);
    }

    say(`\nconnection failures (${String(pool.failures.length)}):`);
    for (const [reason, count] of byReason) {
      say(`  ${String(count)} x ${reason}`);
    }
  }
  pool.destroy();
}

say(`\n${failures === 0 ? 'all checks passed' : `${String(failures)} check(s) failed`}`);
// exitCode rather than exit(): stdout to a pipe may still be draining, and a
// harness that truncates its own report is worse than no harness.
process.exitCode = failures === 0 ? 0 : 1;
