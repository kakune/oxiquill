# Oxiquill Release Runbook

This runbook covers the one-time npm package bootstrap and every later stable release. Release preparation never happens directly on `main`.

## Preconditions

- You have maintainer access to the GitHub repository and npm package.
- The `npm release readiness` milestone has no open `release-blocker` issue.
- Required CI is green on the latest `main`.
- The release version is stable `MAJOR.MINOR.PATCH`; prereleases require a separately reviewed runbook change.
- Node.js 24+, the repository's pinned pnpm/Rust tools, `wasm-pack`, `cargo-llvm-cov`, `wasm32-wasi-ghc`, Playwright, GitHub CLI, and current npm CLI are available.
- The protected publish environment and npm staged trusted publisher are configured for normal releases.

Never reuse, move, or replace a published tag. npm versions are immutable; recover from a bad release with deprecation and a patch release.

## Prepare `release/vX.Y.Z`

1. Fetch the latest `main`, verify it is clean, and create `release/vX.Y.Z` from that exact commit.
2. Update every repository/package/template/generated metadata version that is intentionally tied to Oxiquill. Do not change dependency versions unrelated to the release.
3. Move releasable entries from `CHANGELOG.md`'s Unreleased section into `## [X.Y.Z] - YYYY-MM-DD`, restore empty Unreleased categories, and update comparison links.
4. Update `SECURITY.md` if the supported minor line changes.
5. Regenerate required runtime/package artifacts through existing commands; never edit generated output directly.
6. Run the release validation documented below and inspect the packed archive.
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

Run the release workflow's manual dry-run path from the release-shaped ref. It must verify:

- tag/version shape and equality for root and package metadata;
- candidate ancestry from `main`;
- zero open release blockers and zero production advisories;
- all required checks and language/browser/consumer fixtures;
- the complete npm tarball allowlist and README/licenses;
- one tarball built exactly once, with its SHA-256 and file manifest recorded.

Download that workflow artifact, verify the recorded SHA-256 locally, and inspect the archive contents before approval. The publish job must consume the same archive and must not rebuild it.

## Merge and Tag

1. Open an English pull request from `release/vX.Y.Z` to `main` with the validation results and release checklist.
2. Bring the branch up to date with `main`, resolve every review conversation, and wait for all required checks.
3. Squash-merge the release pull request. Do not merge, rebase-merge, or push directly to `main`.
4. Record the resulting squash commit on `main` and confirm its tree contains the reviewed release state.
5. Create annotated tag `vX.Y.Z` on that resulting `main` commit and push the tag.
6. Create the GitHub Release from the exact tag, using the changelog entry as release notes. Do not mark a stable release as a prerelease.

Publishing the GitHub Release starts the stable verification/staging workflow. The workflow must reject a tag not contained in `main`, a mismatched version, an open release blocker, a changed archive, or missing OIDC.

## One-Time npm Bootstrap

Use this section only for the first publication of the unscoped `oxiquill` package, before package-scoped trusted publishing can be configured.

1. Recheck that `oxiquill` is available and that the maintainer controls the intended npm account and organization settings.
2. Run the complete release dry run and download the exact verified tarball, SHA-256, and manifest.
3. Recompute the hash locally and inspect both the recorded manifest and `npm pack --dry-run` output.
4. Sign in with an interactive npm session protected by 2FA. Publish that exact archive once with public access and provenance; do not rebuild it.
5. Immediately configure the GitHub trusted publisher for this repository and the stable workflow filename with stage-only permission.
6. Configure publishing access to require 2FA and disallow token-based publication.
7. Remove or revoke every bootstrap write credential. Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or a permanent token fallback to GitHub.
8. Verify the installed package, tarball hash/contents, public provenance attestation, package README, and generated license files.

Record completion in the GitHub Release without exposing credentials or private account data. This exception is never used again.

## Normal Staged Publication

1. The least-privilege verify job builds and validates the archive without publish permission.
2. The protected publish job obtains only `contents: read` and `id-token: write`, downloads the verified artifact, checks its SHA-256, and submits it with `npm stage publish` through the configured trusted publisher.
3. A required reviewer downloads/inspects the staged archive and compares its hash and manifest with the verify job.
4. The maintainer approves the staged release with npm 2FA.
5. Confirm the exact version is public, installable with npm and pnpm, and shows npm provenance/publish attestations tied to this repository/workflow.
6. Verify the package exports, README, licenses, static starter, check, build, preview, and language fixtures from the published package rather than a workspace link.

No normal release uses a long-lived npm write token.

## Rollback and Deprecation

Do not delete or retag a broken release and do not silently replace its GitHub assets.

1. Stop staged approval if the version is not public yet.
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
