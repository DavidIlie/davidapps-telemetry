# Release procedure

All six public npm packages share one release version and are published from
an immutable `v<semver>` Git tag. The order is core, web, Node, Next, React
Native, then Stripe so a brand-new scope can be bootstrapped without publishing
an adapter or integration before its internal dependency.

Never publish from an uncommitted worktree or directly from package source.
The workflow publishes the exact verified tarballs it uploads as an artifact.

## One-time npm bootstrap

The npm owner must:

1. Authenticate as npm user `davidilie` and confirm every package name under
   the user-owned `@davidilie` scope is available.
2. Configure the GitHub `npm` environment used by `.github/workflows/release.yml`.
3. Bootstrap packages that cannot yet use trusted publishing with a short-lived
   npm automation/granular token stored as that environment's `NPM_TOKEN`.
4. After each package exists, configure its npm trusted publisher for
   `DavidIlie/davidapps-telemetry`, workflow `release.yml`, environment `npm`.
5. Remove `NPM_TOKEN` after all packages publish through OIDC successfully.

The workflow uses Node 24 and upgrades npm to a trusted-publishing-capable
version. It requests only repository read and OIDC token permissions. Never
commit an npm token or put one into a package tarball.

Follow npm's current [trusted publisher documentation](https://docs.npmjs.com/trusted-publishers/)
for the one-time registry UI steps.

## Prepare a release

Choose the next SemVer version from user-visible compatibility:

- Patch: fixes/docs with no intended API break
- Minor before 1.0: new capabilities and any explicitly communicated evolving
  API surface
- Major at/after 1.0: incompatible API/runtime/behavior changes

Set the same version across all packages:

```sh
pnpm release:version 0.1.1
pnpm install --lockfile-only
pnpm release:verify
```

`release:verify` runs type checks, tests, builds, publint, license/provenance
checks, and packed-package smoke tests. The smoke test:

- Builds each tarball with workspace dependencies rewritten to the exact shared
  version
- Checks required README/license/notices/upstream files and every export target
- Packs twice and compares SHA-512 integrities for reproducibility
- Installs the tarballs into a clean consumer
- Imports every public entrypoint through ESM and CommonJS
- Type-checks the packed declarations

Review the packed README for each package because it is the npm landing page:

```sh
PACK_DIR="$(mktemp -d)"
pnpm packages:pack --output "$PACK_DIR"
jq . "$PACK_DIR/manifest.json"
tar -xOf "$PACK_DIR/davidilie-telemetry-core-0.1.1.tgz" package/README.md | less
```

Use the exact generated filename from `manifest.json`; npm tarball filename
format can change with package/version.

## Tag and publish

Commit the version/lockfile/release notes, merge it to `main`, wait for CI, then
tag that exact commit:

```sh
git switch main
git pull --ff-only
git tag -s v0.1.1 -m "DavidApps Telemetry v0.1.1"
git push origin v0.1.1
```

Use an annotated tag if signing is not configured; never retag a released
version. A `v*` push starts the release workflow.

The workflow checks out the tag with full history and verifies:

- The tag matches `v<semver>`
- Every public package version matches it
- HEAD is the full event/tag SHA
- The tag points exactly at HEAD
- The worktree is clean

It performs the full release verification again, packs once into a release
artifact, preflights the registry state of *all* packages before the first
publish, then publishes in dependency order with provenance.

If a package/version already exists with identical integrity, the workflow
skips it. If the registry has the same version with different integrity, it
fails before publishing anything. This makes repair runs safe after a partial
registry outage.

## Verify the release

After the job succeeds:

```sh
for package in core web node next react-native stripe; do
  npm view "@davidilie/telemetry-$package@0.1.1" \
    version dist.integrity dist.tarball --json
done
```

Install into at least one clean external consumer and repeat a real runtime
canary. Verify exact release identity (`service.version` must be the consumer's
deployed SHA, not `0.1.1`) and the final backend, not only gateway success.

Create/update the GitHub release from the same immutable tag. Include package
changes, migration notes, supported runtime changes, and known signal-model
limitations. Do not call a prerelease stable.

## Repair a failed publish

Do not change or move the tag. After fixing external npm authentication or a
workflow-only issue that does not alter artifacts, manually dispatch the
Release workflow with the existing tag. The registry preflight skips
byte-identical packages and publishes only missing ones.

If code, dependencies, docs included in the tarball, or tarball integrity must
change, create a new version and tag. npm releases are immutable.

## Gateway image release

The gateway image is separate from npm. Changes under the gateway/workflow
paths build GHCR tags from the source commit. GitOps must pin an immutable
commit-derived tag/digest and reconcile it explicitly. Publishing npm packages
does not deploy the gateway; deploying the gateway does not change SDK
packages.
