#!/usr/bin/env node
/**
 * Create the signed annotated tag that triggers a release.
 *
 * A file rather than an inline `node -e` in package.json: npm runs scripts
 * through `sh`, which reads backticks as command substitution, so a JS template
 * literal in a one-liner is silently executed by the shell before Node ever
 * sees it. That produced `git tag -s  -m` with both values eaten.
 *
 * The guards here are cheap and the mistakes they catch are not. A tag is the
 * thing `publish.yml` reacts to, and an unwanted one has to be deleted from the
 * remote before anyone notices the release it staged.
 *
 * Synchronous `git` throughout: a one-shot script that does its work and exits,
 * with nothing sharing its event loop.
 */
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

function git(...argv) {
  return execFileSync('git', argv, { encoding: 'utf8' }).trim();
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const packages = [];
for (const dir of await readdir('packages')) {
  packages.push(JSON.parse(await readFile(join('packages', dir, 'package.json'), 'utf8')));
}

// Lockstep is only true if it is actually true. The publish workflow checks
// this too, but finding out here costs nothing and saves pushing a tag that is
// guaranteed to fail its own gate.
const versions = new Set(packages.map((pkg) => pkg.version));
if (versions.size !== 1) {
  fail(
    `the workspaces disagree on the version: ${packages
      .map((pkg) => `${pkg.name}@${pkg.version}`)
      .join(', ')}`,
  );
}

const [version] = versions;
const tag = `v${version}`;

if (git('status', '--porcelain') !== '') {
  fail('the working tree is not clean; a tag should point at exactly what was reviewed');
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') {
  fail(`on ${branch}, not main — publish.yml refuses a tag that is not contained in main`);
}

// A local main behind the remote would tag a commit that is not the released
// one. The workflow's containment check would pass, which is what makes this
// worth catching here instead.
git('fetch', '--quiet', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
  fail('HEAD is not origin/main; pull or push first so the tag lands on the released commit');
}

const existing = git('tag', '--list', tag);
if (existing !== '') {
  fail(`${tag} already exists locally; delete it first if you really mean to re-cut it`);
}

execFileSync('git', ['tag', '-s', tag, '-m', tag], { stdio: 'inherit' });

process.stdout.write(`created ${tag} at ${git('rev-parse', '--short', 'HEAD')}\n`);
process.stdout.write(`\npush it to stage the release:\n  git push origin ${tag}\n`);
