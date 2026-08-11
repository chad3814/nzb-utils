import { readFile, readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

/**
 * Hard rule 3, enforced against the source text of `@chad3814/nntp`.
 *
 * Split out of client.test.ts, which is where this started and which it no
 * longer belongs in: it constructs no client, opens no socket and asserts
 * nothing about the protocol. It reads every file in `src/` and looks for
 * assignments.
 *
 * Runtime cannot do this job. A `#private` field is invisible to
 * `JSON.stringify`, `Reflect.ownKeys` and `util.inspect({ showHidden: true })`
 * alike -- all three were checked -- so "nothing retains the password" is not
 * an observable property of a running object. The source is the only place it
 * can be seen.
 *
 * Note the rule's exact shape: it constrains where a credential is *written to
 * a field*, and says nothing about what a memoized provider's closure holds.
 * `NntpPool` deliberately retains a resolved credential in one, bounded by
 * `credentialTtlMs`, so a pool of eight makes one trip to the vault rather
 * than eight. See CLAUDE.md hard rule 3.
 */
describe('credential retention', () => {
  it('never assigns credentials to a field anywhere in the package', async () => {
    const directory = new URL('../src/', import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.ts'));

    expect(files.length).toBeGreaterThan(0);
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        text: await readFile(new URL(file, directory), 'utf8'),
      })),
    );

    for (const { file, text } of sources) {
      expect(text, `${file} assigns credentials to a field`).not.toMatch(
        /(?:this|self)\s*\.\s*#?\w+\s*=\s*credentials\b/u,
      );
      // Providers made a second slip possible that the rule above cannot see:
      // stashing the *resolved* value, which is a plain string by then and no
      // longer called `credentials`. A resolved secret must stay a local.
      expect(text, `${file} retains a resolved secret on a field`).not.toMatch(
        /(?:this|self)\s*\.\s*#?\w+\s*=\s*(?:await\s+)?resolveSecret\b/u,
      );
      // A third shape neither rule above catches: retaining the constructor's
      // `options` object, or a piece of it that still contains a credential,
      // rather than a credential directly. Every entry of
      // `NntpMultiPoolOptions['servers']` carries a `credentials` field, so
      // `this.#foo = options` and `this.#foo = options.servers` each put an
      // array of credentials on a field just as surely as
      // `this.#foo = credentials` would. Avoiding exactly that is why
      // `NntpMultiPool`'s constructor maps `options.servers` into an array of
      // `ServerEntry`, which holds no credential, instead of keeping the array.
      //
      // This one is an allowlist, not a blocklist. Any assignment of `options`
      // or anything reachable from it to a field is a finding unless the exact
      // read appears in the lookaheads: `options.endpoint` and
      // `options.timeoutMs` (both real, in pool.ts and client.ts), and
      // `options.servers.map(` (real, in multi-pool.ts). A blocklist cannot do
      // this job, which is what an earlier version of this comment concluded
      // was impossible in general: to catch `= options.servers` a blocklist
      // has to ban `= options.<anything>`, and that bans the two legitimate
      // narrow reads with it. Inverting the sense is the whole fix.
      //
      // The cost is that adding a new non-secret option field and retaining it
      // fails this test until the allowlist is extended. That is the right
      // default for a hard rule: the penalty for forgetting is a red test with
      // a message naming the file, not a credential on an instance.
      expect(text, `${file} retains the options object, or part of it, on a field`).not.toMatch(
        /(?:this|self)\s*\.\s*#?\w+\s*=\s*options(?!\s*\.\s*(?:endpoint|timeoutMs)\b)(?!\s*\.\s*servers\s*\.\s*map\()/u,
      );
      // Spreading is the one shape the allowlist cannot see: in
      // `this.#foo = { ...options }`, `options` never sits in the position the
      // pattern anchors on, and the copy carries every field including the
      // credentials.
      expect(text, `${file} spreads the options object onto a field`).not.toMatch(
        /(?:this|self)\s*\.\s*#?\w+\s*=\s*\{[^}]*\.{3}\s*options\b/u,
      );
    }
  });
});
