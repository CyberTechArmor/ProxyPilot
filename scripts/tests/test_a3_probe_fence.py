import importlib.util
import ipaddress
from pathlib import Path
import struct
import unittest
from unittest.mock import patch, MagicMock
import contextlib
import io
import json

spec = importlib.util.spec_from_file_location('probe', Path(__file__).resolve().parents[1] / 'a3-probe-fence.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PacketProofTests(unittest.TestCase):
    def test_checksum_known_vector(self):
        self.assertEqual(p.checksum(bytes.fromhex('0001f203f4f5f6f7')), 0x220d)

    def test_valid_tcp_syn_checksums_and_fixed_destinations(self):
        for name, destination, _ in p.CASES:
            with self.subTest(case=name):
                frame = p.make_frame(destination, '02:00:00:00:00:01', 42)
                self.assertEqual(frame[:12].hex(), '02000000000110666a55f63f')
                version = ipaddress.ip_address(destination).version
                if version == 4:
                    self.assertEqual(len(frame), 54)
                    header, tcp = frame[14:34], frame[34:]
                    self.assertEqual(frame[12:14], bytes.fromhex('0800'))
                    self.assertEqual(p.checksum(header), 0)
                    self.assertEqual(header[16:20], ipaddress.ip_address(destination).packed)
                    pseudo = header[12:20] + struct.pack('!BBH', 0, 6, len(tcp))
                else:
                    self.assertEqual(len(frame), 74)
                    header, tcp = frame[14:54], frame[54:]
                    self.assertEqual(frame[12:14], bytes.fromhex('86dd'))
                    self.assertEqual(header[24:40], ipaddress.ip_address(destination).packed)
                    pseudo = header[8:40] + struct.pack('!I3xB', len(tcp), 6)
                self.assertEqual(p.checksum(pseudo + tcp), 0)
                self.assertEqual(struct.unpack('!HH', tcp[:4]), (49183, 443))
                self.assertEqual(tcp[13], 2)  # SYN only; no application payload.

    def test_unreviewed_destination_and_invalid_mac_refused(self):
        for destination, mac in [('10.185.17.240', '02:00:00:00:00:01'),
                                 ('10.185.17.1', 'ff:ff:ff:ff:ff:ff'),
                                 ('10.185.17.1', '00:00:00:00:00:00'),
                                 ('10.185.17.1', 'not-a-mac')]:
            with self.subTest(destination=destination, mac=mac), self.assertRaises(ValueError):
                p.make_frame(destination, mac, 42)

    def baseline(self):
        return {name: (0, 0) for name in ['allowed_proxy', 'denied_ipv4', 'denied_ipv6', 'denied_other']}

    def test_exact_expected_counter_delta_required(self):
        before = self.baseline()
        after = before | {'denied_ipv6': (3, 180)}
        self.assertEqual(p.verify_delta(before, after, 'denied_ipv6')['denied_ipv6'], [3, 180])
        for change in [{'denied_ipv6': (0, 0)}, {'denied_ipv6': (2, 120)},
                       {'denied_ipv6': (4, 240)}, {'denied_ipv6': (3, 0)},
                       {'denied_ipv6': (-1, -60)}, {'allowed_proxy': (1, 60)},
                       {'denied_ipv4': (1, 40)}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                p.verify_delta(before, after | change, 'denied_ipv6')

    def test_guest_sends_exactly_three_frames_and_closes_socket(self):
        frame = p.make_frame('10.185.17.1', '02:00:00:00:00:01', 42)
        sock = MagicMock()
        sock.__enter__.return_value = sock
        sock.send.return_value = len(frame)
        output = io.StringIO()
        with patch('sys.argv', ['proof', frame.hex()]), patch('socket.socket', return_value=sock), \
                patch('socket.AF_PACKET', 17, create=True), patch('time.sleep'), \
                patch('pathlib.Path.read_text', side_effect=[p.MAC, 'boot-id']), \
                contextlib.redirect_stdout(output):
            exec(compile(p.GUEST, 'guest-proof', 'exec'), {})
        self.assertEqual(sock.send.call_count, 3)
        sock.bind.assert_called_once_with(('enp5s0', 0))
        sock.__exit__.assert_called_once()
        self.assertEqual(json.loads(output.getvalue())['sent_sizes'], [len(frame)] * 3)

    def test_guest_wrong_mac_sends_nothing(self):
        with patch('pathlib.Path.read_text', return_value='unexpected'), patch('socket.socket') as socket:
            with self.assertRaises(SystemExit):
                exec(compile(p.GUEST, 'guest-proof', 'exec'), {})
            socket.assert_not_called()

    def test_missing_fence_or_stopped_vm_prevents_probe_execution(self):
        with patch.object(p.i, 'status', side_effect=ValueError('wrong identity')), \
                patch.object(p.i, 'execute') as execute:
            with self.assertRaises(ValueError):
                p.run()
            execute.assert_not_called()
        with patch.object(p.i, 'status', return_value={'vm_status': 'Stopped'}), \
                patch.object(p.i, 'execute') as execute:
            with self.assertRaises(ValueError):
                p.run()
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
