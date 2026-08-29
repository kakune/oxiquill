# Releasing Oxiquill

Create `release/vX.Y.Z` from the latest `main`, then update and validate the version there. Open a pull request to `main` and squash-merge it after every required check passes and review conversations are resolved. Tag the resulting `main` commit as `vX.Y.Z` and publish a GitHub Release for that tag. Do not tag the release-branch commit: squash merge creates a different commit, and the publication workflow requires the tag to be contained in `main`.

Retain the protected release branch after merging as a record of the release preparation. Do not update, force-push, or delete it after the pull request is merged. Other merged topic branches are deleted automatically.

The `.github/workflows/npm-publish.yml` workflow rejects prerelease versions, prerelease GitHub Releases, mismatched tags, and tags that are not contained in `main`. It runs repository validation, checks the npm tarball, and builds a fresh consumer from that tarball before publishing `packages/oxiquill`.

## First publication

npm Trusted Publishing cannot be configured until the package exists. For the first publication only, create a short-lived granular npm access token scoped to publish `oxiquill`, store it as the repository secret `NPM_TOKEN`, and publish the GitHub Release. Revoke the token and remove the secret immediately after the workflow succeeds.

## Subsequent publications

Configure npm Trusted Publishing for repository `kakune/oxiquill` and workflow filename `npm-publish.yml`. The workflow grants `id-token: write`, runs on a GitHub-hosted runner, and invokes npm directly, so npm can exchange the GitHub OIDC identity for a short-lived publishing credential and attach provenance.

Do not retain `NPM_TOKEN` after bootstrap. Do not publish from a topic or release branch, or by manually running `npm publish` on a workstation. Publish only from a GitHub Release tag that points to a commit contained in `main`.
