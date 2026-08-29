# Releasing Oxiquill

Releases are prepared on `release/vX.Y.Z` branches. Update and validate the version there, merge the release branch into `main` with a merge commit, tag that `main` commit as `vX.Y.Z`, and publish a GitHub Release for the tag. Merge the same release branch back into `develop` afterward.

The `.github/workflows/npm-publish.yml` workflow rejects prerelease versions, prerelease GitHub Releases, mismatched tags, and tags that are not contained in `main`. It runs repository validation, checks the npm tarball, and builds a fresh consumer from that tarball before publishing `packages/oxiquill`.

## First publication

npm Trusted Publishing cannot be configured until the package exists. For the first publication only, create a short-lived granular npm access token scoped to publish `oxiquill`, store it as the repository secret `NPM_TOKEN`, and publish the GitHub Release. Revoke the token and remove the secret immediately after the workflow succeeds.

## Subsequent publications

Configure npm Trusted Publishing for repository `kakune/oxiquill` and workflow filename `npm-publish.yml`. The workflow grants `id-token: write`, runs on a GitHub-hosted runner, and invokes npm directly, so npm can exchange the GitHub OIDC identity for a short-lived publishing credential and attach provenance.

Do not retain `NPM_TOKEN` after bootstrap. Do not publish from a topic branch, from `develop`, or by manually running `npm publish` on a workstation.
