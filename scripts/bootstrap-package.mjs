#!/usr/bin/env node
/**
 * Publish a `0.0.1` placeholder so a package name exists on npm.
 *
 * npm's trusted publishers are configured from a package's settings page, which
 * only exists once the package does — so a repository that publishes purely
 * over OIDC cannot publish its own first version. Something has to create the
 * name first.
 *
 * A placeholder is deliberately empty: `package.json` and a README saying what
 * it is, no `dist`, no `src`, no `bin`. Anyone who installs one gets something
 * that obviously does nothing, rather than a 0.0.1 that half-works and looks
 * like an early release.
 *
 * **Deprecation is the real protection, and it is why this runs in two phases.**
 * The first version published to a new package becomes `latest` whatever
 * `--tag` says — verified: `npm publish --tag placeholder` on a fresh name
 * still produced `latest: 0.0.1`. So until the real release lands, a plain
 * `npm install` resolves the stub, and the deprecation warning is the only
 * thing telling anyone. It must not be skipped.
 *
 * Deprecating immediately after publishing does not work: the registry answers
 * `404` for a package it has only just accepted. So everything is published
 * first, and deprecation happens afterwards, once each name is actually
 * readable.
 *
 * This is also what to run when adding a *new* package to an already-published
 * set, which hits the same problem for that one name.
 *
 * Dry run by default. Pass --publish to actually do it; npm's own 2FA challenge
 * is the real gate.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TAG = 'placeholder';
const VERSION = '0.0.1';
/** How long to keep asking the registry about a name it has just accepted. */
const VISIBLE_TIMEOUT_MS = 60_000;

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const wanted = args.filter((arg) => !arg.startsWith('--'));

function npm(argv, options = {}) {
  return execFileSync('npm', argv, { encoding: 'utf8', stdio: 'pipe', ...options });
}

function exists(name, version) {
  try {
    npm(['view', version === undefined ? name : `${name}@${version}`, 'version']);
    return true;
  } catch {
    return false;
  }
}

async function manifests() {
  const out = [];

  for (const dir of await readdir('packages')) {
    const pkg = JSON.parse(await readFile(join('packages', dir, 'package.json'), 'utf8'));
    if (wanted.length === 0 || wanted.includes(pkg.name)) {
      out.push(pkg);
    }
  }

  return out;
}

function placeholder(pkg) {
  return {
    name: pkg.name,
    version: VERSION,
    description: `Placeholder reserving the ${pkg.name} name. Not a release.`,
    license: pkg.license,
    author: pkg.author,
    repository: pkg.repository,
    homepage: pkg.homepage,
    publishConfig: { access: 'public' },
  };
}

const readme = (pkg) => `# ${pkg.name}

**This ${VERSION} is a placeholder, not a release.** It contains no code.

It exists only so the package name is registered, which npm requires before a
trusted publisher can be configured for it. Every real version is published from
CI over OIDC with a provenance attestation.

The first real release is \`1.0.0\`. See
${pkg.repository?.url?.replace(/^git\+/u, '').replace(/\.git$/u, '') ?? 'the repository'}.
`;

async function publishOne(pkg) {
  const directory = await mkdtemp(join(tmpdir(), 'nzb-placeholder-'));
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(placeholder(pkg), null, 2)}\n`,
  );
  await writeFile(join(directory, 'README.md'), readme(pkg));

  process.stdout.write(`publishing ${pkg.name}@${VERSION} --tag ${TAG}\n`);
  // Inherited stdio: npm prompts for 2FA on stdin, which is the point --
  // nothing here should be able to publish unattended.
  execFileSync('npm', ['publish', '--tag', TAG, '--access', 'public'], {
    cwd: directory,
    stdio: 'inherit',
  });
}

/** Poll until the registry will answer for a name it has just accepted. */
async function waitUntilVisible(name) {
  const deadline = Date.now() + VISIBLE_TIMEOUT_MS;
  let wait = 1000;

  while (Date.now() < deadline) {
    if (exists(name, VERSION)) {
      return true;
    }
    await sleep(wait);
    // Backing off rather than hammering: propagation is usually a second or
    // two, and occasionally much longer.
    wait = Math.min(wait * 2, 8000);
  }

  return exists(name, VERSION);
}

const packages = await manifests();
const toPublish = packages.filter((pkg) => !exists(pkg.name));

if (!publish) {
  for (const pkg of toPublish) {
    process.stdout.write(`would publish ${pkg.name}@${VERSION} --tag ${TAG}\n`);
  }
  for (const pkg of packages.filter((p) => !toPublish.includes(p))) {
    process.stdout.write(`${pkg.name} already exists — would deprecate ${VERSION} if present\n`);
  }
  process.stdout.write('\ndry run — pass --publish to do it for real\n');
  process.exit(0);
}

// Phase 1: publish everything missing. A failure here is fatal for that
// package but must not cost the others their turn.
const failures = [];
for (const pkg of toPublish) {
  try {
    await publishOne(pkg);
  } catch (error) {
    failures.push(`${pkg.name}: publish failed — ${error instanceof Error ? error.message : ''}`);
  }
}

// Phase 2: deprecate every placeholder that is on the registry, including any
// left undeprecated by an earlier run that died partway. `npm deprecate` is
// idempotent, so repeating it costs nothing.
process.stdout.write('\nwaiting for the registry, then deprecating\n');

for (const pkg of packages) {
  if (!(await waitUntilVisible(pkg.name))) {
    failures.push(`${pkg.name}: never became visible, so ${VERSION} is NOT deprecated`);
    continue;
  }

  try {
    npm([
      'deprecate',
      `${pkg.name}@${VERSION}`,
      'Placeholder reserving the name; contains no code. Use 1.0.0 or later.',
    ]);
    process.stdout.write(`deprecated ${pkg.name}@${VERSION}\n`);
  } catch (error) {
    failures.push(
      `${pkg.name}: deprecate failed — ${error instanceof Error ? error.message.split('\n')[0] : ''}`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  ${failure}\n`);
  }
  process.stderr.write(
    '\nRe-run to retry: published names are skipped, and deprecation is idempotent.\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write('\nall placeholders published and deprecated\n');
}
