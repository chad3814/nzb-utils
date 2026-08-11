import type { NntpMultiPool, NntpPool } from '@chad3814/nntp';
import type { parseNzb } from '@chad3814/nzb-parser';

/**
 * The individual checks the smoke test runs against the transport, not the
 * NZB. `checks.ts` covers reading an NZB -- geometry, slicing, decoding; these
 * two exercise connection limits and multi-server fallback instead. Different
 * subject, same contract: each returns a one-line note for the report, or
 * throws.
 */

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
export async function capacity(
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

/**
 * Fetch the article the primary no longer has.
 *
 * The Linux Journal post's .nfo returned 430 from Newshosting on every run
 * since 2026-08-08, so it is a real expired article rather than a simulated
 * one. If the second provider does not have it either, that is a finding about
 * retention, not a failure of this code -- so the check reports what each
 * server said rather than asserting success.
 */
export async function fillsTheGap(
  document: ReturnType<typeof parseNzb>,
  multi: NntpMultiPool,
): Promise<string> {
  const missing = document.files.find((file) => file.subjectHints.name?.endsWith('.nfo') === true);
  if (missing === undefined) {
    return 'no .nfo in this NZB; nothing known to be missing';
  }

  const id = missing.segments[0]?.messageId;
  if (id === undefined) {
    throw new Error('the .nfo lists no segments');
  }

  const report = await multi.statAll(id);
  const summary = report.map((entry) => `${entry.server}=${entry.status}`).join(' ');

  if (!report.some((entry) => entry.status === 'present')) {
    return `${summary}; gone from both, so no gap to fill`;
  }

  const response = await multi.body(id);
  return `${summary}; served ${String(response.body.byteLength)} B by ${response.server ?? 'unknown'}`;
}
