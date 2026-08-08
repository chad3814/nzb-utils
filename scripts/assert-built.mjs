#!/usr/bin/env node
/**
 * Refuse to pack a package whose `dist` is missing or stale.
 *
 * Every package ships `dist`, and `dist` is gitignored — so the one thing that
 * can silently go wrong at publish time is shipping a tarball built from
 * yesterday's source, or an empty one. npm gives no warning for either: it
 * packs whatever `files` matches, and an absent directory simply contributes
 * nothing.
 *
 * This runs from `prepack`, which fires for `npm pack` and `npm publish` alike.
 * It only *checks* — it does not build. `tsc -b` on one package of a composite
 * project cannot satisfy that package's project references on its own, so the
 * release workflow builds the whole repo once, up front, and this asserts the
 * result is present and current.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const name = process.env['npm_package_name'] ?? root;

async function newest(directory, extensions) {
  let latest = 0;

  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !extensions.some((suffix) => entry.name.endsWith(suffix))) {
      continue;
    }
    const info = await stat(join(entry.parentPath, entry.name));
    latest = Math.max(latest, info.mtimeMs);
  }

  return latest;
}

async function main() {
  try {
    await stat(join(root, 'dist', 'index.js'));
  } catch {
    throw new Error(
      `${name}: dist/index.js is missing. Run \`npm run build\` at the repo root — ` +
        'building a single package cannot resolve its project references.',
    );
  }

  // Staleness is measured against `.tsbuildinfo`, not against an output file.
  // `tsc` rewrites an output only when its content actually changes, so editing
  // one module can legitimately leave `index.js` untouched — and comparing that
  // single output against every input then reports a stale build on a tree that
  // is perfectly current. `.tsbuildinfo` is written whenever `tsc -b` does any
  // work, which is exactly the question being asked.
  let build;
  try {
    build = await stat(join(root, 'dist', '.tsbuildinfo'));
  } catch {
    throw new Error(
      `${name}: dist/.tsbuildinfo is missing, so there is no evidence this was built. ` +
        'Run `npm run build` at the repo root.',
    );
  }

  const source = await newest(join(root, 'src'), ['.ts']);
  if (source > build.mtimeMs) {
    throw new Error(
      `${name}: src has changed since the last build, so this tarball would ship stale ` +
        'code. Run `npm run build` at the repo root.',
    );
  }

  // A .d.ts is not optional here: every package advertises `types`, and one
  // packed without them installs as untyped `any` for every consumer.
  try {
    await stat(join(root, 'dist', 'index.d.ts'));
  } catch {
    throw new Error(`${name}: dist/index.d.ts is missing, so the package would ship untyped.`);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
