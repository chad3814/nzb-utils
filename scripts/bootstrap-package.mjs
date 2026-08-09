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
 * Published under the `placeholder` dist-tag, not `latest`. A package whose
 * only version is tagged `placeholder` has no `latest`, so `npm install <name>`
 * fails outright instead of quietly handing someone a stub during the window —
 * possibly an hour — between creating the names and approving the real release.
 *
 * This is also what to run when adding a *new* package to an already-published
 * set, which hits the same problem for that one name.
 *
 * Dry run by default. Pass --publish to actually do it; npm's own 2FA challenge
 * is the real gate.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TAG = 'placeholder';
const VERSION = '0.0.1';

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const wanted = args.filter((arg) => !arg.startsWith('--'));

/** Package names that npm does not know about yet. */
async function missing() {
  const out = [];

  for (const dir of await readdir('packages')) {
    const pkg = JSON.parse(await readFile(join('packages', dir, 'package.json'), 'utf8'));
    if (wanted.length > 0 && !wanted.includes(pkg.name)) {
      continue;
    }
    try {
      execFileSync('npm', ['view', pkg.name, 'version'], { stdio: 'pipe' });
      process.stdout.write(`${pkg.name} already exists on npm — skipping\n`);
    } catch {
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

const pending = await missing();
if (pending.length === 0) {
  process.stdout.write('nothing to bootstrap\n');
  process.exit(0);
}

for (const pkg of pending) {
  const directory = await mkdtemp(join(tmpdir(), 'nzb-placeholder-'));
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(placeholder(pkg), null, 2)}\n`,
  );
  await writeFile(join(directory, 'README.md'), readme(pkg));

  if (!publish) {
    process.stdout.write(`would publish ${pkg.name}@${VERSION} --tag ${TAG}\n`);
    continue;
  }

  process.stdout.write(`publishing ${pkg.name}@${VERSION} --tag ${TAG}\n`);
  // Synchronous and inherited: npm prompts for 2FA on stdin, which is the
  // point — nothing here should be able to publish unattended.
  execFileSync('npm', ['publish', '--tag', TAG, '--access', 'public'], {
    cwd: directory,
    stdio: 'inherit',
  });

  // Deprecating belt-and-braces alongside the dist-tag: the tag stops anyone
  // resolving it by accident, and this tells anyone who pinned it deliberately.
  execFileSync(
    'npm',
    [
      'deprecate',
      `${pkg.name}@${VERSION}`,
      'Placeholder reserving the name; contains no code. Use 1.0.0 or later.',
    ],
    { stdio: 'inherit' },
  );
}

if (!publish) {
  process.stdout.write('\ndry run — pass --publish to do it for real\n');
}
