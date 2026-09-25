"""The accepted snapshot must keep flagging new and changed direct-host sites."""
import importlib.util
from pathlib import Path
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1] / 'host-boundary-inventory.py'
spec = importlib.util.spec_from_file_location('host_boundary_inventory', SOURCE)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class HostBoundaryInventoryTest(unittest.TestCase):
    def test_new_and_changed_sites_are_rejected_in_disposable_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'admin/backend/src/lib'
            source.mkdir(parents=True)
            candidate = source / 'reviewed.js'
            candidate.write_text("import { spawn } from 'node:child_process';\n")
            accepted = guard.inventory(root)
            self.assertEqual(guard.additions(accepted, accepted), {})

            candidate.write_text("import { spawnSync } from 'node:child_process';\n")
            changed = guard.additions(guard.inventory(root), accepted)
            self.assertIn('admin/backend/src/lib/reviewed.js', changed)

            new = source / 'unreviewed.js'
            new.write_text("spawnHostSync('incus', ['list']);\n")
            additions = guard.additions(guard.inventory(root), accepted)
            self.assertIn('admin/backend/src/lib/unreviewed.js', additions)


if __name__ == '__main__':
    unittest.main()
