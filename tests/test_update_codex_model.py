"""Behavior tests: temporary configs and simulated SSH only."""

import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/update-codex-model.py"
SPEC = importlib.util.spec_from_file_location("update_codex_model", SCRIPT)
updater = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updater)
NEW = "gpt-6.2-astra"


class PatchTests(unittest.TestCase):
    def test_root_and_active_profile_preserve_unrelated_values_and_formatting(self):
        raw = b'\xef\xbb\xbf# defaults\r\nmodel = "old" # comment\r\nprofile = "work"\r\nmodel_reasoning_effort = "max"\r\nmodel_provider = "custom"\r\nreview_model = "review"\r\n[profiles.work]\r\nmodel = "old"\r\n[profiles.cheap]\r\nmodel = "cheap"\r\n[model_providers.custom]\r\nmodel = "old"\r\nsecret = "not-for-output"\r\n'
        updated, changes, overrides = updater.patch_config(raw, NEW)
        expected = raw.replace(b'model = "old"', b'model = "gpt-6.2-astra"', 2)
        self.assertEqual(updated, expected)
        self.assertEqual(len(changes), 2)
        self.assertEqual(overrides, [("cheap", "cheap")])
        self.assertEqual(updater.patch_config(updated, NEW), (updated, [], overrides))

    def test_fake_assignments_in_multiline_strings_are_not_modified(self):
        raw = b'notes = """\nmodel = "old"\n[profiles.work]\nmodel = "old"\n"""\nmodel = "old"\n'
        updated, _, _ = updater.patch_config(raw, NEW)
        old, new = tomllib.loads(raw.decode()), tomllib.loads(updated.decode())
        self.assertEqual(new, {**old, "model": NEW})

    def test_missing_model_is_inserted_before_tables(self):
        raw = b'[mcp_servers.test]\r\nurl = "https://example.invalid"\r\n'
        updated, _, _ = updater.patch_config(raw, NEW)
        self.assertEqual(updated, b'model = "gpt-6.2-astra"\r\n' + raw)

    def test_quoted_and_dotted_keys(self):
        raw = b"'model' = 'old' # root\nprofile = 'work.test'\nprofiles.'work.test'.\"model\" = 'old' # profile\n"
        updated, changes, _ = updater.patch_config(raw, NEW)
        parsed = tomllib.loads(updated.decode())
        self.assertEqual(parsed["model"], NEW)
        self.assertEqual(parsed["profiles"]["work.test"]["model"], NEW)
        self.assertEqual(len(changes), 2)
        self.assertIn(b'# profile', updated)

    def test_all_profiles_including_inherited_default(self):
        raw = b'model = "old"\n[profiles.cheap]\nmodel = "small"\n[profiles.inherited]\nmodel_reasoning_effort = "low"\n'
        updated, _, overrides = updater.patch_config(raw, NEW, all_profiles=True)
        parsed = tomllib.loads(updated.decode())
        self.assertEqual(parsed["profiles"]["cheap"]["model"], NEW)
        self.assertNotIn("model", parsed["profiles"]["inherited"])
        self.assertEqual(overrides, [])

    def test_unsupported_or_invalid_configuration_refuses_to_edit(self):
        cases = [b'model = "a"\nmodel = "b"\n', b'model = 3\n', b'profile = "missing"\n',
                 b'profile = "work"\nprofiles = { work = { model = "old" } }\n', b'model = """old"""\n']
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                updater.patch_config(raw, NEW)


class FileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / 'config with spaces.toml'
        self.raw = b'model = "old"\n[mcp_servers.test]\nsecret = "do-not-print"\n'
        self.config.write_bytes(self.raw)
        self.config.chmod(0o640)
        self.target = {"name": "local", "path": str(self.config)}
        self.inventory = self.root / "targets.json"
        self.inventory.write_text(json.dumps({"targets": [self.target]}))

    def invoke(self, *args):
        result = subprocess.run([sys.executable, str(SCRIPT), NEW, "--targets", str(self.inventory), *args],
                                capture_output=True, text=True, timeout=10)
        self.assertNotIn("do-not-print", result.stdout + result.stderr)
        return result

    def test_preview_then_apply_backs_up_verifies_and_is_idempotent(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.config.read_bytes(), self.raw)
        self.assertEqual(list(self.root.glob("*.bak.model-*")), [])
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(tomllib.loads(self.config.read_text())["model"], NEW)
        backups = list(self.root.glob("*.bak.model-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.raw)
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o640)
        mtime = self.config.stat().st_mtime_ns
        self.assertEqual(self.invoke("--apply").returncode, 0)
        self.assertEqual(self.config.stat().st_mtime_ns, mtime)
        self.assertEqual(list(self.root.glob("*.bak.model-*")), backups)

    def test_concurrent_edit_is_not_overwritten(self):
        snapshot = updater.exchange(self.target, {"op": "read"}, 5, None)
        self.config.write_bytes(self.raw + b"# another writer\n")
        with self.assertRaisesRegex(RuntimeError, "changed since preview"):
            updater.exchange(self.target, {"op": "write", "expected_path": snapshot["path"],
                "expected_sha256": snapshot["sha256"], "content": base64.b64encode(b'model = "new"\n').decode()}, 5, None)
        self.assertTrue(self.config.read_bytes().endswith(b"# another writer\n"))
        self.assertEqual(list(self.root.glob("*.bak.model-*")), [])

    def test_symlink_remains_a_link(self):
        link = self.root / "linked.toml"
        link.symlink_to(self.config)
        self.target["path"] = str(link)
        self.inventory.write_text(json.dumps({"targets": [self.target]}))
        self.assertEqual(self.invoke("--apply").returncode, 0)
        self.assertTrue(link.is_symlink())
        self.assertEqual(tomllib.loads(self.config.read_text())["model"], NEW)

    def test_one_missing_target_does_not_mask_success_or_return_zero(self):
        targets = [{"name": "missing", "path": str(self.root / "missing.toml")}, self.target]
        self.inventory.write_text(json.dumps({"targets": targets}))
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("updated=1 failed=1", result.stdout)
        self.assertEqual(tomllib.loads(self.config.read_text())["model"], NEW)
        self.assertEqual(self.invoke("--only", "local").returncode, 0)

    def test_invalid_toml_is_unchanged_with_no_backup(self):
        self.config.write_bytes(b'model = "a"\nmodel = "b"\n')
        result = self.invoke("--apply")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.config.read_bytes(), b'model = "a"\nmodel = "b"\n')
        self.assertEqual(list(self.root.glob("*.bak.model-*")), [])

    def test_invalid_inventory_prevents_any_writes(self):
        for extra in [{**self.target, "name": "bad", "pth": "/tmp/typo"}, self.target]:
            self.inventory.write_text(json.dumps({"targets": [self.target, extra]}))
            result = self.invoke("--apply")
            self.assertEqual(result.returncode, 2)
            self.assertEqual(self.config.read_bytes(), self.raw)

    def test_remote_transport_with_quoted_path_and_failure_reporting(self):
        remote_config = self.root / "config 'quoted'.toml"
        remote_config.write_bytes(self.raw)
        target = {"name": "remote", "ssh": "test-alias", "path": str(remote_config)}
        self.inventory.write_text(json.dumps({"targets": [target]}))
        real_run = subprocess.run

        def fake_ssh(command, **kwargs):
            if command[0] == "ssh":
                self.assertIn("BatchMode=yes", command)
                self.assertIn("StrictHostKeyChecking=yes", command)
                self.assertNotIn("do-not-print", " ".join(command))
                return real_run(["sh", "-c", command[-1]], **kwargs)
            return real_run(command, **kwargs)

        with patch.object(updater.subprocess, "run", side_effect=fake_ssh), contextlib.redirect_stdout(io.StringIO()) as output:
            result = updater.main([NEW, "--targets", str(self.inventory), "--apply"])
        self.assertEqual(result, 0, output.getvalue())
        self.assertNotIn("do-not-print", output.getvalue())
        self.assertEqual(tomllib.loads(remote_config.read_text())["model"], NEW)
        self.assertEqual(self.config.read_bytes(), self.raw)
        with patch.object(updater.subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 1)), contextlib.redirect_stdout(io.StringIO()) as output:
            result = updater.main([NEW, "--targets", str(self.inventory)])
        self.assertEqual(result, 1)
        self.assertIn("operation timed out", output.getvalue())


if __name__ == "__main__":
    unittest.main()
