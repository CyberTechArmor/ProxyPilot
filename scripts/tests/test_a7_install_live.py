"""A7 live installer: the TURN relay's config, the refusals, and the order of the
fence line and live.json (the fence before the marker on enable; the marker
before the fence on disable). Every host effect is a recorded fake."""
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


live = load('a7_install_live', ROOT / 'a7-install-live.py')
supervisor = load('a7_install_live_supervisor', ROOT / 'a3-worker-supervisor.py')
SECRET = 'f' * 64


class RenderTests(unittest.TestCase):
    def test_turn_config_relays_only_to_the_guest_from_the_gateway(self):
        text = live.render_turn('turn.example.com', '192.168.1.20', SECRET)
        lines = text.splitlines()
        self.assertIn('listening-ip=192.168.1.20', lines)
        self.assertIn('relay-ip=%s' % live.GATEWAY_IPV4, lines)
        self.assertIn('allowed-peer-ip=%s' % live.GUEST_IPV4, lines)
        self.assertIn('denied-peer-ip=0.0.0.0-255.255.255.255', lines)
        self.assertIn('denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', lines)
        for line in ('no-tcp-relay', 'no-cli', 'no-dtls', 'no-tlsv1', 'no-tlsv1_1', 'use-auth-secret',
                     'no-multicast-peers', 'listening-port=3479', 'tls-listening-port=5350',
                     'min-port=49160', 'max-port=49200'):
            self.assertIn(line, lines)
        self.assertEqual(sum(1 for line in lines if line.startswith('allowed-peer-ip=')), 1)
        self.assertEqual(sum(SECRET in line for line in lines), 1)
        self.assertFalse(any(line.startswith(('external-ip', 'allow-loopback-peers', 'bps-capacity'))
                             for line in lines))
        # The relay range is the fence's relay range, and the Neko port the runner's.
        self.assertEqual((live.fence.LIVE_RELAY_PORTS[0], live.fence.LIVE_RELAY_PORTS[1]), (49160, 49200))
        self.assertEqual(live.runner.LIVE_UDP_PORT, live.fence.LIVE_UDP_PORT)

    def test_turn_urls_are_the_ones_the_supervisor_accepts(self):
        urls = live.turn_urls('turn.example.com')
        self.assertEqual(len(urls), 3)
        self.assertTrue(all(supervisor.TURN_URL.fullmatch(u) for u in urls))
        self.assertIn('turns:turn.example.com:5350?transport=tcp', urls)

    def test_units_are_hardened_and_reference_the_owned_config(self):
        unit = live.turn_unit()
        for line in ('User=turnserver', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'CapabilityBoundingSet=',
                     'RuntimeDirectory=proxypilot-a7-turn', 'ExecStart=/usr/bin/turnserver -c %s --no-stdout-log'
                     % live.TURN_CONF):
            self.assertIn(line, unit.splitlines())
        service, timer = live.cert_units()
        self.assertIn('ExecStart=/usr/bin/python3 -I /etc/proxypilot-a7/a7-install-live.py cert-sync', service)
        self.assertIn('OnUnitActiveSec=1d', timer)
        self.assertEqual(live.caddy_site('turn.example.com').count('turn.example.com'), 1)

    def test_hostname_and_listen_address_validation(self):
        self.assertEqual(live.valid_hostname('turn.example.com'), 'turn.example.com')
        for bad in ('turn', 'TURN.example.com', 'turn.example.com;rm', '-a.example.com', 'a..example.com', None,
                    'turn.example.com\n', 'x' * 250 + '.com'):
            with self.assertRaises(ValueError):
                live.valid_hostname(bad)
        local = {'192.168.1.20', '127.0.0.1', live.GATEWAY_IPV4}
        self.assertEqual(live.valid_listen_ip('192.168.1.20', local), '192.168.1.20')
        for bad in ('127.0.0.1', '0.0.0.0', live.GATEWAY_IPV4, '224.0.0.1', '192.168.1.21', 'turn.example.com'):
            with self.assertRaises(ValueError):
                live.valid_listen_ip(bad, local)

    def test_the_listen_address_defaults_to_the_default_route_source(self):
        route = '[{"dst":"1.1.1.1","gateway":"192.168.1.1","dev":"eno1","prefsrc":"192.168.1.20","flags":[],"uid":0}]'
        calls = []
        with patch.object(live, 'execute', lambda argv, **kw: calls.append(argv) or route):
            self.assertEqual(live.default_listen_ip(), '192.168.1.20')
        self.assertEqual(calls, [['ip', '-j', '-4', 'route', 'get', '1.1.1.1']])
        for bad in ('[]', '[{"dst":"1.1.1.1","dev":"eno1"}]', '{}'):
            with patch.object(live, 'execute', lambda argv, **kw: bad), self.assertRaises(ValueError):
                live.default_listen_ip()


class HostTests(unittest.TestCase):
    """A temporary root for every path; `execute`, the fence installer and the
    VM read-back replaced by recorders."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.calls = []
        self.status_active = None
        paths = {
            'CONFIG': base / 'etc-a7', 'STATE': base / 'state', 'TURN_CONF': base / 'etc-a7' / 'turnserver.conf',
            'TURN_SECRET': base / 'etc-a7' / 'turn-secret', 'TURN_CERT': base / 'etc-a7' / 'turn-cert.pem',
            'TURN_KEY': base / 'etc-a7' / 'turn-key.pem', 'TURN_UNIT': base / 'units' / 'proxypilot-a7-turn.service',
            'CERT_SERVICE': base / 'units' / 'proxypilot-a7-turn-cert.service',
            'CERT_TIMER': base / 'units' / 'proxypilot-a7-turn-cert.timer',
            'CADDY_SITE': base / 'caddy' / 'pp-a7-turn.caddy', 'CADDY_CERTS': base / 'caddy-certs',
            'LIVE_MARKER': base / 'a3' / 'live.json', 'OPERATOR_SOCKET': base / 'operator.sock',
            'TURNSERVER': base / 'turnserver',
        }
        paths['JOURNAL'] = paths['STATE'] / 'live-install.json'
        paths['NEKO_OUT'] = paths['STATE'] / 'neko'
        for folder in ('units', 'caddy', 'a3'):
            (base / folder).mkdir()
        paths['TURNSERVER'].write_text('')
        self.paths = paths
        self.patches = [patch.object(live, name, value) for name, value in paths.items()]
        self.patches += [
            patch.object(live, 'secure', lambda path: None),
            patch.object(live, 'execute', self.execute),
            patch.object(live, 'turn_group', lambda: os.getgid()),
            patch.object(live, 'host_addresses', lambda: {'192.168.1.20'}),
            patch.object(live.fence_installer, 'live_relay', self.live_relay),
            patch.object(live.fence_installer, 'status', lambda: {'live_relay': self.relay}),
            patch.object(live, 'vm_readback', self.vm_readback),
        ]
        if os.geteuid() != 0:
            # The installer is root-only and hands files to root:turnserver; a
            # non-root test run (CI) records those ownership changes instead.
            self.owners = []
            self.patches += [patch.object(live.os, 'chown', lambda path, uid, gid: self.owners.append((uid, gid))),
                             patch.object(live.os, 'fchown', lambda fd, uid, gid: self.owners.append((uid, gid)))]
        for item in self.patches:
            item.start()
        self.relay = False
        self.active = {}
        self.foreign = ''
        self.server = self.fake_supervisor()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.server.close()
        self.tmp.cleanup()

    # ------------------------------------------------------------ fakes

    def execute(self, argv, input=None, timeout=120, check=True):
        self.calls.append(('execute', list(argv)))
        if argv[:2] == ['systemctl', 'is-active']:
            return self.active.get(argv[2], 'inactive') + '\n'
        if argv[:2] == ['ss', '-Hltun']:
            # A meeting service's coturn on the usual ports, forwarded to the host.
            rows = 'udp UNCONN 0 0 0.0.0.0:3478 0.0.0.0:*\ntcp LISTEN 0 4096 *:5349 *:*\n' + self.foreign
            if self.active.get(live.TURN_UNIT.name) == 'active':
                rows += ('udp UNCONN 0 0 192.168.1.20:3479 0.0.0.0:*\n'
                         'tcp LISTEN 0 5 192.168.1.20:3479 0.0.0.0:*\ntcp LISTEN 0 5 192.168.1.20:5350 0.0.0.0:*\n')
            return rows
        if argv[:2] == ['systemctl', 'enable']:
            self.active[live.TURN_UNIT.name] = 'active'
            self.active[live.CERT_TIMER.name] = 'active'
        return ''

    def live_relay(self, enable=True):
        self.calls.append(('live_relay', enable, self.paths['LIVE_MARKER'].exists()))
        self.relay = enable
        return {'live_relay': enable}

    def vm_readback(self):
        return {'neko_sha256': 'a' * 64, 'policy_sha256': live.sha256_bytes(live.runner.live_policy_bytes()),
                'tools': {}, 'missing_libraries': [], 'modes': []}

    def fake_supervisor(self):
        server = socket.socket(socket.AF_UNIX)
        server.bind(str(self.paths['OPERATOR_SOCKET']))
        server.listen(4)

        def serve():
            while True:
                try:
                    conn, _ = server.accept()
                except OSError:
                    return
                with conn:
                    request = json.loads(conn.makefile().readline())
                    self.calls.append(('supervisor', request['method']))
                    reply = {'ok': True, 'result': {'active': self.status_active, 'live': False}}
                    conn.sendall(json.dumps(reply).encode() + b'\n')

        threading.Thread(target=serve, daemon=True).start()
        return server

    def journal(self, **extra):
        data = {'version': 1, 'vm': live.VM, 'neko': {'sha256': 'a' * 64}, 'vm_files': {'snapshot': 's'}, **extra}
        self.paths['STATE'].mkdir(exist_ok=True)
        self.paths['JOURNAL'].write_text(json.dumps(data))

    def caddy_cert(self, hostname='turn.example.com', body=b'CERT'):
        folder = self.paths['CADDY_CERTS'] / 'acme-v02.api.letsencrypt.org-directory' / hostname
        folder.mkdir(parents=True, exist_ok=True)
        (folder / (hostname + '.crt')).write_bytes(body)
        (folder / (hostname + '.key')).write_bytes(b'KEY')

    def installed_turn(self):
        self.caddy_cert()
        live.install_turn('turn.example.com', '192.168.1.20')

    # ------------------------------------------------------------ tests

    def test_install_turn_listens_on_the_default_route_address_unless_told(self):
        self.journal()
        self.caddy_cert()
        with patch.object(live, 'default_listen_ip', lambda: '192.168.1.20'):
            result = live.install_turn('turn.example.com')
        self.assertEqual(result['turn']['listen_ip'], '192.168.1.20')
        self.assertIn('listening-ip=192.168.1.20', self.paths['TURN_CONF'].read_text())
        with patch.object(live, 'default_listen_ip', lambda: '192.168.1.99'), self.assertRaises(ValueError):
            live.install_turn('turn.example.com')

    def test_install_turn_writes_the_relay_and_never_prints_the_secret(self):
        self.journal()
        self.caddy_cert()
        result = live.install_turn('turn.example.com', '192.168.1.20')
        secret = self.paths['TURN_SECRET'].read_text().strip()
        self.assertRegex(secret, r'\A[0-9a-f]{64}\Z')
        self.assertEqual(self.paths['TURN_SECRET'].stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.paths['TURN_CONF'].stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.paths['TURN_KEY'].stat().st_mode & 0o777, 0o640)
        self.assertIn('static-auth-secret=%s' % secret, self.paths['TURN_CONF'].read_text())
        self.assertNotIn(secret, json.dumps(result))
        self.assertNotIn(secret, self.paths['JOURNAL'].read_text())
        self.assertTrue(all(secret not in ' '.join(map(str, call)) for call in self.calls))
        self.assertEqual(result['turn']['active'], 'active')
        self.assertTrue(result['turn']['conf_matches'] and result['turn']['unit_matches'])
        self.assertEqual(result['turn']['ports'], {'3479': True, '5350': True})
        self.assertIn('listening-port=3479', self.paths['TURN_CONF'].read_text())
        # A rerun keeps the secret.
        live.install_turn('turn.example.com', '192.168.1.20')
        self.assertEqual(self.paths['TURN_SECRET'].read_text().strip(), secret)

    def test_install_turn_refusals(self):
        self.journal()
        with self.assertRaisesRegex(ValueError, 'no certificate'):
            live.install_turn('turn.example.com', '192.168.1.20')
        self.assertFalse(self.paths['TURN_UNIT'].exists())
        self.assertNotIn('turn', json.loads(self.paths['JOURNAL'].read_text()))
        self.active['coturn.service'] = 'active'
        with self.assertRaisesRegex(ValueError, 'distribution coturn'):
            live.install_turn('turn.example.com', '192.168.1.20')
        self.active.pop('coturn.service')
        with self.assertRaisesRegex(ValueError, 'not an address of this host'):
            live.install_turn('turn.example.com', '192.168.1.99')
        # Another TURN server on the relay's ports: refused, nothing written.
        self.foreign = 'udp UNCONN 0 0 0.0.0.0:3479 0.0.0.0:*\n'
        self.caddy_cert()
        with self.assertRaisesRegex(ValueError, 'already listens on the relay ports 3479/5350: udp 0.0.0.0:3479'):
            live.install_turn('turn.example.com', '192.168.1.20')
        self.assertFalse(self.paths['TURN_UNIT'].exists())
        self.foreign = ''
        self.paths['TURNSERVER'].unlink()
        with self.assertRaisesRegex(ValueError, 'coturn is not installed'):
            live.install_turn('turn.example.com', '192.168.1.20')

    def test_caddy_site_step_only_writes_the_site(self):
        self.journal()
        result = live.install_turn('turn.example.com', '192.168.1.20', write_caddy_site=True)
        self.assertIn('rerun install-turn', result['next'])
        self.assertIn('turn.example.com {', self.paths['CADDY_SITE'].read_text())
        self.assertFalse(self.paths['TURN_SECRET'].exists())
        self.assertIn(('execute', ['systemctl', 'reload', 'caddy']), self.calls)
        self.paths['CADDY_SITE'].write_text('other\n')
        with self.assertRaisesRegex(ValueError, 'other content'):
            live.install_turn('turn.example.com', '192.168.1.20', write_caddy_site=True)

    def test_cert_sync_restarts_the_relay_only_on_change(self):
        self.journal()
        self.installed_turn()
        self.calls.clear()
        self.assertFalse(live.cert_sync()['changed'])
        self.assertNotIn(('execute', ['systemctl', 'restart', live.TURN_UNIT.name]), self.calls)
        self.caddy_cert(body=b'RENEWED')
        self.assertTrue(live.cert_sync()['changed'])
        self.assertEqual(self.paths['TURN_CERT'].read_bytes(), b'RENEWED')
        self.assertIn(('execute', ['systemctl', 'restart', live.TURN_UNIT.name]), self.calls)

    def test_enable_puts_the_fence_line_in_before_the_marker(self):
        self.journal()
        with self.assertRaisesRegex(ValueError, 'must all be done first'):
            live.enable()
        self.installed_turn()
        self.status_active = {'run_id': 'r', 'attempt_id': 'a'}
        with self.assertRaisesRegex(ValueError, 'attempt is live'):
            live.enable()
        self.assertFalse(self.paths['LIVE_MARKER'].exists())
        self.status_active = None
        result = live.enable()
        self.assertIn(('live_relay', True, False), self.calls)
        marker = json.loads(self.paths['LIVE_MARKER'].read_text())
        self.assertEqual(marker['udp_port'], 18091)
        self.assertEqual(marker['relay_ports'], [49160, 49200])
        self.assertEqual(marker['turn']['urls'], live.turn_urls('turn.example.com'))
        self.assertTrue(result['live_marker'])
        self.assertIs(result['fence_live_relay'], True)
        self.assertNotIn(self.paths['TURN_SECRET'].read_text().strip(), self.paths['LIVE_MARKER'].read_text())

    def test_enable_refuses_changed_vm_files_or_a_stopped_relay(self):
        self.journal()
        self.installed_turn()
        with patch.object(live, 'vm_readback', lambda: {'neko_sha256': 'b' * 64, 'policy_sha256': ''}):
            with self.assertRaisesRegex(ValueError, 'changed since provisioning'):
                live.enable()
        self.active[live.TURN_UNIT.name] = 'failed'
        with self.assertRaisesRegex(ValueError, 'not running as installed'):
            live.enable()
        self.assertFalse(any(call[0] == 'live_relay' for call in self.calls))

    def test_disable_removes_the_marker_before_the_fence_line(self):
        self.journal()
        self.installed_turn()
        live.enable()
        self.calls.clear()
        result = live.disable()
        self.assertIn(('live_relay', False, False), self.calls)
        self.assertIn(('execute', ['systemctl', 'disable', '--now', live.TURN_UNIT.name]), self.calls)
        self.assertFalse(result['live_marker'])
        self.assertIsNone(result['enabled'])
        self.status_active = {'run_id': 'r'}
        with self.assertRaisesRegex(ValueError, 'attempt is live'):
            live.disable()

    def test_provision_refuses_without_a_built_neko_or_with_a_live_attempt(self):
        self.journal(neko={})
        with self.assertRaisesRegex(ValueError, 'Build Neko first'):
            live.provision_vm()
        self.paths['NEKO_OUT'].write_bytes(b'neko')
        self.journal(neko={'sha256': live.sha256_bytes(b'neko')})
        self.status_active = {'run_id': 'r'}
        with self.assertRaisesRegex(ValueError, 'attempt is live'):
            live.provision_vm()
        self.assertFalse(any(call[0] == 'execute' and call[1][:2] == ['incus', 'snapshot'] for call in self.calls))

    def test_build_refuses_a_changed_patch(self):
        with patch.object(live, 'PATCH_SHA256', '0' * 64):
            with self.assertRaisesRegex(ValueError, 'differs from the reviewed one'):
                live.build_neko()
        self.assertEqual(self.calls, [])

    def test_build_probe_copies_only_the_reviewed_sources_and_verifies_modules(self):
        def fake(argv, input=None, timeout=120, check=True):
            self.calls.append(('execute', list(argv)))
            if argv[:3] == ['docker', 'image', 'inspect']:
                return 'golang@sha256:%s\n' % ('b' * 64)
            if argv[:2] == ['docker', 'run']:
                src = [a for a in argv if a.endswith(':/src')][0].rsplit(':', 1)[0]
                Path(src, 'a7-live-probe').write_bytes(b'probe-binary')
            return ''
        with patch.object(live, 'execute', fake), patch.object(live, 'BUILD', self.paths['STATE'] / 'build'), \
                patch.object(live, 'PROBE_OUT', self.paths['STATE'] / 'a7-live-probe'):
            result = live.build_probe()
        self.assertEqual(result['probe']['sha256'], live.sha256_bytes(b'probe-binary'))
        self.assertEqual(result['probe']['go_sum_sha256'], live.sha256_file(live.PROBE_SOURCE / 'go.sum'))
        run = [c[1] for c in self.calls if c[1][:2] == ['docker', 'run']][0]
        self.assertIn('GOFLAGS=-mod=readonly', run)
        self.assertIn('go mod verify && go build -trimpath -o a7-live-probe .', run[-1])
        self.assertFalse((self.paths['STATE'] / 'build').exists())

    def test_the_reviewed_patch_is_the_pinned_one(self):
        self.assertEqual(live.sha256_file(live.PATCH), live.PATCH_SHA256)

    def test_status_is_read_only(self):
        self.journal()
        self.installed_turn()
        self.calls.clear()
        live.status()
        writes = [call for call in self.calls if call[0] != 'execute' or call[1][:2] not in
                  (['systemctl', 'is-active'], ['ss', '-Hltun'])]
        self.assertEqual(writes, [])


if __name__ == '__main__':
    unittest.main()
