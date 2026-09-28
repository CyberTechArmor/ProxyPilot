import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'browser_probe', Path(__file__).resolve().parents[1] / 'a3-probe-browser.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class BrowserProbeTests(unittest.TestCase):
    def test_host_rss_includes_descendants_and_refuses_missing_qemu(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for pid, parent, rss in [(10, 1, 100), (11, 10, 50),
                                     (12, 11, 25), (20, 1, 999)]:
                folder = root / str(pid)
                folder.mkdir()
                (folder / 'status').write_text(f'PPid:\t{parent}\nVmRSS:\t{rss} kB\n')
            self.assertEqual(p.process_tree_rss_kib(10, root), (175, 3))
            with self.assertRaises(ValueError):
                p.process_tree_rss_kib(99, root)

    def test_guest_fixture_is_fixed_nonroot_sandboxed_and_bounded(self):
        compile(p.GUEST, 'guest-browser-proof', 'exec')
        self.assertIn('os.setuid(65534)', p.GUEST)
        self.assertIn('os.setgid(65534)', p.GUEST)
        self.assertIn('start_new_session=True', p.GUEST)
        self.assertIn('os.killpg(process.pid, signal.SIGKILL)', p.GUEST)
        self.assertIn('shutil.rmtree(work)', p.GUEST)
        self.assertIn('timeout=50', p.GUEST)
        self.assertIn('--ignore-certificate-errors-spki-list=', p.GUEST)
        self.assertIn('https://demo.fractionate.ai/', p.GUEST)
        self.assertNotIn("'--no-sandbox'", p.GUEST)

    def test_nonrunning_or_wrong_qemu_refused_before_browser_exec(self):
        with patch.object(p.i.i, 'query', return_value={'status': 'Stopped', 'pid': 1}), \
                patch.object(p, 'Path') as path:
            with self.assertRaises(ValueError):
                p.qemu_pid()
            path.assert_not_called()
        with patch.object(p.i.i, 'query', return_value={'status': 'Running', 'pid': 44}), \
                patch.object(p, 'Path') as path:
            path.return_value.read_bytes.return_value = b'another-service\0'
            with self.assertRaises(ValueError):
                p.qemu_pid()


if __name__ == '__main__':
    unittest.main()
