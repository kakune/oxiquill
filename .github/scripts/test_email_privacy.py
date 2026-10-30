import os
import pathlib
import subprocess
import tempfile
import unittest


CHECK = pathlib.Path(__file__).with_name("check_email_privacy.py")
SAFE = "123+developer@users.noreply.github.com"


class PrivacyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.directory.name)
        self.env = dict(
            os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull
        )
        self.git("init", "-q")
        self.git("config", "user.name", "Developer")
        self.git("config", "user.email", SAFE)
        self.git("config", "core.hooksPath", os.devnull)

    def tearDown(self):
        self.directory.cleanup()

    def git(self, *args):
        return subprocess.check_output(
            ["git", *args], cwd=self.root, env=self.env
        ).strip()

    def stage(self, path="file.txt", content="safe\n"):
        (self.root / path).write_text(content)
        self.git("add", path)

    def check(self, mode="pre-commit", data=None):
        return subprocess.run(
            [os.sys.executable, str(CHECK), mode],
            input=data,
            cwd=self.root,
            env=self.env,
            capture_output=True,
        ).returncode

    def test_noreply_and_reserved_examples(self):
        self.stage(
            content="\n".join(
                [SAFE, "user@example.com", "uv@1.2.3", "git@github.com:owner/repo.git"]
            )
        )
        self.assertEqual(self.check(), 0)

    def test_guard_source_is_publishable(self):
        self.stage(content=CHECK.read_text())
        self.assertEqual(self.check(), 0)

    def test_reject_author(self):
        self.stage()
        self.env["GIT_AUTHOR_EMAIL"] = "developer" + "@private-domain.com"
        self.assertNotEqual(self.check(), 0)

    def test_reject_committer(self):
        self.stage()
        self.env["GIT_COMMITTER_EMAIL"] = "developer" + "@private-domain.com"
        self.assertNotEqual(self.check(), 0)

    def test_reject_content(self):
        self.stage(content="developer" + "@private-domain.com\n")
        self.assertNotEqual(self.check(), 0)

    def test_keep_third_party_license(self):
        self.stage(
            "LICENSE.txt", "Copyright Developer <developer" + "@private-domain.com>\n"
        )
        self.assertEqual(self.check(), 0)

    def test_push_checks_intermediate_commit(self):
        self.stage(content="developer" + "@private-domain.com\n")
        self.git("commit", "-qm", "Add file")
        self.stage(content="safe\n")
        self.git("commit", "-qm", "Clean current file")
        head = self.git("rev-parse", "HEAD").decode()
        data = f"refs/heads/main {head} refs/heads/main {'0' * 40}\n".encode()
        self.assertNotEqual(self.check("pre-push", data), 0)

    def test_push_checks_new_range(self):
        self.stage()
        self.git("commit", "-qm", "Initial")
        before = self.git("rev-parse", "HEAD").decode()
        self.stage(content="updated\n")
        self.git("commit", "-qm", "Update")
        after = self.git("rev-parse", "HEAD").decode()
        data = f"refs/heads/main {after} refs/heads/main {before}\n".encode()
        self.assertEqual(self.check("pre-push", data), 0)

    def test_tag_checks_tagger(self):
        self.stage()
        self.git("commit", "-qm", "Initial")
        self.git("config", "user.email", "developer" + "@private-domain.com")
        self.git("tag", "-am", "Release", "v1.0.0")
        self.assertNotEqual(self.check("--all"), 0)

    def test_commit_message(self):
        self.stage()
        self.git("commit", "-qm", "Contact developer" + "@private-domain.com")
        self.assertNotEqual(self.check("--all"), 0)


if __name__ == "__main__":
    unittest.main()
