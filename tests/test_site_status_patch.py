"""Exercise patch and restore only against temporary copies of inspected bundles."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("site_status_patch", ROOT / "scripts/site_status_patch.py")
PATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCHER)


class PatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = PATCHER.target_path(PATCHER.DEFAULT_ROOT, "browser")
        try:
            cls.source = source.read_bytes()
        except FileNotFoundError:
            raise unittest.SkipTest("Inspected source bundle is unavailable")
        if PATCHER.sha256(cls.source) != PATCHER.ORIGINAL_SHA256:
            raise unittest.SkipTest("Inspected source bundle is unavailable or changed")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.plugins = self.root / "plugins"
        for plugin in PATCHER.PLUGINS:
            target = PATCHER.target_path(self.plugins, plugin)
            target.parent.mkdir(parents=True)
            target.write_bytes(self.source)
            target.chmod(0o640)
        self.plan = self.root / "plan"

    def prepare(self):
        PATCHER.prepare(self.plugins, self.plan)

    def assert_originals(self):
        for plugin in PATCHER.PLUGINS:
            self.assertEqual(PATCHER.target_path(self.plugins, plugin).read_bytes(), self.source)

    def test_round_trip_and_idempotence(self):
        self.prepare()
        self.assert_originals()
        PATCHER.change(self.plan)
        PATCHER.change(self.plan)
        for plugin in PATCHER.PLUGINS:
            target = PATCHER.target_path(self.plugins, plugin)
            self.assertEqual(target.read_bytes(), PATCHER.patch_bytes(self.source))
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)
        PATCHER.change(self.plan, restore=True)
        PATCHER.change(self.plan, restore=True)
        self.assert_originals()

    def test_unknown_version_rejected_before_output(self):
        PATCHER.target_path(self.plugins, "chrome").write_bytes(self.source + b"\n")
        with self.assertRaisesRegex(ValueError, "hash differs"):
            self.prepare()
        self.assertFalse(self.plan.exists())
        self.assertEqual(PATCHER.target_path(self.plugins, "browser").read_bytes(), self.source)

    def test_changed_target_prevents_all_writes(self):
        self.prepare()
        target = PATCHER.target_path(self.plugins, "chrome")
        changed = self.source + b"\n// newer bundle\n"
        target.write_bytes(changed)
        with self.assertRaisesRegex(ValueError, "Target changed"):
            PATCHER.change(self.plan)
        self.assertEqual(target.read_bytes(), changed)
        self.assertEqual(PATCHER.target_path(self.plugins, "browser").read_bytes(), self.source)

    def test_tampered_prepared_patch_rejected(self):
        self.prepare()
        with (self.plan / "chrome.patched.mjs").open("ab") as stream:
            stream.write(b"\n// modified\n")
        with self.assertRaisesRegex(ValueError, "Prepared bundle or manifest changed"):
            PATCHER.change(self.plan)
        self.assert_originals()

    def test_restore_preserves_later_user_changes(self):
        self.prepare()
        PATCHER.change(self.plan)
        target = PATCHER.target_path(self.plugins, "chrome")
        changed = target.read_bytes() + b"\n// later user change\n"
        target.write_bytes(changed)
        with self.assertRaisesRegex(ValueError, "Target changed"):
            PATCHER.change(self.plan, restore=True)
        self.assertEqual(target.read_bytes(), changed)
        self.assertEqual(PATCHER.target_path(self.plugins, "browser").read_bytes(),
                         PATCHER.patch_bytes(self.source))

    def test_second_write_failure_rolls_back_first(self):
        self.prepare()
        replace = PATCHER.atomic_replace
        calls = 0

        def fail_second(target, content, mode):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated write failure")
            return replace(target, content, mode)

        with patch.object(PATCHER, "atomic_replace", side_effect=fail_second):
            with self.assertRaisesRegex(OSError, "simulated write failure"):
                PATCHER.change(self.plan)
        self.assert_originals()

    def test_response_override_scope(self):
        # This JavaScript is our own model of the inspected response predicate.
        # It does not execute the application bundle.
        script = r'''
          const blocked = response => response?.feature_status?.agent === true;
          const patched = o => ({...o, feature_status: {...o?.feature_status, agent: false}});
          for (const o of [null, {}, {feature_status: null},
                           {feature_status: {agent: true, other_feature: true}},
                           {feature_status: {agent: false}}]) {
            if (blocked(patched(o))) throw Error("agent remains blocked");
          }
          const original = {feature_status: {agent: true, other_feature: true}, marker: 7};
          const result = patched(original);
          if (!original.feature_status.agent) throw Error("input was mutated");
          if (!result.feature_status.other_feature || result.marker !== 7)
            throw Error("unrelated fields changed");
        '''
        subprocess.run(["node", "--input-type=module", "-e", script],
                       check=True, cwd=self.root, capture_output=True)


if __name__ == "__main__":
    unittest.main()
