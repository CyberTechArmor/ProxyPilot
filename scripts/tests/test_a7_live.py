"""A7 live view in the guest runner: Neko inside the worker unit.

The pure tests cover the relay's allowlists, the Neko configuration, the managed
policy bytes, the config check and the command routing (relay operations are
answered at once; handing control over waits in the one command queue). The
integration tests run the runner's own LiveDesktop against real Xvfb, a real
Neko server built from the pinned source with ProxyPilot's Unix-socket patch,
xinput and real Chromium, when those are present (A7_TEST_NEKO names the built
binary). Every X event they inject goes through XTest, the path Neko uses.
"""
import importlib.util
import json
import os
from pathlib import Path
import queue
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('a7_worker_guest', ROOT / 'a3-worker-guest.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
helpers_spec = importlib.util.spec_from_file_location('a7_guest_helpers', ROOT / 'tests' / 'test_a3_worker_guest.py')
helpers = importlib.util.module_from_spec(helpers_spec)
helpers_spec.loader.exec_module(helpers)

NEKO = os.environ.get('A7_TEST_NEKO', '')
SPKI = 'A' * 43 + '='


class Sink:
    def __init__(self):
        self.items = queue.Queue()

    def emit(self, value):
        self.items.put(value)

    def next(self, predicate, seconds=10):
        deadline = time.monotonic() + seconds
        kept = []
        try:
            while time.monotonic() < deadline:
                try:
                    item = self.items.get(timeout=0.1)
                except queue.Empty:
                    continue
                if predicate(item):
                    return item
                kept.append(item)
        finally:
            for item in kept:
                self.items.put(item)
        raise AssertionError('no matching event')


class LivePureTests(unittest.TestCase):
    def test_the_relay_passes_signalling_only_in_both_directions(self):
        for event in ('client/heartbeat', 'signal/request', 'signal/answer', 'signal/candidate', 'signal/restart',
                      'signal/video'):
            self.assertEqual(g.live_filter({'event': event, 'payload': {'a': 1}}, g.LIVE_FROM_VIEWER)['event'], event)
        # Input, clipboard, screen, keyboard, members, broadcast, chat and admin never cross from a viewer.
        for event in ('control/request', 'control/keydown', 'control/move', 'control/paste', 'clipboard/set',
                      'screen/set', 'keyboard/map', 'broadcast/start', 'send/unicast', 'session/profile',
                      'system/admin', 'chat/message', 'filetransfer/upload'):
            self.assertIsNone(g.live_filter({'event': event, 'payload': {}}, g.LIVE_FROM_VIEWER), event)
        self.assertIsNone(g.live_filter({'event': 'signal/answer', 'payload': 'x'}, g.LIVE_FROM_VIEWER))
        self.assertIsNone(g.live_filter({'event': 'signal/answer', 'extra': 1}, g.LIVE_FROM_VIEWER))
        self.assertIsNone(g.live_filter(['signal/answer'], g.LIVE_FROM_VIEWER))
        # Towards the viewer: the room's members, settings and clipboard never go out.
        init = g.live_filter({'event': 'system/init', 'payload': {'session_id': 's', 'control_host': {}, 'screen_size': {},
                                                                   'webrtc': {}, 'sessions': {'x': {}}, 'settings': {}}},
                             g.LIVE_TO_VIEWER)
        self.assertEqual(sorted(init['payload']), ['control_host', 'screen_size', 'session_id', 'webrtc'])
        provide = g.live_filter({'event': 'signal/provide', 'payload': {'sdp': 'v=0', 'iceservers': [{'urls': ['stun:x']}]}},
                                g.LIVE_TO_VIEWER)
        self.assertEqual(provide['payload'], {'sdp': 'v=0'})
        for event in ('session/created', 'session/cursors', 'clipboard/updated', 'keyboard/modifiers', 'system/logs',
                      'system/admin', 'broadcast/status'):
            self.assertIsNone(g.live_filter({'event': event, 'payload': {}}, g.LIVE_TO_VIEWER), event)

    def test_neko_config_locks_controls_and_opens_no_network_listener(self):
        desktop = g.LiveDesktop(Sink())
        desktop.socket, desktop.token = '/tmp/live/neko.sock', 'token'
        config = desktop.neko_config()
        self.assertEqual(config['server']['bind'], 'unix:/tmp/live/neko.sock')
        self.assertEqual(config['server']['static'], '')
        self.assertFalse(config['server']['metrics'] or config['server']['pprof'])
        self.assertEqual({k: config['session'][k] for k in ('locked_controls', 'implicit_hosting', 'control_protection')},
                         {'locked_controls': True, 'implicit_hosting': False, 'control_protection': False})
        self.assertEqual(config['webrtc'], {'udpmux': g.LIVE_UDP_PORT, 'icelite': True, 'ip_retrieval_url': '',
                                            'estimator': {'enabled': False}})
        for plugin in ('chat', 'filetransfer', 'openinapp', 'plugins'):
            self.assertEqual(config[plugin], {'enabled': False})
        self.assertFalse(config['desktop']['upload_drop'] or config['desktop']['file_chooser_dialog'])
        self.assertFalse(config['desktop']['input']['enabled'])
        profile = g.LiveDesktop.profile(False)
        self.assertEqual([profile[k] for k in ('is_admin', 'can_host', 'can_access_clipboard', 'can_share_media')],
                         [False, False, False, False])
        self.assertTrue(g.LiveDesktop.profile(True)['can_host'])

    def test_policy_bytes_and_the_x_cookie(self):
        policy = json.loads(g.live_policy_bytes())
        self.assertEqual(policy['DeveloperToolsAvailability'], 2)
        self.assertEqual(policy['DownloadRestrictions'], 3)
        self.assertFalse(policy['PasswordManagerEnabled'])
        for blocked in ('file://*', 'chrome://*', 'devtools://*', 'view-source:*', 'javascript://*'):
            self.assertIn(blocked, policy['URLBlocklist'])
        self.assertEqual(g.live_policy_bytes(), g.live_policy_bytes())
        entry = g.xauthority('99', b'\x01' * 16)
        self.assertEqual(entry[:2], b'\xff\xff')
        self.assertIn(b'MIT-MAGIC-COOKIE-1', entry)
        self.assertTrue(entry.endswith(b'\x00\x10' + b'\x01' * 16))

    def test_config_accepts_live_for_a_browser_only(self):
        base = {'attempt_id': helpers.ATTEMPT, 'workload': 'browser', 'spki': SPKI}
        self.assertTrue(g.validate_config(dict(base, live=True))['live'])
        for bad in (dict(base, live=False), dict(base, live='yes'), dict(base, workload='proof:cpu', live=True),
                    dict(base, live=True, extra=1)):
            with self.assertRaises(g.Refused):
                g.validate_config(bad)

    def test_relay_operations_are_answered_at_once_and_control_is_queued(self):
        sink, inbox = Sink(), queue.Queue()
        lines = [json.dumps({'id': 1, 'op': 'live_open', 'conn': 'abcdefgh'}),
                 json.dumps({'id': 2, 'op': 'live_give', 'conn': 'abcdefgh'}),
                 json.dumps({'id': 3, 'op': 'live_send', 'conn': 'abcdefgh', 'data': {'event': 'control/request'}})]
        g.commands(iter(line + '\n' for line in lines), inbox, [None], sink)
        # Without a live desktop the relay refuses at once; control waits in the queue.
        self.assertEqual(sink.next(lambda m: m.get('id') == 1)['error'], 'LIVE_UNAVAILABLE')
        self.assertEqual(sink.next(lambda m: m.get('event') == 'live_dropped')['conn'], 'abcdefgh')
        self.assertEqual(inbox.get_nowait()['op'], 'live_give')
        self.assertIsNone(inbox.get_nowait())


def listening(pid=None):
    """Listening TCP sockets ('tcp:port') and bound UDP ports ('udp:port') from /proc,
    for one process when `pid` is given."""
    inodes = None
    if pid is not None:
        inodes = set()
        for fd in Path('/proc/%d/fd' % pid).iterdir():
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            if target.startswith('socket:['):
                inodes.add(target[8:-1])
    out = set()
    for kind in ('tcp', 'tcp6', 'udp', 'udp6'):
        table = Path('/proc/net/%s' % kind)
        if not table.exists():
            continue
        for line in table.read_text().splitlines()[1:]:
            fields = line.split()
            port, state, inode = int(fields[1].split(':')[1], 16), fields[3], fields[9]
            if (kind.startswith('tcp') and state != '0A') or (inodes is not None and inode not in inodes):
                continue
            out.add('%s:%d' % (kind[:3], port))
    return out


def tools_present():
    return (NEKO and Path(NEKO).exists() and shutil.which('Xvfb') and shutil.which('xinput')
            and shutil.which('xdotool') and Path(helpers.LOCAL_CHROMIUM).exists())


@unittest.skipUnless(tools_present(), 'needs Xvfb, xinput, xdotool, Chromium and A7_TEST_NEKO')
class LiveDesktopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='pp-a7-live-'))
        workspace = cls.root / 'workspace'
        workspace.mkdir(mode=0o700)
        policy = cls.root / 'policy.json'
        policy.write_bytes(g.live_policy_bytes())
        wrapper = cls.root / 'chromium'
        wrapper.write_text('#!/bin/sh\nexec %s --no-sandbox "$@"\n' % helpers.LOCAL_CHROMIUM)
        wrapper.chmod(0o755)
        cls.saved = {k: getattr(g, k) for k in ('WORKSPACE', 'NEKO_BINARY', 'LIVE_POLICY_PATH', 'LIVE_DISPLAY', 'CHROMIUM',
                                                 'PROXY', 'XVFB', 'XINPUT')}
        g.WORKSPACE, g.NEKO_BINARY, g.LIVE_POLICY_PATH = str(workspace), NEKO, str(policy)
        g.LIVE_DISPLAY, g.CHROMIUM, g.PROXY = ':97', str(wrapper), '127.0.0.1:9'
        g.XVFB, g.XINPUT = shutil.which('Xvfb'), shutil.which('xinput')
        cls.sink = Sink()
        cls.live = g.LiveDesktop(cls.sink).start()
        cls.browser = g.Browser(SPKI, cls.sink, cls.live)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.live.close()
        for k, v in cls.saved.items():
            setattr(g, k, v)
        shutil.rmtree(cls.root, ignore_errors=True)

    def xdotool(self, *args):
        subprocess.run(['xdotool', *args], env={**os.environ, **self.live.env}, check=True, timeout=10)

    def test_neko_listens_only_on_its_unix_socket_and_x_on_its_path_socket(self):
        mode = os.stat(self.live.socket).st_mode
        self.assertTrue(stat.S_ISSOCK(mode))
        self.assertEqual(stat.S_IMODE(mode), 0o600)
        neko = listening(self.live.processes[-1].pid)
        self.assertEqual({s for s in neko if s.startswith('tcp')}, set(), 'Neko has no TCP listener')
        self.assertIn('udp:%d' % g.LIVE_UDP_PORT, neko, 'the one WebRTC port')
        self.assertNotIn('tcp:6097', listening(), 'the display has no TCP listener')
        unix = Path('/proc/net/unix').read_text()
        self.assertNotIn('@/tmp/.X11-unix/X97', unix, 'no abstract-namespace X socket')

    def test_relay_and_one_controller_with_input_counted_by_kind(self):
        first = self.live.open('conn0001')
        self.assertEqual(first, {'conn': 'conn0001'})
        init = self.sink.next(lambda m: m.get('event') == 'live' and m['data']['event'] == 'system/init')
        self.assertLessEqual(set(init['data']['payload']), {'session_id', 'control_host', 'screen_size', 'webrtc'})
        self.assertEqual(init['data']['payload']['screen_size']['width'], 1280)
        self.live.open('conn0002')
        self.assertFalse(self.live.send('conn0001', {'event': 'control/request'}))
        self.assertTrue(self.live.send('conn0001', {'event': 'client/heartbeat'}))
        with self.assertRaises(g.Refused) as held:
            self.live.open('conn0001')
        self.assertEqual(held.exception.code, 'LIVE_CONN_EXISTS')
        # Before anyone is given control, Neko has no host and members cannot take it.
        self.assertEqual(self.live.api.request('GET', '/api/room/control')[1]['has_host'], False)
        member_token = None
        self.assertEqual(self.live.give('conn0001'), {'controlling': True})
        control = self.live.api.request('GET', '/api/room/control')[1]
        self.assertEqual((control['has_host'], control['host_id']), (True, self.live.conns['conn0001']['session']))
        with self.assertRaises(g.Refused) as second:
            self.live.give('conn0002')
        self.assertEqual(second.exception.code, 'LIVE_CONTROL_HELD')
        # X input (the path Neko's input takes) is counted by kind; the agent's
        # DevTools input is not.
        self.xdotool('key', 'a', 'b', 'Return')
        self.xdotool('click', '1')
        self.xdotool('click', '4')
        self.xdotool('click', '5')
        self.browser.cdp.call('Input.insertText', {'text': 'not counted'}, self.browser.session)
        time.sleep(0.5)
        released = self.live.release()
        self.assertEqual(released['inputs'], {'key': 3, 'click': 1, 'scroll': 2})
        self.assertEqual(self.live.api.request('GET', '/api/room/control')[1]['has_host'], False)
        self.assertIsNone(member_token)
        # Closing a viewer removes its member.
        self.live.close_conn('conn0002')
        closed = self.sink.next(lambda m: m.get('event') == 'live_closed' and m['conn'] == 'conn0002')
        self.assertEqual(closed['reason'], 'viewer_closed')
        members = self.live.api.request('GET', '/api/members')[1]
        self.assertNotIn('vconn0002', json.dumps(members))

    def test_the_kiosk_browser_still_serves_frames_on_the_pipe(self):
        frame = self.browser.view()
        self.assertEqual((frame['width'], frame['height']), (1280, 800))
        self.assertTrue(frame['png_base64'])

    def test_a_changed_policy_file_refuses_live(self):
        other = self.root / 'other-policy.json'
        other.write_text('{}\n')
        saved = g.LIVE_POLICY_PATH
        g.LIVE_POLICY_PATH = str(other)
        try:
            with self.assertRaises(g.Refused) as refused:
                g.LiveDesktop(Sink()).start()
            self.assertEqual(refused.exception.code, 'LIVE_POLICY_MISMATCH')
        finally:
            g.LIVE_POLICY_PATH = saved


if __name__ == '__main__':
    unittest.main()
