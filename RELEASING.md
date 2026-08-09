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

## First release: the bootstrap

There is a chicken-and-egg here, and it has to be broken by hand exactly once.

A trusted publisher is configured from a package's **settings page on
npmjs.com**, which only exists once the package does. A repository that
publishes purely over OIDC therefore cannot publish its own first version:
`publish.yml` has no token, and npm will not authenticate it for a name it has
never seen. Something has to create the six names first.

### 1. Publish placeholders

```sh
npm run bootstrap              # dry run: lists what it would publish
npm run bootstrap -- --publish # prompts for 2FA per package
```

This publishes an empty `0.0.1` for each name — `package.json` and a README
saying what it is, no code — and then deprecates each one.

**The deprecation is the protection, and it is not optional.** `--tag
placeholder` does _not_ keep the stub out of `latest`: the first version
published to a new package becomes `latest` whatever `--tag` says. Verified the
hard way — `npm publish --tag placeholder` on a fresh name produced
`placeholder: 0.0.1` _and_ `latest: 0.0.1`. So during the window between
creating the names and approving the real release — however long steps 2 and 3
take — a plain `npm install @chad3814/nzb` resolves the stub, and the
deprecation warning is the only thing saying so.

That is also why the script works in two phases. Deprecating immediately after
publishing fails with a `404`: the registry will not answer for a package it has
only just accepted. Everything is published first, then each name is polled
until it is readable, then deprecated. A failure in either phase is collected
rather than thrown, so one bad name cannot cost the others their turn, and
re-running is safe — published names are skipped and `npm deprecate` is
idempotent.

These six versions are permanent: npm only allows unpublishing within 72 hours,
and only when nothing depends on them. That is the accepted cost of keeping
`1.0.0` a real, fully attested release rather than one published from a laptop
without provenance.

### 2. Configure the trusted publishers

Once the names exist, add a trusted publisher to each of the six on npmjs.com.
All fields are identical apart from which package you are on:

| Field       | Value                           |
| ----------- | ------------------------------- |
| Repository  | `chad3814/nzb-utils`            |
| Workflow    | `.github/workflows/publish.yml` |
| Environment | _(leave blank)_                 |

Configure each as **staging only**, so OIDC can upload a tarball but cannot
release it without a human 2FA challenge.

The workflow filename is load-bearing: renaming `publish.yml` breaks OIDC auth
for all six packages until every trusted publisher is reconfigured to match.

If deprecation fails, it is not worth blocking on. The placeholders stop
mattering the moment `1.0.0` publishes and takes over `latest`; deprecating them
afterwards is cosmetic and can be done any time:

```sh
for p in nzb-parser yenc nntp nzb par2 nzb-cli; do
  npm deprecate "@chad3814/$p@0.0.1" 'Placeholder reserving the name; contains no code. Use 1.0.0 or later.'
done
```

### 3. Release 1.0.0

Follow the normal steps above, starting at the tag — the version is already
`1.0.0` in the tree, so there is nothing to bump for the first release.

Once the release is approved and `latest` points at it, run the bootstrap once
more to finish the placeholder lifecycle:

```sh
npm run bootstrap -- --publish
```

Nothing is published — every name already exists — but it deprecates any
placeholder that is not yet deprecated and drops the `placeholder` dist-tag now
that a real version owns `latest`. Both steps are idempotent, and both prompt
for authentication, which is why this cannot be folded into the workflow.

## Adding a package later

A new package in an already-published set hits the same problem for its one
name. `npm run bootstrap -- --publish` skips anything npm already knows about,
so it can be run again to create just the new one, after which it needs its own
trusted publisher before the next release will stage.
