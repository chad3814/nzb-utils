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

const pool = new NntpPool({
  // Providers rather than literals, which is what the credential path is built
  // for: nothing is read until a connection is actually opened. No memoize()
  // here on purpose — the pool normalises and memoizes at its own boundary, and
  // this harness exists partly to check that it does.
  credentials: { user: fromEnv('NNTP_USER'), pass: fromEnv('NNTP_PASS') },
  endpoint: endpoint(),
  connections: Number(process.env['NNTP_CONNECTIONS'] ?? '4'),
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
} finally {
  if (pool.failures.length > 0) {
    say(`\nconnection failures (${String(pool.failures.length)}):`);
    for (const failure of pool.failures) {
      say(`  ${new Date(failure.at).toISOString()}  ${failure.reason}`);
    }
  }
  pool.destroy();
}

say(`\n${failures === 0 ? 'all checks passed' : `${String(failures)} check(s) failed`}`);
// exitCode rather than exit(): stdout to a pipe may still be draining, and a
// harness that truncates its own report is worse than no harness.
process.exitCode = failures === 0 ? 0 : 1;
