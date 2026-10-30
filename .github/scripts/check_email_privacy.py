#!/usr/bin/env python3
"""Reject personal email addresses before committing or publishing Git objects."""

import re
import subprocess
import sys


EMAIL = re.compile(
    rb"[A-Za-z0-9_.%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}"
)
NOREPLY = re.compile(
    rb"(?:[A-Za-z0-9_.+\[\]\-]+@users\.noreply\.github\.com|noreply@github\.com)\Z"
)
LEGAL = re.compile(
    r"(?:^|[-_.])(?:licen[cs]es?|copying|notice|authors)(?:$|[-_.])", re.I
)


def git(*args):
    return subprocess.check_output(["git", *args])


def public_email(email):
    return NOREPLY.fullmatch(email) is not None


def content_email(email):
    domain = email.rsplit(b"@", 1)[1].lower()
    return (
        public_email(email)
        or domain in {b"example.com", b"example.net", b"example.org"}
        or domain.endswith((b".invalid", b".test", b".example"))
    )


def check_text(data, location):
    if b"\0" in data:
        return
    for match in EMAIL.finditer(data):
        # Git SSH transports contain an account and host, not a contact address.
        ssh = match.group() == (b"git" + b"@github.com") and data[
            match.end() : match.end() + 1
        ] in (b":", b"/")
        if not ssh and not content_email(match.group()):
            raise ValueError(
                f"{location}: non-noreply email address; use a GitHub noreply address"
            )


def check_identity(identity, location):
    match = re.search(rb"<([^<>]+)>", identity)
    if match is None or not public_email(match[1]):
        raise ValueError(f"{location}: Git identity must use a GitHub noreply address")


class Objects:
    def __init__(self):
        self.process = subprocess.Popen(
            ["git", "cat-file", "--batch"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )

    def read(self, oid):
        self.process.stdin.write(oid + b"\n")
        self.process.stdin.flush()
        header = self.process.stdout.readline().split()
        if len(header) != 3:
            raise ValueError(
                "Git object is unavailable; fetch the remote before pushing"
            )
        data = self.process.stdout.read(int(header[2]))
        self.process.stdout.read(1)
        return header[1], data

    def close(self):
        self.process.stdin.close()
        self.process.stdout.close()
        self.process.wait()


def check_objects(revisions):
    objects = Objects()
    checked = set()
    try:
        for revision in revisions:
            if revision.startswith(b"^"):
                continue
            kind, data = objects.read(revision)
            while kind == b"tag":
                header, _, message = data.partition(b"\n\n")
                for line in header.splitlines():
                    if line.startswith(b"tagger "):
                        check_identity(line, "tag " + revision.decode())
                check_text(message, "tag message")
                kind, data = objects.read(header.splitlines()[0].split()[1])
            if kind != b"commit":
                raise ValueError(
                    "Only commits and annotated commit tags may be published"
                )
        # --stdin avoids command-line length limits when auditing many refs.
        commits = subprocess.check_output(
            ["git", "rev-list", "--stdin"], input=b"\n".join(revisions) + b"\n"
        ).splitlines()
        for oid in commits:
            _, data = objects.read(oid)
            header, _, message = data.partition(b"\n\n")
            for line in header.splitlines():
                if line.startswith((b"author ", b"committer ")):
                    check_identity(line, "commit " + oid[:12].decode())
            check_text(message, "commit message " + oid[:12].decode())
            for entry in git("ls-tree", "-rz", oid.decode()).split(b"\0"):
                if not entry:
                    continue
                info, path = entry.split(b"\t", 1)
                _, kind, blob = info.split()
                name = path.decode("utf-8", errors="replace")
                # Preserve third-party copyright and license notices verbatim.
                if (
                    kind != b"blob"
                    or LEGAL.search(name.rsplit("/", 1)[-1])
                    or blob in checked
                ):
                    continue
                checked.add(blob)
                _, contents = objects.read(blob)
                check_text(contents, name + " at " + oid[:12].decode())
    finally:
        objects.close()


def main():
    mode = sys.argv[1] if len(sys.argv) == 2 else "--all"
    if mode == "pre-commit":
        for variable in ("GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"):
            check_identity(git("var", variable), variable)
        for path in git(
            "diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"
        ).split(b"\0"):
            if path and not LEGAL.search(path.decode().rsplit("/", 1)[-1]):
                check_text(git("show", ":" + path.decode()), path.decode())
    elif mode == "pre-push":
        for line in sys.stdin:
            _, local_oid, _, remote_oid = line.split()
            if set(local_oid) == {"0"}:
                continue
            revisions = [local_oid.encode()]
            if set(remote_oid) != {"0"}:
                revisions.append(b"^" + remote_oid.encode())
            # Inspect the tag itself as well as every newly reachable commit.
            check_objects(revisions)
    elif mode == "--all":
        refs = git("for-each-ref", "--format=%(objectname)").splitlines()
        if refs:
            check_objects(refs)
    else:
        raise ValueError("usage: check_email_privacy.py [pre-commit|pre-push|--all]")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f"Email privacy check failed: {error}", file=sys.stderr)
        sys.exit(1)
