#!/usr/bin/env node
/**
 * Set one version across every workspace, and fix the internal ranges to match.
 *
 * `npm version --workspaces` bumps each `package.json` but leaves
 * `"@chad3814/nzb-parser": "^1.0.0"` inside its siblings pointing at the old
 * line. Under lockstep that quietly breaks the guarantee the scheme exists for:
 * the set is only self-consistent if the ranges move with the versions.
 *
 * Refuses to run on a dirty tree, so the diff it produces is only ever the bump
 * and can be reviewed as such.
 *
 * Uses the synchronous `git` and `npm` calls deliberately: this is a one-shot
 * script that does its work and exits, so nothing shares the event loop with
 * it — the case the repo's async-first rule carves out.
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const version = process.argv[2];
if (version === undefined || !SEMVER.test(version)) {
  process.stderr.write('usage: npm run version:set <major.minor.patch>\n');
  process.exit(2);
}

const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
if (dirty !== '') {
  process.stderr.write(
    'the working tree is not clean; commit or stash first so the bump is the only change\n',
  );
  process.exit(2);
}

const root = 'packages';
const directories = await readdir(root);
const names = new Set();

for (const directory of directories) {
  const parsed = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'));
  names.add(parsed.name);
}

for (const directory of directories) {
  const path = join(root, directory, 'package.json');
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  pkg.version = version;

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (deps === undefined) {
      continue;
    }
    for (const name of Object.keys(deps)) {
      if (names.has(name)) {
        deps[name] = `^${version}`;
      }
    }
  }

  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
  process.stdout.write(`${pkg.name} -> ${version}\n`);
}

// The lockfile records every workspace version, so leaving it stale makes
// `npm ci` install something other than what was just set.
execFileSync('npm', ['install', '--package-lock-only'], { stdio: 'inherit' });
