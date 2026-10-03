#!/usr/bin/env python3
"""Host-owned A4 credential and provider broker for the A3 proof VM.

Root only. a4-install-broker.py installs a reviewed copy of this file under
/etc/proxypilot-a4/broker; the git checkout is never executed. The broker
socket (/run/proxypilot-a4/broker.sock) answers uid 0 peers only and is never
mounted into the ProxyPilot backend container.

Credential path. A binding names one operator-authorized project, profile and
binding UUID, a revision, a non-secret username, and an OpenBao KV v2 path and
version: never a value. The A3 supervisor pins the binding revision per run
(`pin_run`) and asks `check` then `deliver` for `submit_bound_fixture`. At
delivery time the broker re-checks the binding, reads the value at the pinned
vault version with its own AppRole, and writes it once, through `incus exec`
standard input, into the worker runner's one-shot FIFO on the unit's private
tmpfs. The value is never returned on this socket, never journalled, never
logged, and no hash of it is kept anywhere: a hash of a low-entropy secret is a
leak. The OpenBao AppRole (and an Infisical project Admin, for values kept
there) can still read assigned values; this broker keeps the value away from
the model and the guest command channel, not from those principals.

Model path. Exactly one allowlisted provider/model route (MODEL_ROUTES), called
from the host with a provider key read from the vault at call time. The run's
token and spending policy is pinned by revision at launch. Each call reserves
its worst-case tokens and cost in a durable journal before anything is sent,
then settles the provider's reported usage at the operator-confirmed price
table revision. An unknown price, a missing usage report or an uncertain
outcome fails closed (the reservation is kept, never assumed zero). A call ID
is single-use: a retry with the same ID returns the recorded outcome and never
sends again, so a retry can never spend twice.
"""
import argparse
import base64
import decimal
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager

HERE = Path(__file__).resolve().parent
VM = 'pp-agents-a3-debian13-proof-20260927'
VM_UUID = '49592202-a8b0-45af-9ac6-5439761d73e4'
ORIGIN = 'https://demo.fractionate.ai'
UNIT_PREFIX = 'pp-a3-worker-'
CONFIG_DIR = Path('/etc/proxypilot-a4')
STATE_DIR = Path('/var/lib/proxypilot-a4')
INSTALL_DIR = CONFIG_DIR / 'broker'
CONFIG = CONFIG_DIR / 'broker-config.json'
JOURNAL = STATE_DIR / 'broker' / 'state.json'
INSTALL_JOURNAL = STATE_DIR / 'broker-install.json'
UNIT = Path('/etc/systemd/system/proxypilot-a4-broker.service')
RUN_DIR = Path('/run/proxypilot-a4')
SOCKET = RUN_DIR / 'broker.sock'
FRAME_MAGIC = b'PPA4'
MAX_FIELD = 256
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
KEY = re.compile(r'[A-Za-z][A-Za-z0-9_.-]{0,63}\Z')
MOUNT = re.compile(r'[a-z0-9][a-z0-9_-]{0,62}\Z')
AGENT = re.compile(r'[a-z][a-z0-9-]{1,39}\Z')
PRICE = re.compile(r'(0|[1-9][0-9]{0,3})(\.[0-9]{1,6})?\Z')
MAX_SAFE = 2 ** 53 - 1
# The single allowlisted route (operator-chosen 2026-09-28): OpenAI gpt-6-luna
# over Chat Completions, reasoning off so completion tokens are the visible
# output, standard tier only. Prices are NOT here: the operator confirms them
# into the journal's price table (`price_set`), and a missing price refuses.
MODEL_ROUTES = {'gpt-6-luna': {'provider': 'openai', 'url': 'https://api.openai.com/v1/chat/completions',
                               'service_tier': 'default'}}
MAX_OUTPUT_TOKENS = 4096
# A5: room for an approved guide in one model step (the supervisor checks it first).
MAX_PROMPT_BYTES = 16000
# A7: the automatic run summary is one more call on the run's pinned budget, with
# its own output cap; its text (bounded, untrusted) is the only model text that
# leaves the broker for the backend.
SUMMARY_MAX_OUTPUT_TOKENS = 300
SUMMARY_TEXT_CHARS = 800
# Operator-socket proofs (through the supervisor's operator model_step only):
# provider_error asks the provider with a zero token cap; the two A7 proofs never
# read the key or contact the provider, and settle a fixed reply instead.
MODEL_PROOFS = frozenset(('provider_error', 'reply_outside_set', 'usage_missing'))
PROVIDER_SECONDS = 60
# A byte-level BPE token covers at least one byte, so UTF-8 bytes bound the
# prompt tokens; the chat framing overhead is bounded generously on top.
MESSAGE_OVERHEAD_TOKENS = 16
REQUEST_OVERHEAD_TOKENS = 32
NANO = decimal.Decimal(1000)   # nano-USD per token for a price of 1 USD per 1M tokens
PRICE_FIELDS = ('input', 'cached_input', 'cache_write', 'output')
# The provider answered an error before any generation: nothing was consumed.
REJECTED_STATUSES = frozenset((400, 401, 403, 404, 409, 413, 415, 422, 429))
LIVE_CALL = frozenset(('reserved', 'sent', 'uncertain'))
BINDING_FIELDS = ('binding_id', 'project_id', 'profile_id', 'username', 'vault_key')
CREDENTIAL_FIELDS = ('project_id', 'profile_id', 'profile_revision', 'binding_id', 'binding_revision')

# Runs in the guest as root through `incus exec`; the frame arrives on stdin.
# It writes only into the named worker unit's own FIFO (cgroup and uid checked,
# no symlink, must be a FIFO owned by the worker) and prints a status code.
GUEST_WRITER = r'''import json, os, stat, sys, time
pid, unit = sys.argv[1], sys.argv[2]
def done(**out):
    print(json.dumps(out)); sys.exit(0)
if not pid.isdigit() or not unit.startswith('pp-a3-worker-'):
    done(ok=False, error='TARGET_MISMATCH')
try:
    group = open('/proc/%s/cgroup' % pid).read().strip().split(':')[-1]
    uid = [l.split()[1] for l in open('/proc/%s/status' % pid) if l.startswith('Uid:')][0]
except (OSError, IndexError):
    done(ok=False, error='TARGET_MISMATCH')
if group != '/system.slice/%s.service' % unit or uid != '65534':
    done(ok=False, error='TARGET_MISMATCH')
data = sys.stdin.buffer.read(1024)
path = '/proc/%s/root/tmp/pp-a4-credential' % pid
deadline, fd = time.monotonic() + 15, None
while fd is None:
    try:
        fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        if time.monotonic() >= deadline:
            done(ok=False, error='CHANNEL_NOT_OPEN')
        time.sleep(0.05)
info = os.fstat(fd)
if not stat.S_ISFIFO(info.st_mode) or info.st_uid != 65534:
    os.close(fd)
    done(ok=False, error='CHANNEL_MISMATCH')
os.set_blocking(fd, True)
view = memoryview(data)
while view:
    view = view[os.write(fd, view):]
os.close(fd)
done(ok=True)
'''


class Refused(Exception):
    """A typed refusal. Only the code and a fixed short detail leave the process."""

    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code = code
        self.detail = None if detail is None else str(detail)[:200]


def now():
    return time.time()


def stamp(value=None):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now() if value is None else value))


def exact(value, names):
    return isinstance(value, dict) and set(value) == set(names)


def safe_int(value, minimum=0):
    return type(value) is int and minimum <= value <= MAX_SAFE


def uuid_ok(value):
    return isinstance(value, str) and bool(UUID.fullmatch(value))


def wipe(buffer):
    if isinstance(buffer, bytearray):
        buffer[:] = b'\0' * len(buffer)


def printable(value):
    return 0 < len(value) <= MAX_FIELD and all(0x20 <= b <= 0x7e for b in value)


def frame(username, password):
    """PPA4 | u16 len | username | u16 len | password, into a fresh bytearray."""
    out = bytearray(FRAME_MAGIC)
    for part in (username, password):
        out += len(part).to_bytes(2, 'big')
        out += part
    return out


def secure(path):
    """Refuse symlinks or anything not exclusively root-owned on every ancestor."""
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise Refused('BOUNDARY_UNVERIFIED', 'symlink in a broker path')
        if part.exists():
            info = part.stat()
            if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
                raise Refused('BOUNDARY_UNVERIFIED', 'broker path not exclusively root-owned')


def save(path, text, mode=0o600):
    """Atomic, fsynced replacement: the journal is durable before any effect."""
    secure(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        try:
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def usd(nano):
    return str((decimal.Decimal(nano) / decimal.Decimal(10 ** 9)).quantize(decimal.Decimal('0.000000001')))


def nano_cost(tokens, price):
    """Integer nano-USD, rounded up, for `tokens` at `price` USD per 1M tokens."""
    return int((decimal.Decimal(tokens) * decimal.Decimal(price) * NANO).to_integral_value(decimal.ROUND_CEILING))


def budget_nano(max_usd):
    return int((decimal.Decimal(repr(max_usd)) * decimal.Decimal(10 ** 9)).to_integral_value(decimal.ROUND_FLOOR))


def worst_case(prompt_bytes, max_output_tokens, price):
    """Worst-case tokens and nano-USD before a call: every prompt byte a token at the
    higher of the input and cache-write rates, plus every allowed output token."""
    tokens_in = prompt_bytes + MESSAGE_OVERHEAD_TOKENS + REQUEST_OVERHEAD_TOKENS
    rate_in = max(decimal.Decimal(price['input']), decimal.Decimal(price['cache_write']))
    return (tokens_in + max_output_tokens,
            nano_cost(tokens_in, rate_in) + nano_cost(max_output_tokens, price['output']))


def proof_answer(proof, call_id, model, prompt_bytes):
    """A fixed provider reply for an operator proof; nothing is sent anywhere."""
    body = {'id': 'proof-%s-%s' % (proof, call_id), 'model': model,
            'choices': [{'message': {'content': 'I would choose shell' if proof == 'reply_outside_set' else 'read_files'},
                         'finish_reason': 'stop'}]}
    if proof == 'reply_outside_set':
        body['usage'] = {'prompt_tokens': prompt_bytes // 4 + 1, 'completion_tokens': 5,
                         'total_tokens': prompt_bytes // 4 + 6}
    return 200, body


def settle_usage(body, requested, route, price, excerpt=200):
    """Validate a 200 response and price its usage; any doubt raises Refused."""
    if not isinstance(body, dict) or not isinstance(body.get('id'), str) or not 0 < len(body['id']) <= 200:
        raise Refused('USAGE_MISSING', 'response id')
    model = body.get('model')
    if not isinstance(model, str) or not (model == requested or model.startswith(requested + '-')):
        raise Refused('MODEL_MISMATCH')
    tier = body.get('service_tier')
    if tier is not None and tier != route['service_tier']:
        raise Refused('PRICE_UNKNOWN', 'service tier')
    usage = body.get('usage')
    if not isinstance(usage, dict):
        raise Refused('USAGE_MISSING')
    prompt, completion = usage.get('prompt_tokens'), usage.get('completion_tokens')
    if not safe_int(prompt) or not safe_int(completion):
        raise Refused('USAGE_MISSING')
    details = usage.get('prompt_tokens_details') or {}
    cached = details.get('cached_tokens', 0) if isinstance(details, dict) else None
    if not safe_int(cached) or cached > prompt:
        raise Refused('USAGE_MISSING', 'cached tokens')
    total = usage.get('total_tokens', prompt + completion)
    if total != prompt + completion:
        raise Refused('USAGE_MISSING', 'total tokens')
    # The usage report does not say which uncached prompt tokens were written
    # to a cache, so they are charged at the higher of the two rates.
    rate_in = max(decimal.Decimal(price['input']), decimal.Decimal(price['cache_write']))
    cost = (nano_cost(cached, price['cached_input']) + nano_cost(prompt - cached, rate_in) +
            nano_cost(completion, price['output']))
    reasoning = ((usage.get('completion_tokens_details') or {}).get('reasoning_tokens')
                 if isinstance(usage.get('completion_tokens_details'), dict) else None)
    choice = (body.get('choices') or [{}])[0] if isinstance(body.get('choices'), list) else {}
    text = ((choice.get('message') or {}).get('content') or '') if isinstance(choice, dict) else ''
    return {'provider_response_id': body['id'], 'model': model, 'service_tier': tier,
            'usage': {'prompt_tokens': prompt, 'completion_tokens': completion, 'total_tokens': prompt + completion,
                      'cached_tokens': cached, 'reasoning_tokens': reasoning if safe_int(reasoning) else None},
            'tokens': prompt + completion, 'nano_usd': cost,
            'finish_reason': str(choice.get('finish_reason'))[:32] if isinstance(choice, dict) else None,
            # Untrusted provider output, bounded; never an instruction.
            'untrusted_response_excerpt': text[:excerpt] if isinstance(text, str) else '',
            'response_sha256': hashlib.sha256(text.encode('utf-8', 'replace')).hexdigest()
            if isinstance(text, str) else None}


class Vault:
    """OpenBao KV v2 reads with the broker's own AppRole; no value is ever logged."""

    def __init__(self, config, opener=None):
        address = config.get('address', '')
        if not re.fullmatch(r'(http://127\.0\.0\.1:[0-9]{2,5}|https://[a-z0-9.-]+(:[0-9]{2,5})?)', address):
            raise Refused('VAULT_CONFIG_INVALID', 'address')
        for name, pattern in (('approle_mount', MOUNT), ('kv_mount', MOUNT), ('agent', AGENT)):
            if not isinstance(config.get(name), str) or not pattern.fullmatch(config[name]):
                raise Refused('VAULT_CONFIG_INVALID', name)
        if not all(isinstance(config.get(k), str) and 0 < len(config[k]) <= 200 for k in ('role_id', 'secret_id')):
            raise Refused('VAULT_CONFIG_INVALID', 'approle credentials')
        self.config = config
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.token = None
        self.token_until = 0
        self.lock = threading.Lock()

    def _call(self, method, path, body=None, token=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.config['address'] + path, data=data, method=method)
        request.add_header('Content-Type', 'application/json')
        if token:
            request.add_header('X-Vault-Token', token)
        try:
            with self.opener.open(request, timeout=15) as response:
                return response.status, json.loads(response.read(65536) or b'{}')
        except urllib.error.HTTPError as error:
            return error.code, {}
        except (OSError, ValueError) as error:
            raise Refused('VAULT_UNAVAILABLE') from error

    def _token(self):
        with self.lock:
            if self.token and time.monotonic() < self.token_until:
                return self.token
            status, body = self._call('POST', '/v1/auth/%s/login' % self.config['approle_mount'],
                                      {'role_id': self.config['role_id'], 'secret_id': self.config['secret_id']})
            auth = body.get('auth') if isinstance(body, dict) else None
            if status != 200 or not isinstance(auth, dict) or not isinstance(auth.get('client_token'), str):
                raise Refused('VAULT_UNAVAILABLE', 'approle login refused')
            lease = auth.get('lease_duration') if safe_int(auth.get('lease_duration'), 1) else 300
            self.token, self.token_until = auth['client_token'], time.monotonic() + max(30, lease - 60)
            return self.token

    def path(self, key):
        if not isinstance(key, str) or not KEY.fullmatch(key):
            raise Refused('INVALID_REQUEST', 'vault key')
        return 'agents/%s/%s' % (self.config['agent'], key)

    def current_version(self, key):
        status, body = self._call('GET', '/v1/%s/metadata/%s' % (self.config['kv_mount'], self.path(key)),
                                  token=self._token())
        data = body.get('data') if isinstance(body, dict) else None
        if status == 404:
            raise Refused('VAULT_KEY_MISSING')
        if status != 200 or not isinstance(data, dict) or not safe_int(data.get('current_version'), 1):
            raise Refused('VAULT_UNAVAILABLE', 'metadata')
        version = (data.get('versions') or {}).get(str(data['current_version'])) or {}
        if version.get('destroyed') or version.get('deletion_time'):
            raise Refused('VAULT_KEY_MISSING', 'current version deleted')
        return data['current_version']

    def read(self, key, version):
        """The value at exactly `version`, as a bytearray the caller must wipe."""
        if self.current_version(key) != version:
            raise Refused('VAULT_VERSION_MISMATCH')
        status, body = self._call('GET', '/v1/%s/data/%s?version=%d' % (self.config['kv_mount'], self.path(key),
                                                                         version), token=self._token())
        data = body.get('data') if isinstance(body, dict) else None
        if status != 200 or not isinstance(data, dict) or (data.get('metadata') or {}).get('version') != version:
            raise Refused('VAULT_UNAVAILABLE', 'read')
        value = (data.get('data') or {}).get('value')
        if not isinstance(value, str):
            raise Refused('VAULT_KEY_MISSING', 'no value field')
        out = bytearray(value.encode('utf-8'))
        del value, data, body
        return out

    def healthy(self):
        try:
            status, body = self._call('GET', '/v1/sys/health')
        except Refused:
            return False
        return status == 200 and isinstance(body, dict) and body.get('sealed') is False


class Host:
    """Every external effect; tests replace this object."""

    def run(self, argv, data=None, timeout=30):
        return subprocess.run(argv, input=data, capture_output=True, timeout=timeout)

    def guest_main_pid(self, unit):
        result = self.run(['incus', 'exec', VM, '--', 'systemctl', 'show', unit + '.service', '--property=MainPID',
                           '--property=ActiveState', '--no-pager'], timeout=30)
        values = dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)
        if result.returncode or values.get('ActiveState') != 'active' or not re.fullmatch(r'[1-9][0-9]*',
                                                                                          values.get('MainPID', '')):
            raise Refused('WORKER_NOT_RUNNING')
        return int(values['MainPID'])

    def write_credential(self, pid, unit, data):
        """The value travels only on this command's standard input."""
        try:
            result = self.run(['incus', 'exec', VM, '--', '/usr/bin/python3', '-I', '-c', GUEST_WRITER, str(pid), unit],
                              data=bytes(data), timeout=40)
        except subprocess.TimeoutExpired as error:
            raise Refused('DELIVERY_FAILED', 'writer timeout') from error
        try:
            reply = json.loads(result.stdout.decode().strip().splitlines()[-1])
        except (ValueError, IndexError) as error:
            raise Refused('DELIVERY_FAILED', 'writer exit %s' % result.returncode) from error
        if reply.get('ok') is not True:
            raise Refused('DELIVERY_FAILED', str(reply.get('error'))[:32])

    def provider(self, url, key, body, timeout=PROVIDER_SECONDS):
        """One HTTPS POST from the host; no retries. Returns (status, parsed body)."""
        request = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST')
        request.add_header('Content-Type', 'application/json')
        request.add_header('Authorization', 'Bearer ' + bytes(key).decode('ascii'))
        opener = urllib.request.build_opener()
        try:
            with opener.open(request, timeout=timeout) as response:
                raw = response.read(1024 * 1024)
                status = response.status
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read(65536)
        try:
            return status, json.loads(raw)
        except ValueError:
            return status, None

    def verify_install(self):
        secure(INSTALL_JOURNAL)
        try:
            data = json.loads(INSTALL_JOURNAL.read_text())
        except (OSError, ValueError) as error:
            raise Refused('BOUNDARY_UNVERIFIED', 'broker install journal') from error
        if data.get('version') != 1 or data.get('phase') != 'installed' or data.get('vm_uuid') != VM_UUID:
            raise Refused('BOUNDARY_UNVERIFIED', 'broker install incomplete')
        for path in (INSTALL_DIR / 'a4-credential-broker.py', UNIT):
            secure(path)
            if data.get('files', {}).get(str(path)) != hashlib.sha256(path.read_bytes()).hexdigest():
                raise Refused('BOUNDARY_UNVERIFIED', 'broker file changed')
        return data


def load_config(path=CONFIG):
    secure(path)
    if not path.is_file():
        raise Refused('VAULT_CONFIG_MISSING')
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise Refused('BOUNDARY_UNVERIFIED', 'broker config readable by others')
    try:
        return json.loads(path.read_text())
    except ValueError as error:
        raise Refused('VAULT_CONFIG_INVALID') from error


class Broker:
    def __init__(self, host=None, vault=None, journal=JOURNAL, clock=now):
        self.host = host or Host()
        self.vault = vault
        self.journal_path = journal
        self.clock = clock
        self.lock = threading.RLock()
        self.model_lock = threading.Lock()
        self.state = self._load()

    # ------------------------------------------------------------ journal

    def _load(self):
        if not self.journal_path.exists():
            return {'version': 1, 'vm_uuid': VM_UUID, 'bindings': {}, 'provider': None,
                    'prices': {'revision': 0, 'updated_at': None, 'models': {}}, 'runs': {}, 'calls': {},
                    'deliveries': [], 'events': []}
        secure(self.journal_path)
        data = json.loads(self.journal_path.read_text())
        if data.get('version') != 1 or data.get('vm_uuid') != VM_UUID:
            raise Refused('JOURNAL_INVALID')
        return data

    def _save(self):
        save(self.journal_path, json.dumps(self.state, indent=1, sort_keys=True) + '\n')

    def _event(self, kind, **fields):
        self.state['events'].append({'at': stamp(self.clock()), 'kind': kind, **fields})
        del self.state['events'][:-500]

    def _vault(self):
        if self.vault is None:
            self.vault = Vault(load_config())
        return self.vault

    def recover(self):
        """After a restart: never resend. A call journalled `sent` is uncertain and
        keeps its reservation; one only `reserved` was never sent and is released."""
        with self.lock:
            for call in self.state['calls'].values():
                if call['state'] == 'sent':
                    call['state'] = 'uncertain'
                    call['refusal'] = 'CALL_UNCERTAIN'
                elif call['state'] == 'reserved':
                    self._release(call, 'abandoned')
            self._save()

    # ----------------------------------------------------------- bindings

    def bind(self, params):
        if not exact(params, BINDING_FIELDS) or not all(uuid_ok(params[k]) for k in
                                                         ('binding_id', 'project_id', 'profile_id')):
            raise Refused('INVALID_REQUEST')
        username = params['username'].encode() if isinstance(params['username'], str) else b''
        if not printable(username) or not re.fullmatch(rb'[a-z0-9._+-]+@[a-z0-9.-]+', username):
            raise Refused('INVALID_REQUEST', 'username')
        version = self._vault().current_version(params['vault_key'])
        with self.lock:
            if params['binding_id'] in self.state['bindings']:
                raise Refused('BINDING_EXISTS')
            record = {'binding_id': params['binding_id'], 'project_id': params['project_id'],
                      'profile_id': params['profile_id'], 'username': params['username'],
                      'origin': ORIGIN, 'vault': {'mount': self._vault().config['kv_mount'],
                                                  'path': self._vault().path(params['vault_key']),
                                                  'key': params['vault_key'], 'version': version},
                      'revision': 1, 'state': 'active', 'created_at': stamp(self.clock()),
                      'history': [{'revision': 1, 'vault_version': version, 'at': stamp(self.clock())}]}
            self.state['bindings'][params['binding_id']] = record
            self._event('binding_created', binding_id=params['binding_id'], revision=1)
            self._save()
            return self._public_binding(record)

    def rotate(self, params):
        if not exact(params, ('binding_id', 'expected_revision')) or not uuid_ok(params['binding_id']) \
                or not safe_int(params['expected_revision'], 1):
            raise Refused('INVALID_REQUEST')
        with self.lock:
            record = self._binding(params['binding_id'])
            if record['revision'] != params['expected_revision']:
                raise Refused('BINDING_REVISION_MISMATCH')
            key = record['vault']['key']
        version = self._vault().current_version(key)
        with self.lock:
            record = self._binding(params['binding_id'])
            if record['revision'] != params['expected_revision']:
                raise Refused('BINDING_REVISION_MISMATCH')
            record['revision'] += 1
            changed = version != record['vault']['version']
            record['vault']['version'] = version
            record['rotated_at'] = stamp(self.clock())
            record['history'].append({'revision': record['revision'], 'vault_version': version,
                                      'value_changed': changed, 'at': record['rotated_at']})
            del record['history'][:-50]
            self._event('binding_rotated', binding_id=record['binding_id'], revision=record['revision'])
            self._save()
            return self._public_binding(record)

    def revoke(self, params):
        if not exact(params, ('binding_id',)) or not uuid_ok(params['binding_id']):
            raise Refused('INVALID_REQUEST')
        with self.lock:
            record = self._binding(params['binding_id'])
            record['state'] = 'revoked'
            record['revoked_at'] = stamp(self.clock())
            self._event('binding_revoked', binding_id=record['binding_id'], revision=record['revision'])
            self._save()
            return {**self._public_binding(record), 'revoked_at_epoch': self.clock()}

    def _binding(self, binding_id, active=True):
        record = self.state['bindings'].get(binding_id)
        if record is None:
            raise Refused('BINDING_UNKNOWN')
        if active and record['state'] != 'active':
            raise Refused('BINDING_REVOKED')
        return record

    @staticmethod
    def _public_binding(record):
        return {k: record[k] for k in ('binding_id', 'project_id', 'profile_id', 'username', 'origin', 'vault',
                                       'revision', 'state')}

    def bindings(self, _params=None):
        with self.lock:
            return {'bindings': [self._public_binding(r) for r in self.state['bindings'].values()]}

    # ------------------------------------------------------- run pinning

    def pin_run(self, params):
        if not exact(params, ('run_id', 'project_limits_revision', 'limits', 'credential')) \
                or not uuid_ok(params['run_id']) or not safe_int(params['project_limits_revision']):
            raise Refused('INVALID_REQUEST')
        limits = params['limits']
        if not isinstance(limits, dict) or not set(limits) <= {'max_tokens', 'max_usd'} or (
                'max_tokens' in limits and not safe_int(limits['max_tokens'], 1)) or (
                'max_usd' in limits and (type(limits['max_usd']) not in (int, float) or
                                         not 0 < limits['max_usd'] < 1e6)):
            raise Refused('INVALID_REQUEST', 'limits')
        credential = params['credential']
        if credential is not None and (not exact(credential, CREDENTIAL_FIELDS) or not all(
                uuid_ok(credential[k]) for k in ('project_id', 'profile_id', 'binding_id')) or not safe_int(
                credential['profile_revision'], 1) or not safe_int(credential['binding_revision'], 1)):
            raise Refused('INVALID_REQUEST', 'credential')
        with self.lock:
            if credential is not None:
                record = self._binding(credential['binding_id'])
                if record['project_id'] != credential['project_id'] or record['profile_id'] != credential['profile_id']:
                    raise Refused('BINDING_SCOPE_MISMATCH')
                if record['revision'] != credential['binding_revision']:
                    raise Refused('BINDING_REVISION_MISMATCH')
            pins = {'project_limits_revision': params['project_limits_revision'], 'limits': dict(limits),
                    'credential': None if credential is None else dict(credential)}
            run = self.state['runs'].get(params['run_id'])
            if run is not None:
                if any(run[k] != v for k, v in pins.items()):
                    raise Refused('RUN_POLICY_MISMATCH')
                return {'pinned': True, 'existing': True}
            self.state['runs'][params['run_id']] = dict(pins, pinned_at=stamp(self.clock()),
                                                       tokens={'reserved': 0, 'settled': 0},
                                                       nano_usd={'reserved': 0, 'settled': 0})
            self._event('run_pinned', run_id=params['run_id'],
                        binding_revision=None if credential is None else credential['binding_revision'])
            self._save()
            return {'pinned': True, 'existing': False}

    def _usable(self, run_id, binding_id):
        """The binding pinned to this run, only while it is active at the pinned revision."""
        run = self.state['runs'].get(run_id)
        if run is None:
            raise Refused('RUN_NOT_PINNED')
        pinned = run['credential']
        if pinned is None:
            raise Refused('CREDENTIAL_NOT_BOUND')
        if pinned['binding_id'] != binding_id:
            raise Refused('BINDING_MISMATCH')
        record = self._binding(binding_id)
        if record['revision'] != pinned['binding_revision']:
            raise Refused('BINDING_REVISION_MISMATCH')
        return record, pinned

    def check(self, params):
        if not exact(params, ('run_id', 'binding_id')) or not uuid_ok(params['run_id']) \
                or not uuid_ok(params['binding_id']):
            raise Refused('INVALID_REQUEST')
        with self.lock:
            record, _ = self._usable(params['run_id'], params['binding_id'])
            return {'usable': True, 'binding_id': record['binding_id'], 'binding_revision': record['revision']}

    def deliver(self, params):
        if not exact(params, ('run_id', 'attempt_id', 'binding_id')) or not all(
                uuid_ok(params[k]) for k in ('run_id', 'attempt_id', 'binding_id')):
            raise Refused('INVALID_REQUEST')
        entry = {'at': stamp(self.clock()), 'run_id': params['run_id'], 'attempt_id': params['attempt_id'],
                 'binding_id': params['binding_id']}
        value = None
        try:
            with self.lock:
                record, pinned = self._usable(params['run_id'], params['binding_id'])
                entry['binding_revision'] = pinned['binding_revision']
                username = bytearray(record['username'].encode())
                key, version = record['vault']['key'], record['vault']['version']
            unit = UNIT_PREFIX + params['attempt_id']
            pid = self.host.guest_main_pid(unit)
            # Fetched at delivery time, at exactly the pinned vault version.
            value = self._vault().read(key, version)
            if not printable(value):
                raise Refused('VALUE_UNSUPPORTED')
            data = frame(username, value)
            try:
                with self.lock:
                    # Revocation or rotation while fetching wins over delivery.
                    self._usable(params['run_id'], params['binding_id'])
                self.host.write_credential(pid, unit, data)
            finally:
                wipe(data)
            entry['outcome'] = 'delivered'
            return {'delivered': True, 'binding_id': params['binding_id'],
                    'binding_revision': entry['binding_revision']}
        except Refused as error:
            entry['outcome'] = 'refused:' + error.code
            raise
        finally:
            wipe(value)
            with self.lock:
                self.state['deliveries'].append(entry)
                del self.state['deliveries'][:-500]
                self._save()

    # --------------------------------------------------------- model route

    def provider_bind(self, params):
        if not exact(params, ('vault_key',)):
            raise Refused('INVALID_REQUEST')
        version = self._vault().current_version(params['vault_key'])
        with self.lock:
            revision = (self.state['provider'] or {}).get('revision', 0) + 1
            self.state['provider'] = {'vault_key': params['vault_key'], 'vault_version': version,
                                      'revision': revision, 'updated_at': stamp(self.clock())}
            self._event('provider_key_bound', revision=revision)
            self._save()
            return dict(self.state['provider'])

    def price_set(self, params):
        if not exact(params, ('model', *PRICE_FIELDS)) or params['model'] not in MODEL_ROUTES or not all(
                isinstance(params[k], str) and PRICE.fullmatch(params[k]) for k in PRICE_FIELDS):
            raise Refused('INVALID_REQUEST')
        with self.lock:
            prices = self.state['prices']
            prices['revision'] += 1
            prices['updated_at'] = stamp(self.clock())
            prices['models'][params['model']] = {k: params[k] for k in PRICE_FIELDS}
            self._event('price_set', model=params['model'], revision=prices['revision'])
            self._save()
            return json.loads(json.dumps(prices))

    def price_clear(self, params):
        if not exact(params, ('model',)) or params['model'] not in MODEL_ROUTES:
            raise Refused('INVALID_REQUEST')
        with self.lock:
            prices = self.state['prices']
            prices['revision'] += 1
            prices['updated_at'] = stamp(self.clock())
            prices['models'].pop(params['model'], None)
            self._event('price_cleared', model=params['model'], revision=prices['revision'])
            self._save()
            return json.loads(json.dumps(prices))

    def _release(self, call, state, refusal=None):
        run = self.state['runs'].get(call['run_id'])
        if run is not None and call.get('reserved_tokens'):
            run['tokens']['reserved'] -= call['reserved_tokens']
            run['nano_usd']['reserved'] -= call['reserved_nano_usd']
        call['state'] = state
        call['settled_tokens'], call['settled_nano_usd'] = 0, 0
        if refusal:
            call['refusal'] = refusal

    def _settle(self, call, tokens, nano):
        run = self.state['runs'][call['run_id']]
        run['tokens']['reserved'] -= call['reserved_tokens']
        run['nano_usd']['reserved'] -= call['reserved_nano_usd']
        run['tokens']['settled'] += tokens
        run['nano_usd']['settled'] += nano
        call['settled_tokens'], call['settled_nano_usd'] = tokens, nano
        call['settled_usd'] = usd(nano)

    @staticmethod
    def _call_result(call):
        keys = ('call_id', 'run_id', 'state', 'model_requested', 'provider_response_id', 'model', 'usage',
                'settled_usd', 'reserved_usd', 'price_table_revision', 'finish_reason', 'untrusted_response_excerpt',
                'http_status', 'latency_ms')
        return {k: call.get(k) for k in keys}

    def _refuse_call(self, call, code):
        """Record a call refused before anything was sent, then refuse."""
        call.update(state='refused', refusal=code, finished_at=stamp(self.clock()))
        self.state['calls'][call['call_id']] = call
        self._save()
        raise Refused(code)

    def model_call(self, params):
        proof = None
        if isinstance(params, dict) and 'proof' in params:
            params = dict(params)
            proof = params.pop('proof')
            if proof not in MODEL_PROOFS:
                raise Refused('INVALID_REQUEST', 'proof')
        return self._model_call(params, proof, MAX_OUTPUT_TOKENS, 200)

    def summary_call(self, params):
        """A7: one summary of a finished run, on the run's pinned budget."""
        result = self._model_call(params, None, SUMMARY_MAX_OUTPUT_TOKENS, SUMMARY_TEXT_CHARS)
        return dict(result, kind='summary')

    def review_call(self, params):
        """One public read-only review, using the existing provider and ledger.

        No website binding or vault value is delivered to the dashboard. The
        supervisor builds the bounded data-only prompt and independently pins
        task provenance; all existing reservation/settlement rules still apply.
        """
        fields = ('run_id', 'call_id', 'project_limits_revision', 'model', 'max_output_tokens', 'prompt', 'deadline_at')
        if (not exact(params, fields) or not uuid_ok(params['run_id']) or not uuid_ok(params['call_id'])
                or not isinstance(params['deadline_at'], str)):
            raise Refused('INVALID_REQUEST')
        try:
            parsed = datetime.datetime.fromisoformat(params['deadline_at'].replace('Z', '+00:00'))
            if parsed.utcoffset() is None:
                raise ValueError('timezone required')
            deadline = parsed.timestamp()
        except (ValueError, TypeError, OverflowError):
            raise Refused('INVALID_REQUEST')
        remaining = deadline - self.clock()
        if not 0 < remaining <= 180:
            raise Refused('DEADLINE')
        control = {'run_id': params['run_id'], 'deadline': deadline,
                   'deadline_at': params['deadline_at'], 'monotonic_deadline': time.monotonic() + remaining}
        with self.lock:
            self._review_allowed(control)
            run = self.state['runs'].get(params.get('run_id'))
            if run is None or run.get('credential') is not None:
                raise Refused('RUN_NOT_PINNED')
            previous = self.state['calls'].get(params.get('call_id'))
            if previous is not None and (previous.get('kind') != 'public_review' or
                    previous.get('run_id') != params.get('run_id') or
                    previous.get('prompt_sha256') != hashlib.sha256(str(params.get('prompt')).encode('utf-8')).hexdigest() or
                    previous.get('max_output_tokens') != params.get('max_output_tokens') or
                    previous.get('deadline_at') != params['deadline_at']):
                raise Refused('RUN_POLICY_MISMATCH')
        request = {k: v for k, v in params.items() if k != 'deadline_at'}
        return dict(self._model_call(request, None, 1500, 10000, control), kind='public_review')

    def cancel_review(self, params):
        if not exact(params, ('run_id',)) or not uuid_ok(params['run_id']):
            raise Refused('INVALID_REQUEST')
        with self.lock:
            # A tombstone also covers cancellation that arrives before pin_run
            # or a queued review RPC. It never changes legacy model/credential
            # methods, releases an accepted call, or authorizes replay.
            self.state.setdefault('review_cancellations', {})[params['run_id']] = stamp(self.clock())
            accepted = any(c.get('kind') == 'public_review' and c.get('run_id') == params['run_id']
                           and c.get('state') not in ('reserved', 'refused')
                           for c in self.state['calls'].values())
            self._save()
        return {'cancelled': True, 'provider_already_accepted': accepted}

    def _review_allowed(self, control, call=None):
        if control is None:
            return
        code = 'CANCELLED' if control['run_id'] in self.state.get('review_cancellations', {}) else (
            'DEADLINE' if self.clock() >= control['deadline'] or time.monotonic() >= control['monotonic_deadline'] else None)
        if code:
            if call is not None and call['state'] == 'reserved':
                # No provider admission occurred, so only this unsent call's
                # reservation can be released. Accepted calls still settle.
                self._release(call, 'refused', code)
                self._save()
            raise Refused(code)

    @contextmanager
    def _model_admission(self, control):
        if control is None:
            with self.model_lock:
                yield
            return
        while True:
            with self.lock:
                self._review_allowed(control)
            remaining = min(control['deadline'] - self.clock(), control['monotonic_deadline'] - time.monotonic())
            if self.model_lock.acquire(timeout=max(0, min(0.1, remaining))):
                try:
                    with self.lock:
                        self._review_allowed(control)
                    yield
                finally:
                    self.model_lock.release()
                return

    def browser_model_call(self, params):
        """Versioned selected-browser inference, using existing host key custody.

        No website credential can be attached. Images are pinned private data,
        not URLs to fetch. Every encoded image byte is reserved as a token;
        absent budgets/prices never become an assumed free multimodal call.
        """
        fields = ('run_id', 'call_id', 'project_limits_revision', 'model', 'max_output_tokens',
                  'prompt', 'image_inputs', 'deadline_at', 'price_table_revision', 'reservation')
        if (not exact(params, fields) or not uuid_ok(params['run_id']) or not uuid_ok(params['call_id']) or
                not isinstance(params['image_inputs'], list) or len(params['image_inputs']) > 8 or not safe_int(params['price_table_revision'],1) or
                not exact(params['reservation'],('tokens','usd')) or not safe_int(params['reservation']['tokens'],1) or
                type(params['reservation']['usd']) not in (int,float) or not 0<=params['reservation']['usd']<=20):
            raise Refused('INVALID_REQUEST')
        try:
            parsed = datetime.datetime.fromisoformat(params['deadline_at'].replace('Z', '+00:00'))
            if parsed.utcoffset() is None:
                raise ValueError('timezone required')
            remaining = parsed.timestamp() - self.clock()
            if not 0 < remaining <= 180:
                raise Refused('DEADLINE')
        except (ValueError, TypeError, AttributeError, OverflowError):
            raise Refused('INVALID_REQUEST')
        pins, images, encoded_bytes, decoded_bytes = [], [], 0, 0
        for image in params['image_inputs']:
            if (not exact(image, ('mime_type', 'sha256', 'base64')) or
                    image['mime_type'] not in ('image/png', 'image/jpeg') or
                    not isinstance(image['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', image['sha256']) or
                    not isinstance(image['base64'], str) or len(image['base64']) > 2796204):
                raise Refused('INVALID_REQUEST')
            try:
                raw = base64.b64decode(image['base64'], validate=True)
            except (ValueError, TypeError):
                raise Refused('INVALID_REQUEST')
            decoded_bytes += len(raw)
            if (not raw or base64.b64encode(raw).decode() != image['base64'] or
                    hashlib.sha256(raw).hexdigest() != image['sha256']):
                raise Refused('INVALID_REQUEST')
            encoded_bytes += len(image['base64']) + 256
            pins.append({'mime_type': image['mime_type'], 'sha256': image['sha256'], 'byte_count': len(raw)})
            images.append({'type': 'image_url', 'image_url': {'url': 'data:%s;base64,%s' %
                           (image['mime_type'], image['base64']), 'detail': 'low'}})
        if decoded_bytes > 2 * 1024 * 1024:
            raise Refused('INVALID_REQUEST')
        control = {'run_id': params['run_id'], 'deadline': parsed.timestamp(), 'deadline_at': params['deadline_at'],
                   'monotonic_deadline': time.monotonic() + remaining}
        pin_hash = hashlib.sha256(json.dumps(pins, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        with self.lock:
            self._review_allowed(control)
            run = self.state['runs'].get(params['run_id'])
            if run is None or run.get('credential') is not None or not all(k in run['limits'] for k in ('max_tokens', 'max_usd')):
                raise Refused('RUN_NOT_PINNED')
            if params['reservation']['tokens']>run['limits']['max_tokens'] or params['reservation']['usd']>run['limits']['max_usd']:
                raise Refused('BUDGET_EXHAUSTED')
            previous = self.state['calls'].get(params['call_id'])
            if previous is not None and (previous.get('kind') != 'selected_browser_model' or
                    previous.get('run_id') != params['run_id'] or previous.get('image_inputs_sha256') != pin_hash or
                    previous.get('price_table_revision') != params['price_table_revision'] or
                    previous.get('prompt_sha256') != hashlib.sha256(str(params['prompt']).encode('utf-8')).hexdigest() or
                    previous.get('max_output_tokens') != params['max_output_tokens'] or previous.get('deadline_at') != params['deadline_at']):
                raise Refused('RUN_POLICY_MISMATCH')
        request = {k: v for k, v in params.items() if k not in ('image_inputs', 'deadline_at', 'price_table_revision', 'reservation')}
        return dict(self._model_call(request, None, 6000, 60000, control,
                    browser_input={'pins_sha256': pin_hash, 'encoded_bytes': encoded_bytes, 'images': images,
                                   'price_table_revision':params['price_table_revision'],'reservation':params['reservation']}),
                    kind='selected_browser_model')

    def cancel_browser_model(self, params):
        if not exact(params, ('run_id',)) or not uuid_ok(params['run_id']):
            raise Refused('INVALID_REQUEST')
        with self.lock:
            self.state.setdefault('review_cancellations', {})[params['run_id']] = stamp(self.clock())
            accepted = any(c.get('kind') == 'selected_browser_model' and c.get('run_id') == params['run_id'] and
                           c.get('state') not in ('reserved', 'refused') for c in self.state['calls'].values())
            self._save()
        return {'cancelled': True, 'provider_already_accepted': accepted}

    def _model_call(self, params, proof, max_output, excerpt, review_control=None, browser_input=None):
        fields = ('run_id', 'call_id', 'project_limits_revision', 'model', 'max_output_tokens', 'prompt')
        if (not exact(params, fields) or not uuid_ok(params['run_id']) or not uuid_ok(params['call_id'])
                or not safe_int(params['project_limits_revision']) or not isinstance(params['model'], str)
                or not safe_int(params['max_output_tokens'], 1) or params['max_output_tokens'] > max_output
                or not isinstance(params['prompt'], str)):
            raise Refused('INVALID_REQUEST')
        prompt_bytes = len(params['prompt'].encode('utf-8'))
        if not 0 < prompt_bytes <= MAX_PROMPT_BYTES:
            raise Refused('INVALID_REQUEST', 'prompt size')
        if browser_input is not None:
            prompt_bytes += browser_input['encoded_bytes']
        with self._model_admission(review_control):
            with self.lock:
                self._review_allowed(review_control)
                existing = self.state['calls'].get(params['call_id'])
                if existing is not None:
                    # Single-use call IDs: a retry returns the record and never sends.
                    if existing['state'] in LIVE_CALL:
                        raise Refused('CALL_UNCERTAIN')
                    if existing['state'] != 'settled':
                        raise Refused(existing.get('refusal') or 'CALL_REFUSED')
                    return dict(self._call_result(existing), replayed=True)
                call = {'call_id': params['call_id'], 'run_id': params['run_id'], 'model_requested': params['model'],
                        'kind': 'selected_browser_model' if browser_input is not None else 'public_review' if excerpt == 10000 else 'summary' if max_output == SUMMARY_MAX_OUTPUT_TOKENS else 'step',
                        'max_output_tokens': params['max_output_tokens'], 'prompt_bytes': prompt_bytes,
                        'prompt_sha256': hashlib.sha256(params['prompt'].encode('utf-8')).hexdigest(),
                        'started_at': stamp(self.clock()), 'price_table_revision': self.state['prices']['revision']}
                if review_control is not None:
                    call['deadline_at'] = review_control['deadline_at']
                if browser_input is not None:
                    call['image_inputs_sha256'] = browser_input['pins_sha256']
                run = self.state['runs'].get(params['run_id'])
                if run is None:
                    self._refuse_call(call, 'RUN_NOT_PINNED')
                if params['project_limits_revision'] != run['project_limits_revision']:
                    self._refuse_call(call, 'REVISION_MISMATCH')
                route = MODEL_ROUTES.get(params['model'])
                if route is None:
                    self._refuse_call(call, 'MODEL_NOT_ALLOWED')
                price = self.state['prices']['models'].get(params['model'])
                if price is None:
                    self._refuse_call(call, 'PRICE_UNKNOWN')
                if browser_input is not None and self.state['prices']['revision']!=browser_input['price_table_revision']:
                    self._refuse_call(call, 'PRICE_CHANGED')
                provider = self.state['provider']
                if provider is None:
                    self._refuse_call(call, 'PROVIDER_KEY_UNBOUND')
                output_tokens = 0 if proof == 'provider_error' else params['max_output_tokens']
                tokens, nano = worst_case(prompt_bytes, output_tokens, price)
                if browser_input is not None and (tokens>browser_input['reservation']['tokens'] or nano>budget_nano(browser_input['reservation']['usd'])):
                    self._refuse_call(call, 'RESERVATION_TOO_SMALL')
                limits = run['limits']
                if 'max_tokens' in limits and (run['tokens']['settled'] + run['tokens']['reserved'] + tokens
                                               > limits['max_tokens']):
                    self._refuse_call(call, 'BUDGET_EXHAUSTED')
                if 'max_usd' in limits and (run['nano_usd']['settled'] + run['nano_usd']['reserved'] + nano
                                            > budget_nano(limits['max_usd'])):
                    self._refuse_call(call, 'BUDGET_EXHAUSTED')
                call.update(state='reserved', reserved_tokens=tokens, reserved_nano_usd=nano, reserved_usd=usd(nano),
                            price=dict(price), provider_key_revision=provider['revision'], proof=proof)
                run['tokens']['reserved'] += tokens
                run['nano_usd']['reserved'] += nano
                self.state['calls'][params['call_id']] = call
                # Durable before the provider can see anything.
                self._save()
            started = time.monotonic()
            if proof in ('reply_outside_set', 'usage_missing'):
                # A7 operator proofs: no key is read and no provider is contacted.
                with self.lock:
                    call.update(state='sent', provider_contacted=False)
                    self._save()
                status, answer = proof_answer(proof, params['call_id'], params['model'], prompt_bytes)
            else:
                key = None
                with self.lock:
                    self._review_allowed(review_control, call)
                try:
                    key = self._vault().read(provider['vault_key'], provider['vault_version'])
                except Refused as error:
                    with self.lock:
                        self._release(call, 'refused', error.code)
                        self._save()
                    raise
                content = params['prompt'] if browser_input is None or not browser_input['images'] else [
                    {'type': 'text', 'text': params['prompt']}, *browser_input['images']]
                body = {'model': params['model'], 'messages': [{'role': 'user', 'content': content}],
                        'max_completion_tokens': output_tokens, 'reasoning_effort': 'none',
                        'service_tier': route['service_tier'], 'store': False, 'n': 1}
                try:
                    with self.lock:
                        # This durable send admission is serialized against
                        # cancellation. Only already admitted work may settle
                        # after cancellation/deadline; queued work cannot send.
                        self._review_allowed(review_control, call)
                        call['state'] = 'sent'
                        self._save()
                    try:
                        status, answer = self.host.provider(route['url'], key, body)
                    except (OSError, ValueError, TimeoutError) as error:
                        with self.lock:
                            call.update(state='uncertain', refusal='PROVIDER_ERROR', finished_at=stamp(self.clock()),
                                        error=type(error).__name__)
                            self._save()
                        raise Refused('PROVIDER_ERROR', 'uncertain; reservation kept') from error
                finally:
                    wipe(key)
            with self.lock:
                call['http_status'] = status
                call['latency_ms'] = int((time.monotonic() - started) * 1000)
                call['finished_at'] = stamp(self.clock())
                if status != 200:
                    error = (answer or {}).get('error') if isinstance(answer, dict) else None
                    call['provider_error'] = {k: str(error.get(k))[:64] for k in ('type', 'code')
                                              if isinstance(error, dict) and error.get(k) is not None}
                    if status in REJECTED_STATUSES:
                        self._release(call, 'provider_error', 'PROVIDER_ERROR')
                    else:
                        call.update(state='uncertain', refusal='PROVIDER_ERROR')
                    self._save()
                    raise Refused('PROVIDER_ERROR', 'HTTP %d' % status)
                try:
                    settled = settle_usage(answer, params['model'], route, call['price'], excerpt)
                except Refused as error:
                    # The provider did the work but its usage or price is unknown:
                    # keep the whole reservation as spent. Never assume zero.
                    self._settle(call, call['reserved_tokens'], call['reserved_nano_usd'])
                    call.update(state='settled_at_reservation', refusal=error.code,
                                provider_response_id=(answer or {}).get('id') if isinstance(answer, dict) else None)
                    self._save()
                    raise
                self._settle(call, settled['tokens'], settled['nano_usd'])
                call.update(state='settled', **{k: v for k, v in settled.items() if k not in ('tokens', 'nano_usd')})
                if settled['nano_usd'] > call['reserved_nano_usd'] or settled['tokens'] > call['reserved_tokens']:
                    call['exceeded_reservation'] = True
                self._save()
                return dict(self._call_result(call), replayed=False)

    def ledger(self, params):
        if not isinstance(params, dict) or set(params) - {'run_id'} or (
                'run_id' in params and not uuid_ok(params['run_id'])):
            raise Refused('INVALID_REQUEST')
        with self.lock:
            run_id = params.get('run_id')
            runs = {k: v for k, v in self.state['runs'].items() if run_id in (None, k)}
            calls = [c for c in self.state['calls'].values() if run_id in (None, c['run_id'])]
            deliveries = [d for d in self.state['deliveries'] if run_id in (None, d['run_id'])]
            out = json.loads(json.dumps({'runs': runs, 'calls': calls, 'deliveries': deliveries,
                                         'prices': self.state['prices'], 'provider': self.state['provider']}))
        for run in out['runs'].values():
            run['usd'] = {k: usd(v) for k, v in run['nano_usd'].items()}
        return out

    # ------------------------------------------------------------- status

    def status(self, _params=None):
        with self.lock:
            bindings = [{k: r[k] for k in ('binding_id', 'revision', 'state')} for r in self.state['bindings'].values()]
            prices, provider = dict(self.state['prices']), self.state['provider']
        try:
            vault = self._vault().healthy()
        except Refused:
            vault = False
        return {'broker': {'version': 1, 'broker_sha256': self.state.get('broker_sha256')},
                'vm_uuid': VM_UUID, 'origin': ORIGIN, 'routes': sorted(MODEL_ROUTES), 'vault_healthy': vault,
                'bindings': bindings, 'prices': prices, 'public_review': True,
                'public_review_control_version': 'website-review-control.v1',
                'selected_browser_model_control_version': 'selected-browser-model-control.v1',
                'provider': None if provider is None else {k: provider[k] for k in ('vault_key', 'vault_version',
                                                                                     'revision')}}

    def dispatch(self, method, params):
        if not isinstance(params, dict):
            raise Refused('INVALID_REQUEST')
        handler = {'status': self.status, 'bind': self.bind, 'rotate': self.rotate, 'revoke': self.revoke,
                   'bindings': self.bindings, 'pin_run': self.pin_run, 'check': self.check, 'deliver': self.deliver,
                   'provider_bind': self.provider_bind, 'price_set': self.price_set, 'price_clear': self.price_clear,
                   'model_call': self.model_call, 'summary_call': self.summary_call, 'review_call': self.review_call,
                   'browser_model_call': self.browser_model_call, 'cancel_browser_model': self.cancel_browser_model,
                   'cancel_review': self.cancel_review, 'ledger': self.ledger}.get(method)
        if handler is None:
            raise Refused('METHOD_NOT_ALLOWED')
        return handler(params)


def bound_value(binding_id, journal=JOURNAL, vault=None):
    """For root host tools only (fixture provisioning, canary scan): the bound value
    at its recorded version, as a bytearray the caller must wipe. Never printed."""
    secure(journal)
    record = json.loads(journal.read_text())['bindings'].get(binding_id)
    if record is None:
        raise Refused('BINDING_UNKNOWN')
    vault = vault or Vault(load_config())
    return record, vault.read(record['vault']['key'], record['vault']['version'])


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        creds = self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
        _, uid, _ = struct.unpack('3i', creds)
        if uid != self.server.peer_uid:
            return
        self.request.settimeout(180)
        # Only the versioned selected-browser method admits bounded inline
        # images. Legacy credential/model methods keep their exact 64 KiB cap.
        line = self.rfile.readline(3 * 1024 * 1024 + 1)
        try:
            if len(line) > 3 * 1024 * 1024:
                raise Refused('INVALID_REQUEST', 'too large')
            try:
                request = json.loads(line)
            except ValueError as error:
                raise Refused('INVALID_REQUEST') from error
            if not isinstance(request, dict) or set(request) - {'method', 'params'} or 'method' not in request:
                raise Refused('INVALID_REQUEST')
            if len(line) > 65536 and request['method'] != 'browser_model_call':
                raise Refused('INVALID_REQUEST', 'too large')
            reply = {'ok': True, 'result': self.server.broker.dispatch(request['method'], request.get('params', {}))}
        except Refused as error:
            reply = {'ok': False, 'error': error.code}
            if error.detail:
                reply['detail'] = error.detail
        except Exception as error:  # noqa: BLE001 - never crash the listener, never echo data.
            reply = {'ok': False, 'error': 'INTERNAL', 'detail': type(error).__name__}
        self.wfile.write((json.dumps(reply, separators=(',', ':')) + '\n').encode())


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    peer_uid = 0


def listen(path, broker):
    path.unlink(missing_ok=True)
    server = Server(str(path), Handler)
    os.chmod(path, 0o600)
    server.broker = broker
    threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.5}, daemon=True).start()
    return server


def serve():
    if os.geteuid() != 0:
        raise Refused('ROOT_REQUIRED')
    broker = Broker()
    broker.host.verify_install()
    broker.state['broker_sha256'] = hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest()
    broker.recover()
    RUN_DIR.mkdir(mode=0o700, exist_ok=True)
    server = listen(SOCKET, broker)
    finished = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: finished.set())
    signal.signal(signal.SIGINT, lambda *_: finished.set())
    finished.wait()
    server.shutdown()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve', action='store_true', required=True)
    parser.parse_args()
    serve()


if __name__ == '__main__':
    try:
        main()
    except Refused as error:
        print('A4 broker refused: %s %s' % (error.code, error.detail or ''), file=sys.stderr)
        sys.exit(1)
