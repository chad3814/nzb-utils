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
 * Credentials must arrive this way — injected into the environment by `op run`
 * — so they never enter a file, a transcript, or a shell history. As a backstop
 * every line of output goes through `scrub()`: if a credential ever did reach
 * an error message, the report would say so instead of printing it.
 */
import { readFile } from 'node:fs/promises';

import { NntpPool } from '@chad3814/nntp';
import type { NntpEndpoint } from '@chad3814/nntp';
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

const PREVIEW = 4 * 1024 * 1024;

const SECRETS = ['NNTP_PASS', 'NNTP_USER']
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

function endpoint(): NntpEndpoint {
  const security = process.env['NNTP_SECURITY'] ?? 'implicit';
  if (security !== 'implicit' && security !== 'starttls' && security !== 'none') {
    throw new Error(`NNTP_SECURITY must be implicit, starttls or none; got ${security}`);
  }
  return { host: required('NNTP_HOST'), port: Number(required('NNTP_PORT')), security };
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

/**
 * Ask for far more connections at once than the account allows.
 *
 * Every request is started in one tick, so all of them reach the pool before
 * any can complete and free a connection — which is what forces the opens.
 * Found this way: 200 concurrent requests against a 100-connection account
 * used to hang outright, because a refusal parked its caller without checking
 * whether a connection had already gone idle, and nothing was left running to
 * wake it. The property worth asserting is not "some fail" but "all settle".
 */
async function capacity(
  document: ReturnType<typeof parseNzb>,
  connections: NntpPool,
  want: number,
): Promise<string> {
  const id = document.files.flatMap((file) => file.segments)[0]?.messageId;
  if (id === undefined) {
    throw new Error('the NZB lists no segments');
  }

  const before = connections.failures.length;
  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: want }, () => connections.stat(id)),
  );
  const refused = connections.failures.length - before;
  const rejected = results.filter((result) => result.status === 'rejected').length;

  if (rejected > 0) {
    throw new Error(`${String(rejected)} of ${String(want)} requests failed outright`);
  }

  return (
    `${String(want)} concurrent requests all settled in ${String(Date.now() - started)} ms; ` +
    `${String(refused)} refused, limit shrank ${String(want)} -> ${String(connections.limit)}`
  );
}

function connectionCount(): number {
  return Number(process.env['NNTP_CONNECTIONS'] ?? '4');
}

const pool = new NntpPool({
  // Providers rather than literals, which is what the credential path is built
  // for: nothing is read until a connection is actually opened. No memoize()
  // here on purpose — the pool normalises and memoizes at its own boundary, and
  // this harness exists partly to check that it does.
  credentials: { user: fromEnv('NNTP_USER'), pass: fromEnv('NNTP_PASS') },
  endpoint: endpoint(),
  connections: connectionCount(),
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
