# Oxiquill Release Runbook

This runbook covers the one-time npm package bootstrap and every later stable release. Release preparation never happens directly on `main`.

## Preconditions

- You have maintainer access to the GitHub repository and npm package.
- The `npm release readiness` milestone has no open `release-blocker` issue.
- Required CI is green on the latest `main`.
- The release version is stable `MAJOR.MINOR.PATCH`; prereleases require a separately reviewed runbook change.
- Node.js 24+, npm 11.15.0+, the repository's pinned pnpm/Rust tools, `wasm-pack`, `cargo-llvm-cov`, `wasm32-wasi-ghc`, Playwright, and GitHub CLI are available.
- The protected publish environment and npm Trusted Publisher are configured for normal releases.

The GitHub environment is named `npm-publish`. It has `kakune` as a required reviewer, permits only tags matching `v*`, allows self-review for the sole maintainer, and contains no npm credential. The npm Trusted Publisher must match repository `kakune/oxiquill`, workflow filename `npm-publish.yml`, environment `npm-publish`, and only the `npm publish` action.

Never reuse, move, or replace a published tag. npm versions are immutable; recover from a bad release with deprecation and a patch release.

## Prepare `release/vX.Y.Z`

1. Fetch the latest `main`, verify it is clean, and create `release/vX.Y.Z` from that exact commit.
2. Update every repository/package/template/generated metadata version that is intentionally tied to Oxiquill. Do not change dependency versions unrelated to the release.
3. Move releasable entries from `CHANGELOG.md`'s Unreleased section into `## [X.Y.Z] - YYYY-MM-DD`, restore empty Unreleased categories, and update comparison links.
4. Update `SECURITY.md` if the supported minor line changes.
5. Regenerate required runtime/package artifacts through existing commands; never edit generated output directly.
6. Run the local release validation documented below.
7. Commit focused version/changelog and generated-metadata changes on the protected release branch.

Retain the protected `release/vX.Y.Z` branch after release. Do not add later commits to it.

## Validate the Candidate

Run from a clean checkout with the frozen lockfile:

```sh
pnpm install --frozen-lockfile
pnpm audit --prod --audit-level=low
pnpm check
pnpm lint:rust
pnpm wasm:dev
pnpm test
pnpm test:package
pnpm test:consumer
```

The package and consumer tests inspect temporary packs locally. The immutable release archive is produced later by the workflow from the tag on `main`.

## Merge, Tag, and Optional Dry Run

1. Open an English pull request from `release/vX.Y.Z` to `main` with the validation results and release checklist.
2. Bring the branch up to date with `main`, resolve every review conversation, and wait for all required checks.
3. Squash-merge the release pull request. Do not merge, rebase-merge, or push directly to `main`.
4. Record the resulting squash commit on `main` and confirm its tree contains the reviewed release state.
5. Create annotated tag `vX.Y.Z` on that resulting `main` commit and push the tag. Do not tag the release branch commit.
6. For the bootstrap release, release-control changes, toolchain changes, or another high-risk release, dispatch `npm-publish.yml` from `main` with `release_tag` set to the exact `vX.Y.Z` value. A routine normal release proceeds directly to the stable GitHub Release because its protected workflow performs the same validation before publication.

   ```sh
   gh workflow run npm-publish.yml --ref main --field release_tag=vX.Y.Z
   ```

The manual path never contacts an npm publish endpoint. It must verify:

- tag/version shape and equality for root and package metadata;
- the checked-out tag commit and its ancestry from `main`;
- zero open release blockers and zero production advisories;
- all required checks and language/browser/consumer fixtures;
- the complete npm tarball allowlist and README/licenses;
- one tarball built exactly once, with its SHA-256, package identity, tagged source commit, and workflow commit recorded.

Download artifact `oxiquill-X.Y.Z`. It contains only `oxiquill-X.Y.Z.tgz`, `SHA256SUMS`, and `release-manifest.json`. Verify and inspect it from an isolated directory:

```sh
sha256sum --check SHA256SUMS
tar -tzf oxiquill-X.Y.Z.tgz
npm pack --dry-run --json ./oxiquill-X.Y.Z.tgz
```

On macOS, use `shasum -a 256 -c SHA256SUMS` if `sha256sum` is unavailable. Confirm the manifest records every tarball path, the expected package/version, tag commit, workflow commit, npm integrity, and the same SHA-256. Do not rebuild or rename the archive.

For a published GitHub Release, the workflow attaches the same three verified files with a dedicated `contents: write` job. A rerun accepts byte-identical assets and fails on conflicting content instead of replacing it.

## One-Time npm Bootstrap

Use this section only for the first publication of the unscoped `oxiquill` package, before package-scoped trusted publishing can be configured.

1. Recheck that `oxiquill` returns npm E404 and that `kakune` controls the intended npm account and organization settings.
2. Complete the tagged manual dry run above for `v0.3.0`, then download and inspect its exact three-file artifact.
3. Sign in with an interactive npm session protected by 2FA. Publish that exact archive once with public access; do not rebuild it. Local interactive publishing cannot use trusted OIDC provenance, so override the package default only for this bootstrap command:

   ```sh
   npm publish ./oxiquill-0.3.0.tgz --access public --provenance=false
   ```

4. Immediately configure the GitHub Trusted Publisher with the repository, workflow, environment, and publish-only permission listed in Preconditions. With npm 11.15.0 or later, the equivalent interactive commands are:

   ```sh
   npm trust github oxiquill --file npm-publish.yml --repo kakune/oxiquill --env npm-publish --allow-publish
   npm trust list oxiquill
   ```

5. Configure publishing access to require 2FA and disallow token-based publication.
6. Remove or revoke every bootstrap credential and end the interactive session. Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or a permanent token fallback to GitHub.
7. Create the stable GitHub Release for `v0.3.0` from the exact tag and changelog entry. The workflow re-verifies and archives this release, but deliberately skips the publish job for the one-time bootstrap version.
8. Verify the installed package, tarball hash/contents, package README, and generated license files. Record that provenance begins with subsequent OIDC-published versions.

Record completion in the GitHub Release without exposing credentials or private account data. This exception is never used again.

## Normal Trusted Publication

1. Create the stable GitHub Release from the exact `vX.Y.Z` tag and changelog entry. Do not mark a stable release as a prerelease.
2. Wait for the least-privilege verify and release-assets jobs to finish, then download that release run's `oxiquill-X.Y.Z` artifact and repeat the hash/manifest/archive inspection. The workflow rejects a non-main tag, non-main workflow commit, version mismatch, open release blocker, advisory, failed validation, or changed archive.
3. Approve the waiting `npm-publish` environment only after inspecting that exact artifact. The publish job obtains only `contents: read` and `id-token: write`, downloads the same artifact, verifies it without rebuilding, and publishes the tarball through OIDC.
4. Confirm the exact version is public, installable with npm and pnpm, and shows npm provenance/publish attestations tied to this repository, workflow, tag, and protected environment.
5. Verify the package exports, README, licenses, static starter, check, build, preview, and language fixtures from the published package rather than a workspace link.

No normal release uses a long-lived npm write token.

## Dependency Update Freeze

Routine Dependabot version updates may be queued while a release candidate is frozen, but an open Dependabot security alert always blocks release. Do not merge unrelated dependency churn into a protected release branch.

After the release, reopen queued updates one at a time so Dependabot rebases each branch onto the latest `main`. Process grouped minor/patch updates first, then GitHub Actions major updates, then JavaScript tooling major updates. Review breaking changes and pass all required checks before each squash merge; do not auto-merge major updates.

## Rollback and Deprecation

Do not delete or retag a broken release and do not silently replace its GitHub assets.

1. Stop before approving the protected `npm-publish` environment if the version is not public yet.
2. If public, assess user/security impact and deprecate only the affected version with a concise upgrade message, for example `npm deprecate oxiquill@X.Y.Z "Use X.Y.(Z+1); see <advisory-or-issue>."`.
3. Revert or fix the defect on a normal topic branch, add regression coverage, and prepare the next patch through the complete runbook.
4. Update the affected GitHub Release and advisory/issue with the deprecation and replacement version. Preserve original artifacts for auditability.
5. Unpublish only when npm policy permits it and maintainers have documented why deprecation cannot protect users; treat this as an exceptional security/legal action.

## Final Verification

- The release pull request is squash-merged and all conversations/checks are complete.
- The tag points to the resulting `main` commit.
- The protected release branch still points to the reviewed preparation history and remains retained.
- GitHub Release notes match the changelog.
- The published npm version, tarball, README, licenses, provenance, and GitHub tag agree.
- npm and pnpm can install the release in isolated consumers.
- The next Unreleased section is ready for development.
