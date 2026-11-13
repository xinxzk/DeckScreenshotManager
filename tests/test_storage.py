import asyncio
import importlib.util
import json
import logging
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        decky = types.ModuleType("decky_plugin")
        decky.DECKY_PLUGIN_SETTINGS_DIR = self.temp.name
        decky.DECKY_PLUGIN_RUNTIME_DIR = self.temp.name
        decky.logger = logging.getLogger("test")
        settings = types.ModuleType("settings")
        class SettingsManager:
            def __init__(self, **_): pass
            def read(self): pass
        settings.SettingsManager = SettingsManager
        self.saved = {key: sys.modules.get(key) for key in ("decky_plugin", "settings")}
        sys.modules.update(decky_plugin=decky, settings=settings)
        spec = importlib.util.spec_from_file_location("plugin_under_test", Path(__file__).parents[1] / "main.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.plugin = module.Plugin()
        self.account = "76561198000000001"

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None: sys.modules.pop(key, None)
            else: sys.modules[key] = value
        self.temp.cleanup()

    def load(self): return asyncio.run(self.plugin.loadQueue(self.account))
    def save(self, state): return asyncio.run(self.plugin.saveQueue(state))

    def test_atomic_round_trip_and_private_permissions(self):
        state = self.load()
        self.assertEqual(self.save(state), 1)
        self.assertEqual(self.load()["revision"], 1)
        path = self.plugin._queue_path(self.account)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_stale_revision_does_not_overwrite_new_state(self):
        old = self.load()
        self.save(old)
        with self.assertRaisesRegex(ValueError, "another instance"): self.save(old)
        self.assertEqual(self.load()["revision"], 1)

    def test_accounts_are_isolated(self):
        self.save(self.load())
        other = asyncio.run(self.plugin.loadQueue("76561198000000002"))
        self.assertEqual(other["revision"], 0)

    def test_invalid_account_cannot_escape_storage_directory(self):
        with self.assertRaises(ValueError): asyncio.run(self.plugin.loadQueue("../../escape"))

    def test_corrupt_state_is_preserved_and_surfaced(self):
        path = self.plugin._queue_path(self.account)
        path.write_text("broken json")
        with self.assertRaises(json.JSONDecodeError): self.load()
        self.assertEqual(path.read_text(), "broken json")

    def test_cross_account_task_is_rejected(self):
        state = self.load()
        state["tasks"] = [{"id": json.dumps(["76561198000000002", "10", "screenshots/10/a.jpg", 1]),
            "gameId": "10", "path": "screenshots/10/a.jpg", "created": 1, "privacy": 2,
            "status": "pending", "attempts": 0, "nextAttemptAt": 0, "updatedAt": 1, "error": ""}]
        with self.assertRaisesRegex(ValueError, "different account"): self.save(state)

    def test_full_task_round_trip(self):
        state = self.load()
        state["tasks"] = [{"id": json.dumps([self.account, "10", "screenshots/10/a.jpg", 1]),
            "gameId": "10", "path": "screenshots/10/a.jpg", "created": 1, "privacy": 2,
            "status": "pending", "attempts": 0, "nextAttemptAt": 0, "updatedAt": 1, "error": ""}]
        self.save(state)
        self.assertEqual(self.load()["tasks"], state["tasks"])

    def test_failed_replace_preserves_previous_queue(self):
        self.save(self.load())
        current = self.load()
        with patch("os.replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError): self.save(current)
        self.assertEqual(self.load(), current)
        self.assertEqual(list(self.plugin._queue_path(self.account).parent.glob("*.tmp")), [])


if __name__ == "__main__": unittest.main()
