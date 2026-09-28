#!/usr/bin/env python3
"""Operator-run, fixed A3 VM packet-drop checks; never install or relax rules.

Sends three TCP SYN frames per case from the exact proof VM. Using the
bridge MAC avoids confusing blocked IPv6 neighbour discovery with TCP drops.
This tests the packet fence, not TCP service availability or A3 readiness.
No guest files, neighbour entries, firewall rules or VM settings are changed.
"""
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('a3-install-fence.py'))
i = importlib.util.module_from_spec(spec)
spec.loader.exec_module(i)
MAC = '10:66:6a:55:f6:3f'
SOURCE6 = 'fd42:53c1:d5e6:16b0:1266:6aff:fe55:f63f'
# Reserved documentation destinations exercise the routed destination case
# without intentionally targeting a public service. They need not be reachable:
# pass requires the installed fence's own drop counter, never just a timeout.
CASES = (
    ('host_ipv4_tcp', '10.185.17.1', 'denied_ipv4'),
    ('routed_destination_ipv4_tcp', '192.0.2.1', 'denied_ipv4'),
    ('host_ipv6_tcp', 'fd42:53c1:d5e6:16b0::1', 'denied_ipv6'),
    ('routed_destination_ipv6_tcp', '2001:db8::1', 'denied_ipv6'),
)
GUEST = '''import json, socket, sys, time
from pathlib import Path
if Path('/sys/class/net/enp5s0/address').read_text().strip() != '10:66:6a:55:f6:3f':
    raise SystemExit('Guest NIC identity mismatch')
frame = bytes.fromhex(sys.argv[1])
if len(frame) not in (54, 74):
    raise SystemExit('Unexpected proof frame size')
with socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3)) as sock:
    sock.bind(('enp5s0', 0))
    sock.settimeout(2)
    sizes = []
    for _ in range(3):
        sizes.append(sock.send(frame))
        time.sleep(0.15)
print(json.dumps(dict(sent_sizes=sizes, boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip())))
'''


def checksum(data):
    if len(data) % 2:
        data += b'\0'
    total = sum(struct.unpack('!' + 'H' * (len(data) // 2), data))
    while total >> 16:
        total = (total & 65535) + (total >> 16)
    return (~total) & 65535


def mac_bytes(value):
    if not re.fullmatch(r'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', value):
        raise ValueError('Invalid bridge MAC')
    result = bytes.fromhex(value.replace(':', ''))
    if result[0] & 1 or result == bytes(6):
        raise ValueError('Expected unicast bridge MAC')
    return result


def make_frame(destination, bridge_mac, sequence):
    if destination not in {case[1] for case in CASES}:
        raise ValueError('Unreviewed probe destination')
    target = ipaddress.ip_address(destination)
    source = ipaddress.ip_address(i.MANIFEST['guest_ipv4'] if target.version == 4 else SOURCE6)
    tcp = struct.pack('!HHIIBBHHH', 49183, 443, sequence, 0, 5 << 4, 2, 1024, 0, 0)
    if target.version == 4:
        pseudo = source.packed + target.packed + struct.pack('!BBH', 0, 6, len(tcp))
    else:
        pseudo = source.packed + target.packed + struct.pack('!I3xB', len(tcp), 6)
    tcp = tcp[:16] + struct.pack('!H', checksum(pseudo + tcp)) + tcp[18:]
    if target.version == 4:
        header = struct.pack('!BBHHHBBH4s4s', 0x45, 0, 40, sequence & 65535,
                             0x4000, 32, 6, 0, source.packed, target.packed)
        header = header[:10] + struct.pack('!H', checksum(header)) + header[12:]
        ether_type = 0x0800
    else:
        header = struct.pack('!IHBB16s16s', 6 << 28, len(tcp), 6, 32, source.packed, target.packed)
        ether_type = 0x86dd
    return mac_bytes(bridge_mac) + mac_bytes(MAC) + struct.pack('!H', ether_type) + header + tcp


def counters(status):
    result = {row['name']: (row['packets'], row['bytes']) for row in status['counters']}
    if set(result) != {'allowed_proxy', 'denied_ipv4', 'denied_ipv6', 'denied_other'}:
        raise ValueError('Unexpected counter set')
    if any(type(v) is not int or v < 0 for values in result.values() for v in values):
        raise ValueError('Invalid counters')
    return result


def verify_delta(before, after, expected):
    delta = {key: [after[key][n] - before[key][n] for n in (0, 1)] for key in before}
    if delta[expected][0] != 3 or delta[expected][1] <= 0 or any(
            values != [0, 0] for key, values in delta.items() if key != expected):
        raise ValueError('Inconclusive or failed probe counter delta: ' + json.dumps(delta))
    return delta


def run():
    initial = i.status()  # Verifies exact VM type/UUID, unchanged rules and unit.
    if initial['vm_status'] != 'Running':
        raise ValueError('Proof VM must already be running; this script never starts it')
    state = i.query('/1.0/instances/' + i.fence.VM + '/state')
    pid = state.get('pid')
    if type(pid) is not int or pid <= 0:
        raise ValueError('Missing running VM PID')
    bridge_mac = Path('/sys/class/net/incusbr0/address').read_text().strip()
    mac_bytes(bridge_mac)
    master = Path('/sys/class/net', i.fence.TAP, 'master').resolve(strict=True)
    if master.name != 'incusbr0':
        raise ValueError('TAP is not attached to the expected bridge')
    boot_id = None
    print(json.dumps(dict(vm_uuid=i.fence.PROOF_UUID, vm_pid=pid, bridge_mac=bridge_mac,
                         method='three raw TCP SYN frames per case', worker_ready=False)), flush=True)
    for index, (name, destination, counter) in enumerate(CASES):
        before_status = i.status()
        if before_status['vm_status'] != 'Running':
            raise ValueError('VM stopped during proof')
        before = counters(before_status)
        time.sleep(1)
        if counters(i.status()) != before:
            raise ValueError('Background traffic changes counters; no probe sent')
        frame = make_frame(destination, bridge_mac, 0xA3000000 + index)
        response = i.parse_json(i.execute(['incus', 'exec', i.fence.VM, '--',
                                           'python3', '-c', GUEST, frame.hex()]), name)
        if response.get('sent_sizes') != [len(frame)] * 3 or not response.get('boot_id'):
            raise ValueError('Guest did not confirm exactly three complete frames')
        if boot_id is not None and response['boot_id'] != boot_id:
            raise ValueError('Guest rebooted during proof')
        boot_id = response['boot_id']
        after = counters(i.status())
        after_state = i.query('/1.0/instances/' + i.fence.VM + '/state')
        if after_state.get('status') != 'Running' or after_state.get('pid') != pid:
            raise ValueError('VM identity changed during probe')
        delta = verify_delta(before, after, counter)
        print(json.dumps(dict(case=name, destination=destination, tcp_port=443,
                             before=before, after=after, delta=delta,
                             packet_drop_check='passed', boot_id=boot_id)), flush=True)
    return dict(packet_drop_checks='passed', cases=len(CASES), worker_ready=False,
                notice='Packet fence only; proxy access, application isolation, supervisor and lifecycle proofs remain open')


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise ValueError('Run in the host root terminal')
        import fcntl
        lock = Path('/run/proxypilot-a3-fence.lock')
        i.secure(lock)
        with lock.open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(json.dumps(run()), flush=True)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('A3 packet proof stopped: ' + (getattr(error, 'stderr', None) or str(error)), file=sys.stderr)
        sys.exit(1)
