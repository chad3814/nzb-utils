# Releasing

Maintainer notes. This file is not published to npm.

## What ships, and together

All six packages are versioned in **lockstep**: one version, one tag, published
as a set. Internal dependencies are `^` ranges of that same version, so any
combination npm resolves within a major is one that was tested together.

The cost is that `@chad3814/nzb-parser` gets a version bump when only the CLI
changed. That is deliberate for now — one maintainer, six packages that grew
together, and a self-consistent dependency graph is worth more than tidy version
histories. A package whose churn genuinely diverges can be split onto its own
line later; nothing here forecloses that.

## Why the tag is created separately

`npm version` bumps `package.json` **and** commits **and** tags, all on whatever
branch you are standing on. That breaks once `main` is protected:

- The bump commit has to go through a pull request.
- A **squash** or **rebase** merge rewrites that commit into a new SHA, so the
  commit the tag points at never lands on `main`.
- The tag is then stranded on an orphaned commit.

`.github/workflows/publish.yml` refuses to stage a publish from a tag that is
not contained in `main`, so this shows up as a failed run rather than a release
built from a commit that isn't on the mainline.

Only a merge commit (`--no-ff`) preserves the original SHA. Rather than depend
on always picking that strategy, bump and tag as two separate steps.

## Steps

1. On a branch, set the new version across every workspace:

   ```sh
   npm run version:set 1.0.1
   ```

   This writes the version into all six `package.json` files **and** rewrites
   the internal `^` ranges to match, which `npm version --workspaces` does not
   do. It refuses to run on a dirty tree, so the diff it produces is only ever
   the bump.

2. Commit and open a pull request:

   ```sh
   git commit -am "$(node -p 'require("./packages/nzb/package.json").version')"
   gh pr create --fill
   ```

3. Merge it. Any strategy is fine — squash, rebase, or merge commit.

4. Tag `main` itself, where the released commit actually is:

   ```sh
   git checkout main
   git pull --ff-only
   npm run tag          # signed annotated tag, version read from the workspaces
   git push origin "v$(node -p 'require("./packages/nzb/package.json").version')"
   ```

   Pushing the tag triggers `Stage publish`. It verifies every package's version
   matches the tag, confirms the commit is contained in `main`, runs the full
   gate, builds, and stages six tarballs.

5. Approve the staged releases. This cannot be automated — it needs a 2FA
   challenge, which is the point of staging:

   ```sh
   npm stage list
   npm stage download <stage-id>   # optional: inspect a tarball first
   npm stage approve <stage-id>
   ```

   There is one stage entry per package. Approve them in dependency order —
   `nzb-parser` and `yenc`, then `nntp` and `par2`, then `nzb`, then `nzb-cli` —
   so that no published package ever briefly references a version that does not
   yet exist. Nothing enforces this; npm does not check that a dependency is
   published. It only matters for the minutes between approvals.

## First release: trusted publishers

Each package needs its own trusted publisher on npmjs.com before the first
publish can work, all four fields identical apart from the package name:

| Field       | Value                           |
| ----------- | ------------------------------- |
| Repository  | `chad3814/nzb-utils`            |
| Workflow    | `.github/workflows/publish.yml` |
| Environment | _(leave blank)_                 |

Configure each as **staging only**, so OIDC can upload a tarball but cannot
release it without a human 2FA challenge.

The workflow filename is load-bearing: renaming `publish.yml` breaks OIDC auth
for all six packages until every trusted publisher is reconfigured to match.
