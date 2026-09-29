#!/usr/bin/env python3
"""Render the A3 proof-VM fence or check its host syntax; never install it.

Input is a host-owned identity manifest, prepared from fresh Incus readback.
The fixed TAP name must be configured while the VM is stopped and verified
before boot. No IP-only fallback: guest source-address spoofing cannot evade
the interface boundary. This file alone is not an isolation attestation.
"""
import argparse
import ipaddress
import json
from pathlib import Path
import subprocess
import sys
import uuid

VM = 'pp-agents-a3-debian13-proof-20260927'
TAP = 'ppa3proof0'
TABLE = 'pp_a3_proof'
PROXY_PORT = 18083
PROOF_UUID = '49592202-a8b0-45af-9ac6-5439761d73e4'
# A7 live view (user decision 1b, 2026-09-29): Neko's one WebRTC port in the
# worker unit may send UDP to the host's TURN relay ports on the gateway, and to
# nothing else. The relay itself (coturn) listens for viewers on the host.
LIVE_UDP_PORT = 18091
LIVE_RELAY_PORTS = (49160, 49200)


def validate(manifest):
    required = {'vm_name', 'vm_uuid', 'tap', 'guest_ipv4', 'gateway_ipv4'}
    if not isinstance(manifest, dict) or set(manifest) != required:
        raise ValueError('Manifest requires the exact reviewed identity fields')
    if manifest['vm_name'] != VM or manifest['tap'] != TAP:
        raise ValueError('Only the dedicated proof VM and fixed TAP are supported')
    identity = str(uuid.UUID(manifest['vm_uuid']))
    if identity != manifest['vm_uuid'] or uuid.UUID(identity).int == 0:
        raise ValueError('Canonical nonzero Incus VM UUID required')
    addresses = []
    for field in ('guest_ipv4', 'gateway_ipv4'):
        address = ipaddress.IPv4Address(manifest[field])
        if (not address.is_private or address.is_loopback or
                address.is_unspecified or address.is_multicast or
                address.is_link_local or address.is_reserved):
            raise ValueError('Dedicated private unicast IPv4 addresses required')
        addresses.append(address)
    if addresses[0] == addresses[1]:
        raise ValueError('Guest and host gateway must differ')
    return dict(manifest)


def render(manifest, live=False):
    m = validate(manifest)
    if live not in (True, False):
        raise ValueError('live must be true or false')
    relay_counter = '  counter allowed_live_relay { }\n' if live else ''
    relay_rule = (f"    ether type ip ip saddr {m['guest_ipv4']} ip daddr {m['gateway_ipv4']} udp sport {LIVE_UDP_PORT} "
                  f"udp dport {LIVE_RELAY_PORTS[0]}-{LIVE_RELAY_PORTS[1]} counter name allowed_live_relay accept\n"
                  if live else '')
    # The bridge prerouting hook covers both routed and same-bridge traffic,
    # including host input, without depending on br_netfilter or IP identity.
    # Static guest addressing is a precondition: DHCP and DNS are not admitted.
    # An earlier chain's accept cannot override this chain's drop verdict.
    return f'''# A3 proof VM {m['vm_uuid']}; host-owned; no other guest is selected.
add table bridge {TABLE}
flush table bridge {TABLE}
table bridge {TABLE} {{
  counter allowed_proxy {{ }}
{relay_counter}  counter denied_ipv4 {{ }}
  counter denied_ipv6 {{ }}
  counter denied_other {{ }}
  chain from_worker {{
    ether type arp arp saddr ip {m['guest_ipv4']} arp daddr ip {m['gateway_ipv4']} accept
    ether type ip ip saddr {m['guest_ipv4']} ip daddr {m['gateway_ipv4']} tcp dport {PROXY_PORT} counter name allowed_proxy accept
{relay_rule}    ether type ip counter name denied_ipv4 drop
    ether type ip6 counter name denied_ipv6 drop
    counter name denied_other drop
  }}
  chain worker_ingress {{
    type filter hook prerouting priority -300; policy accept;
    iifname "{TAP}" jump from_worker
  }}
}}
'''


def unit():
    # The future worker supervisor must Require this unit and verify the live
    # table before launch. The proof VM remains boot.autostart=false. Do not
    # add a global Incus dependency or restart other guests for this fixture.
    # It deliberately does not delete the fence on stop or service failure.
    return '''[Unit]
Description=A3 proof VM host network fence
Before=incus.service incus-startup.service
After=local-fs.target
RequiresMountsFor=/etc/proxypilot-a3-proof

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft --check --file /etc/proxypilot-a3-proof/fence.nft
ExecStart=/usr/sbin/nft --file /etc/proxypilot-a3-proof/fence.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
'''


def check_host(run=subprocess.run):
    """Read identity/network and ask the Linux kernel to check, never apply."""
    def query(path):
        return json.loads(run(['incus', 'query', path], check=True,
                              capture_output=True, text=True, timeout=20).stdout)
    instance = query('/1.0/instances/' + VM)
    if (instance.get('type') != 'virtual-machine' or
            instance.get('config', {}).get('volatile.uuid') != PROOF_UUID):
        raise ValueError('Proof VM identity changed; refusing host check')
    devices = instance.get('expanded_devices', {})
    nics = {k: v for k, v in devices.items() if v.get('type') == 'nic'}
    if set(nics) != {'eth0'} or nics['eth0'].get('network') != 'incusbr0':
        raise ValueError('Proof VM network changed; refusing host check')
    network = query('/1.0/networks/incusbr0')
    gateway = str(ipaddress.IPv4Interface(network['config']['ipv4.address']).ip)
    state = query('/1.0/instances/' + VM + '/state')
    addresses = {a.get('address') for nic in state.get('network', {}).values()
                 for a in nic.get('addresses', []) if a.get('family') == 'inet'}
    if '10.185.17.179' not in addresses or gateway != '10.185.17.1':
        raise ValueError('Observed VM/gateway addresses changed; refusing host check')
    manifest = dict(vm_name=VM, vm_uuid=PROOF_UUID, tap=TAP,
                    guest_ipv4='10.185.17.179', gateway_ipv4=gateway)
    rules = render(manifest)
    run(['nft', '--check', '--file', '-'], input=rules, check=True,
                 capture_output=True, text=True, timeout=20)
    return dict(nft_syntax='passed', vm_uuid=PROOF_UUID,
                current_tap=instance['config'].get('volatile.eth0.host_name'),
                planned_tap=TAP, installed=False,
                notice='Syntax only; no firewall rule or VM setting changed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path, nargs='?')
    parser.add_argument('--unit', action='store_true')
    parser.add_argument('--host-check', action='store_true',
                        help='Read the exact proof VM and run nft --check; never apply')
    args = parser.parse_args()
    if args.host_check:
        if args.manifest or args.unit:
            parser.error('--host-check cannot be combined with other arguments')
        print(json.dumps(check_host(), indent=2))
        return
    if not args.manifest:
        parser.error('manifest is required unless --host-check is selected')
    manifest = validate(json.loads(args.manifest.read_text(encoding='utf-8')))
    print(unit() if args.unit else render(manifest), end='')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print((error.stderr or str(error)).strip(), file=sys.stderr)
        sys.exit(1)
    except (ValueError, subprocess.TimeoutExpired) as error:
        print(f'A3 host check refused: {error}', file=sys.stderr)
        sys.exit(1)
