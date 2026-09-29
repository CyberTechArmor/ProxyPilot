"""A7's managed Chromium policy, read by real Chromium from the real path.

The other live tests point the runner at a policy file Chromium never reads, so
they cannot see what the policy does. This one writes the runner's policy bytes
to /etc/chromium/policies/managed/ (the path the VM's Chromium reads; the file
already there is put back afterwards), starts the runner's own Browser on a
private X display, and proves:
- the runner drives Chromium over its DevTools pipe under the policy;
- with DeveloperToolsAvailability 2 added, it cannot (the host run's H4 defect,
  2026-09-29): that is why the policy leaves it out;
- a person at the display still cannot open DevTools or view-source: not in
  kiosk mode, and not in a normal window either, where the devtools://* block
  alone keeps DevTools shut (the same keys open DevTools there without it, the
  check that the keys land).

Opt in with A7_TEST_POLICY=1, as root (it writes under /etc), with Xvfb,
xdotool and Chromium present.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('a7_policy_guest', ROOT / 'a3-worker-guest.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
helpers_spec = importlib.util.spec_from_file_location('a7_policy_helpers', ROOT / 'tests' / 'test_a3_worker_guest.py')
helpers = importlib.util.module_from_spec(helpers_spec)
helpers_spec.loader.exec_module(helpers)

SPKI = 'A' * 43 + '='
DISPLAY = ':94'
# The keys a person would try; each is a DevTools or view-source shortcut.
KEYS = (['F12'], ['ctrl+shift+i'], ['ctrl+shift+j'], ['ctrl+shift+c'], ['ctrl+u'])


def ready():
    return (os.environ.get('A7_TEST_POLICY') == '1' and os.geteuid() == 0 and shutil.which('Xvfb')
            and shutil.which('xdotool') and Path(helpers.LOCAL_CHROMIUM).exists())


class Display:
    """A private X display with a cookie, as the runner's LiveDesktop makes it."""

    def __init__(self, root):
        self.auth = str(root / 'xauth')
        with open(self.auth, 'wb') as stream:
            stream.write(g.xauthority(DISPLAY[1:], os.urandom(16)))
        self.env = {'DISPLAY': DISPLAY, 'XAUTHORITY': self.auth, 'PATH': '/usr/bin:/bin'}
        self.xvfb = subprocess.Popen([shutil.which('Xvfb'), DISPLAY, '-screen', '0', '%dx%dx24' % g.VIEWPORT,
                                      '-nolisten', 'tcp', '-noreset', '-auth', self.auth],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while not os.path.exists('/tmp/.X11-unix/X' + DISPLAY[1:]):
            if time.monotonic() > deadline or self.xvfb.poll() is not None:
                raise RuntimeError('Xvfb did not start')
            time.sleep(0.1)

    def xdotool(self, *args):
        return subprocess.run(['xdotool', *args], env=self.env, capture_output=True, text=True, timeout=10).stdout

    def close(self):
        self.xvfb.terminate()
        self.xvfb.wait(10)


@unittest.skipUnless(ready(), 'needs A7_TEST_POLICY=1, root, Xvfb, xdotool and Chromium')
class RealPolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='pp-a7-policy-'))
        cls.path = Path(g.LIVE_POLICY_PATH)
        cls.previous = cls.path.read_bytes() if cls.path.exists() else None
        cls.created = [p for p in (cls.path.parent, cls.path.parent.parent, cls.path.parent.parent.parent)
                       if not p.exists()]
        cls.path.parent.mkdir(parents=True, exist_ok=True)
        cls.display = Display(cls.root)
        cls.saved = {k: getattr(g, k) for k in ('WORKSPACE', 'CHROMIUM', 'PROXY')}
        g.PROXY = '127.0.0.1:9'

    @classmethod
    def tearDownClass(cls):
        cls.display.close()
        for k, v in cls.saved.items():
            setattr(g, k, v)
        if cls.previous is None:
            cls.path.unlink(missing_ok=True)
        else:
            cls.path.write_bytes(cls.previous)
        for path in cls.created:
            try:
                path.rmdir()
            except OSError:
                pass
        shutil.rmtree(cls.root, ignore_errors=True)

    def browser(self, policy, kiosk=True):
        self.path.write_bytes(policy)
        workspace = Path(tempfile.mkdtemp(dir=self.root))
        wrapper = workspace / 'chromium'
        # As root the local Chromium needs --no-sandbox; the policy does not care.
        drop = '' if kiosk else 'for a do shift; [ "$a" = --kiosk ] || set -- "$@" "$a"; done\n'
        wrapper.write_text('#!/bin/sh\n%sexec %s --no-sandbox "$@"\n' % (drop, helpers.LOCAL_CHROMIUM))
        wrapper.chmod(0o755)
        g.WORKSPACE, g.CHROMIUM = str(workspace), str(wrapper)
        live = type('Live', (), {'env': self.display.env})()
        return g.Browser(SPKI, helpers_sink(), live)

    def evaluate(self, browser, expression):
        return browser.cdp.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True},
                                browser.session)['result'].get('value')

    def targets(self, browser):
        return [t.get('url', '') for t in browser.cdp.call('Target.getTargets')['targetInfos']]

    def press_everything(self, browser):
        """Focus the page, then every DevTools/view-source key. Returns what each
        left open, and the keys the page itself received."""
        self.display.xdotool('mousemove', '400', '300', 'click', '1')
        time.sleep(0.5)
        self.evaluate(browser, 'window.keys = []; addEventListener("keydown", e => keys.push(e.key), true); 1')
        opened = {}
        for keys in KEYS:
            self.display.xdotool('key', *keys)
            time.sleep(2)
            opened['+'.join(keys)] = [u for u in self.targets(browser) if u != 'about:blank']
        return opened, json.loads(self.evaluate(browser, 'JSON.stringify(keys)'))

    def test_the_runner_drives_chromium_under_the_policy(self):
        browser = self.browser(g.live_policy_bytes())
        try:
            self.assertEqual(self.evaluate(browser, '6 * 7'), 42)
            self.assertEqual(self.targets(browser), ['about:blank'])
        finally:
            browser.close()

    def test_devtools_availability_2_would_refuse_the_runner(self):
        policy = dict(json.loads(g.live_policy_bytes()), DeveloperToolsAvailability=2)
        with self.assertRaises(g.Refused) as caught:
            self.browser((json.dumps(policy, indent=1, sort_keys=True) + '\n').encode())
        self.assertEqual(caught.exception.code, 'BROWSER_START_FAILED')
        # The diagnostic the supervisor keeps now names the refused call first,
        # within its 1500 characters, without Chromium's D-Bus noise.
        diagnostic = caught.exception.diagnostic
        self.assertRegex(diagnostic.splitlines()[0], r'^BROWSER_PROTOCOL at [A-Z][A-Za-z]+\.[a-zA-Z]+: \S')
        self.assertLessEqual(len(diagnostic), 1500)
        self.assertNotIn('dbus/', diagnostic)

    def test_devtools_stays_shut_in_kiosk_mode(self):
        browser = self.browser(g.live_policy_bytes())
        try:
            opened, received = self.press_everything(browser)
            self.assertEqual(opened, {'+'.join(k): [] for k in KEYS})
            self.assertEqual(self.targets(browser), ['about:blank'])
            # The keys reached Chromium (the page saw them), so nothing opened
            # because nothing could, not because the keys were lost.
            self.assertIn('F12', received)
        finally:
            browser.close()

    def test_the_devtools_block_alone_keeps_devtools_shut_in_a_normal_window(self):
        browser = self.browser(g.live_policy_bytes(), kiosk=False)
        try:
            opened, _ = self.press_everything(browser)
            self.assertEqual(opened, {'+'.join(k): [] for k in KEYS})
        finally:
            browser.close()
        # The same window and keys without the block open DevTools: the keys land.
        policy = json.loads(g.live_policy_bytes())
        policy['URLBlocklist'] = [u for u in policy['URLBlocklist'] if not u.startswith('devtools')]
        browser = self.browser((json.dumps(policy) + '\n').encode(), kiosk=False)
        try:
            opened, _ = self.press_everything(browser)
            self.assertTrue(any(u.startswith('devtools://') for urls in opened.values() for u in urls), opened)
        finally:
            browser.close()


def helpers_sink():
    class Sink:
        def emit(self, value):
            pass
    return Sink()


if __name__ == '__main__':
    unittest.main()
