# Email privacy

Use your GitHub-provided noreply address for Git author, committer, and tagger
identities and for package metadata. Keep GitHub's email privacy and push blocking
settings enabled.

Enable the local commit and push checks after cloning:

```sh
git config core.hooksPath .githooks
```

The checks require Python 3. They reject personal email addresses in staged text,
commit messages, identities, annotated tags, and every commit about to be pushed,
including intermediate commits whose content was later removed. Diagnostics do
not print the address. The email-privacy workflow audits reachable history and
must pass before changes can merge into main. GitHub's account-level email push
blocking provides an additional safeguard for the account's personal addresses.

Reserved example domains are allowed in examples and tests. Third-party license,
copyright, notice, and author files retain the contact information required by
their upstream notices. Do not remove or rewrite third-party attribution to make
the privacy check pass.

After a privacy-related history rewrite, clone the repository again. Pushing from
an old clone can reintroduce the old history. GitHub Support must handle retained
pull request references and cached views; repository owners cannot purge those
references with Git pushes.
