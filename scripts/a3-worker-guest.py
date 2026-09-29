#!/usr/bin/env python3
"""A3 worker runner: the one browser tree inside the proof VM's worker unit.

Only the host supervisor starts this file, through `incus exec` and
`systemd-run --pipe`, as the unprivileged transient worker unit. Standard
input and output are the only control channel: one JSON object per line.
Chromium is driven over --remote-debugging-pipe (fds 3 and 4), so no
debugging socket exists in the guest or on the host. Every browser request is
checked against the fixed synthetic origin policy before it leaves the
browser; the host origin proxy and bridge fence enforce the same boundary
again. Page content is untrusted data and never selects an operation.

A4 adds one credential path. `submit_bound_fixture` carries only a binding ID
on the control channel. The host credential broker writes the bound value
into a one-shot FIFO on this unit's private tmpfs (never stdin, argv, the
environment or a file); the runner types it into the login form found by
typed lookup, permits exactly one POST /api/login, clears the fields and
drops the bytes. Replies and events carry the binding ID and outcome only.
"""
import base64
import fcntl
import json
import os
import queue
import re
import select
import hashlib
import signal
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

ORIGIN = 'https://demo.fractionate.ai'
HOST = 'demo.fractionate.ai'
PROXY = '10.185.17.1:18083'
CHROMIUM = '/usr/bin/chromium'
PATHS = frozenset(('/', '/workspace', '/api/config', '/api/session', '/api/files'))
ASSET = re.compile(r'/assets/[a-zA-Z0-9_.-]+\Z')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
SPKI = re.compile(r'[A-Za-z0-9+/]{43}=\Z')
ACTIONS = frozenset(('open_landing', 'open_login', 'submit_bound_fixture', 'read_workspace',
                     'read_session', 'read_files', 'sign_out'))
PROOFS = frozenset(('proof:cpu', 'proof:memory', 'proof:tasks', 'proof:disk', 'proof:time',
                    'proof:escape', 'proof:descendant', 'proof:fail'))
KEYS = {'Enter': (13, '\r'), 'Tab': (9, ''), 'Escape': (27, ''), 'Backspace': (8, ''),
        'ArrowUp': (38, ''), 'ArrowDown': (40, ''), 'ArrowLeft': (37, ''), 'ArrowRight': (39, '')}
VIEWPORT = (1280, 800)
WATCHDOG_SECONDS = 20
STEP_SECONDS = 10
WORKSPACE = '/tmp'
LOGIN_PATH = '/api/login'
CREDENTIAL_FIFO = 'pp-a4-credential'
DELIVERY_SECONDS = 20
FRAME_MAGIC = b'PPA4'
MAX_FIELD = 256
# A5: a pending second factor or consent the origin's session reports after a
# sign-in (typed names only). Any of them needs a human takeover.
CHALLENGES = frozenset(('mfa', 'passkey', 'captcha', 'consent'))


class Refused(Exception):
    """A typed refusal; only its code crosses the control channel."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def permits(url, method):
    """The broker's exact same-origin read-only request policy."""
    if not isinstance(url, str) or '%' in url or '\\' in url:
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if (parts.scheme != 'https' or parts.netloc != HOST or parts.query or parts.fragment
            or '?' in url or '#' in url):
        return False
    if method == 'GET':
        return parts.path in PATHS or bool(ASSET.fullmatch(parts.path))
    # POST /api/login is never in the standing policy: only an armed, one-shot
    # submit_bound_fixture lets exactly one through (Browser._paused).
    if method == 'POST':
        return parts.path == '/api/logout'
    return False


def classify_login(status, as_bound, challenge, off_origin):
    """The typed A5 outcome of one bound submit. Only the runner's own session read
    naming the bound account is `signed_in`; a status or a vanished form is not."""
    if off_origin or (isinstance(status, int) and 300 <= status < 400):
        return 'unexpected_origin'
    if status == 200 and as_bound:
        return 'signed_in'
    if status == 429:
        return 'rate_limited'
    if challenge in CHALLENGES:
        return 'challenge_required'
    if status in (400, 401, 403):
        return 'rejected'
    if status is None or status in (502, 504):
        return 'timeout'
    return 'unknown'


def printable_field(value):
    return 0 < len(value) <= MAX_FIELD and all(0x20 <= b <= 0x7e for b in value)


def parse_frame(data):
    """PPA4 | u16 username | u16 password, printable ASCII, exact length."""
    if len(data) < 8 or bytes(data[:4]) != FRAME_MAGIC:
        raise Refused('CREDENTIAL_FRAME_INVALID')
    ulen = int.from_bytes(data[4:6], 'big')
    if len(data) < 8 + ulen:
        raise Refused('CREDENTIAL_FRAME_INVALID')
    plen = int.from_bytes(data[6 + ulen:8 + ulen], 'big')
    if len(data) != 8 + ulen + plen:
        raise Refused('CREDENTIAL_FRAME_INVALID')
    username, password = bytearray(data[6:6 + ulen]), bytearray(data[8 + ulen:])
    if not printable_field(username) or not printable_field(password):
        wipe(username)
        wipe(password)
        raise Refused('CREDENTIAL_FRAME_INVALID')
    return username, password


def wipe(buffer):
    """Best effort: overwrite a bytearray the runner owned. Python str copies
    made for the CDP call cannot be zeroed; they die with this process."""
    if isinstance(buffer, bytearray):
        buffer[:] = b'\0' * len(buffer)


def receive_credential(path, seconds=None, on_open=None):
    """Read one framed value from a fresh FIFO on the private tmpfs, then remove it.

    Only guest root can open the FIFO from outside this unit's mount namespace
    (the host broker, through /proc/<runner>/root). Nothing else is waited on.
    """
    try:
        os.mkfifo(path, 0o600)
    except FileExistsError as error:
        raise Refused('CREDENTIAL_CHANNEL_BUSY') from error
    seconds = DELIVERY_SECONDS if seconds is None else seconds
    fd = None
    data = bytearray()
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        if on_open is not None:
            on_open()   # Tells the host the reader is waiting; carries no value.
        poller = select.poll()
        poller.register(fd, select.POLLIN | select.POLLHUP)
        deadline = time.monotonic() + seconds
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise Refused('CREDENTIAL_NOT_DELIVERED')
            if not poller.poll(int(left * 1000) + 1):
                continue
            try:
                chunk = os.read(fd, 1024)
            except BlockingIOError:
                continue
            if chunk:
                data += chunk
                if len(data) > 8 + 2 * MAX_FIELD:
                    raise Refused('CREDENTIAL_FRAME_INVALID')
                continue
            if data:
                break
            time.sleep(0.05)   # A writer closed without data: keep waiting to the deadline.
        return parse_frame(data)
    finally:
        wipe(data)
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(path)
        except OSError:
            pass


def validate_config(value):
    # A7: `live` (true) asks for the real-time view (Neko); a browser workload only.
    if not isinstance(value, dict) or set(value) - {'live'} != {'attempt_id', 'workload', 'spki'}:
        raise Refused('INVALID_CONFIG')
    if 'live' in value and (value['live'] is not True or value['workload'] != 'browser'):
        raise Refused('INVALID_CONFIG')
    if not isinstance(value['attempt_id'], str) or not UUID.fullmatch(value['attempt_id']):
        raise Refused('INVALID_CONFIG')
    if value['workload'] != 'browser' and value['workload'] not in PROOFS:
        raise Refused('INVALID_CONFIG')
    if not isinstance(value['spki'], str) or not SPKI.fullmatch(value['spki']):
        raise Refused('INVALID_CONFIG')
    return value


def validate_input(value):
    """Human input only: a point, a fixed key, bounded printable text or a scroll."""
    if not isinstance(value, dict) or not isinstance(value.get('kind'), str):
        raise Refused('INVALID_INPUT')
    kind = value['kind']
    width, height = VIEWPORT

    def point():
        x, y = value.get('x'), value.get('y')
        if type(x) is not int or type(y) is not int or not (0 <= x < width and 0 <= y < height):
            raise Refused('INVALID_INPUT')
        return x, y
    if kind == 'click' and set(value) == {'kind', 'x', 'y'}:
        point()
    elif kind == 'scroll' and set(value) == {'kind', 'x', 'y', 'dy'}:
        point()
        if type(value['dy']) is not int or not -2000 <= value['dy'] <= 2000:
            raise Refused('INVALID_INPUT')
    elif kind == 'key' and set(value) == {'kind', 'key'}:
        if value['key'] not in KEYS:
            raise Refused('INVALID_INPUT')
    elif kind == 'text' and set(value) == {'kind', 'text'}:
        text = value['text']
        if (not isinstance(text, str) or not 0 < len(text) <= 256
                or any(ord(c) < 32 or ord(c) == 127 for c in text)):
            raise Refused('INVALID_INPUT')
    else:
        raise Refused('INVALID_INPUT')
    return value


class Channel:
    """Line-delimited JSON on the unit's standard output, serialised."""

    def __init__(self, stream=None):
        self.stream = stream or sys.stdout
        self.lock = threading.Lock()

    def emit(self, value):
        line = json.dumps(value, separators=(',', ':'), sort_keys=True)
        with self.lock:
            try:
                self.stream.write(line + '\n')
                self.stream.flush()
            except (OSError, ValueError):
                # The host channel is gone. Exiting ends the unit; systemd then
                # kills every remaining process in its cgroup.
                os._exit(75)


def high_fd(fd):
    """Move a pipe end above the fixed browser descriptors 0-4."""
    moved = fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10)
    os.close(fd)
    return moved


# ------------------------------------------------------------------ A7 live
# The real-time view and dashboard takeover (user decisions 1 and 1a,
# 2026-09-29): Neko inside this unit. Xvfb draws the browser on a private
# display (its socket and cookie live on this unit's private tmpfs); Neko's
# server streams that display over WebRTC and listens only on a Unix socket here
# (ProxyPilot's reviewed patch, scripts/a7-neko-unix-socket.patch); the browser
# stays this runner's own sandboxed Chromium on the pipe, now headful in kiosk
# mode under the managed policy below. This runner is Neko's only administrator:
# the API token and every member token stay in this process and never cross the
# control channel. Viewers reach Neko only through the relay (live_open /
# live_send / live_close), which passes signalling events only; handing control
# to a person (live_give) is a queued command, so it runs only after any
# in-flight submit_bound_fixture has finished and cleared the fields. Human
# input is counted by kind from X (never which key); the agent's own input goes
# through the DevTools pipe, not X, so it is never counted.
LIVE_DISPLAY = ':99'
LIVE_UDP_PORT = 18091
NEKO_BINARY = '/usr/local/lib/proxypilot-live/neko'
XVFB = '/usr/bin/Xvfb'
XINPUT = '/usr/bin/xinput'
LIVE_POLICY_PATH = '/etc/chromium/policies/managed/proxypilot-live.json'
LIVE_MAX_CONNS = 6
LIVE_MAX_MESSAGE = 256 * 1024
LIVE_SILENCE = ('audiotestsrc wave=silence is-live=true ! audio/x-raw,channels=2,rate=48000 ! audioconvert '
                '! opusenc bitrate=16000 ! appsink name=appsink')
# The managed Chromium policy the A7 installer writes, byte for byte.
LIVE_POLICY = {
    'AllowFileSelectionDialogs': False, 'AudioCaptureAllowed': False, 'AutofillAddressEnabled': False,
    'AutofillCreditCardEnabled': False, 'BookmarkBarEnabled': False, 'BrowserAddPersonEnabled': False,
    'BrowserGuestModeEnabled': False, 'BrowserSignin': 0, 'DefaultClipboardSetting': 2,
    'DefaultNotificationsSetting': 2, 'DefaultPopupsSetting': 2, 'DeveloperToolsAvailability': 2,
    'DownloadRestrictions': 3, 'EditBookmarksEnabled': False, 'ExtensionInstallBlocklist': ['*'],
    'IncognitoModeAvailability': 1, 'PasswordManagerEnabled': False, 'PrintingEnabled': False,
    'PromptForDownloadLocation': False, 'SavingBrowserHistoryDisabled': True, 'ScreenCaptureAllowed': False,
    'SpellcheckEnabled': False, 'SyncDisabled': True, 'TaskManagerEndProcessEnabled': False,
    'TranslateEnabled': False, 'URLAllowlist': ['about:blank'],
    'URLBlocklist': ['file://*', 'chrome://*', 'chrome-untrusted://*', 'devtools://*', 'view-source:*',
                     'javascript://*', 'data:*', 'blob:*', 'about:*'],
    'VideoCaptureAllowed': False,
}


def live_policy_bytes():
    return (json.dumps(LIVE_POLICY, indent=1, sort_keys=True) + '\n').encode()


# Relay allowlists: only signalling crosses. Input never travels this way (it
# goes over the WebRTC data channel, and only for the host Neko has given
# control to); clipboard, chat, members, screen and admin events never cross.
LIVE_FROM_VIEWER = frozenset(('client/heartbeat', 'signal/request', 'signal/answer', 'signal/candidate',
                              'signal/restart', 'signal/video'))
LIVE_TO_VIEWER = frozenset(('system/init', 'system/disconnect', 'system/heartbeat', 'signal/provide',
                            'signal/offer', 'signal/answer', 'signal/candidate', 'signal/restart', 'signal/close',
                            'signal/video', 'control/host', 'control/release', 'screen/updated'))


def live_filter(message, allowed):
    """One relayed Neko message, or None: an allowed event, a JSON object payload."""
    if not isinstance(message, dict) or set(message) - {'event', 'payload'}:
        return None
    if message.get('event') not in allowed:
        return None
    payload = message.get('payload')
    if payload is not None and not isinstance(payload, dict):
        return None
    out = {'event': message['event']}
    if isinstance(payload, dict):
        payload = dict(payload)
        if message['event'] == 'system/init':
            # Other members and the room's settings are not the viewer's business.
            payload = {k: payload[k] for k in ('session_id', 'control_host', 'screen_size', 'webrtc') if k in payload}
        elif message['event'] == 'signal/provide':
            payload.pop('iceservers', None)   # the dashboard mints its own TURN credentials
        out['payload'] = payload
    return out


def xauthority(display_number, cookie):
    """One MIT-MAGIC-COOKIE-1 entry for any address (FamilyWild)."""
    def field(data):
        return len(data).to_bytes(2, 'big') + data
    return (0xffff).to_bytes(2, 'big') + field(b'') + field(display_number.encode()) + \
        field(b'MIT-MAGIC-COOKIE-1') + field(cookie)


class UnixHttp:
    """HTTP/1.1 to Neko's Unix socket, with this runner's admin token."""

    def __init__(self, path, token, timeout=10):
        self.path, self.token, self.timeout = path, token, timeout

    def request(self, method, target, body=None, token=None):
        payload = b'' if body is None else json.dumps(body, separators=(',', ':')).encode()
        head = ['%s %s HTTP/1.1' % (method, target), 'Host: localhost', 'Connection: close',
                'Authorization: Bearer %s' % (token or self.token), 'Content-Length: %d' % len(payload)]
        if body is not None:
            head.append('Content-Type: application/json')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(self.timeout)
            s.connect(self.path)
            s.sendall(('\r\n'.join(head) + '\r\n\r\n').encode() + payload)
            data = b''
            while len(data) < 1024 * 1024:
                chunk = s.recv(65536)
                if not chunk:
                    break
                data += chunk
        header, _, content = data.partition(b'\r\n\r\n')
        try:
            status = int(header.split(b' ', 2)[1])
        except (IndexError, ValueError) as error:
            raise Refused('LIVE_PROTOCOL') from error
        if b'transfer-encoding: chunked' in header.lower():
            content = dechunk(content)
        try:
            return status, (json.loads(content) if content.strip() else None)
        except ValueError:
            return status, None


def dechunk(data):
    out = b''
    while data:
        size, _, rest = data.partition(b'\r\n')
        try:
            length = int(size.split(b';')[0], 16)
        except ValueError:
            break
        if length == 0:
            break
        out += rest[:length]
        data = rest[length + 2:]
    return out


class NekoSocket:
    """One viewer's WebSocket to Neko over the Unix socket (RFC 6455, client side)."""

    def __init__(self, path, token, on_message, on_close):
        self.on_message, self.on_close = on_message, on_close
        self.lock = threading.Lock()
        self.closed = False
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect(path)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(('GET /api/ws?token=%s HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
                           'Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n'
                           % (token, key)).encode())
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = self.sock.recv(4096)
            if not chunk or len(head) > 16384:
                raise Refused('LIVE_PROTOCOL')
            head += chunk
        head, _, self.buffer = head.partition(b'\r\n\r\n')
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        if not head.startswith(b'HTTP/1.1 101') or accept not in head:
            raise Refused('LIVE_PROTOCOL')
        self.sock.settimeout(None)
        threading.Thread(target=self._reader, daemon=True).start()

    def _frame(self, opcode, data):
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x80 | opcode]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + n.to_bytes(2, 'big')
                                          if n < 65536 else bytes([0x80 | 127]) + n.to_bytes(8, 'big'))
        return head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data))

    def send(self, text, opcode=1):
        with self.lock:
            if self.closed:
                raise Refused('LIVE_CLOSED')
            try:
                self.sock.sendall(self._frame(opcode, text.encode() if isinstance(text, str) else text))
            except OSError as error:
                raise Refused('LIVE_CLOSED') from error

    def _read(self, n):
        while len(self.buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise OSError('closed')
            self.buffer += chunk
        data, self.buffer = self.buffer[:n], self.buffer[n:]
        return data

    def _reader(self):
        message, reason = b'', 'closed'
        try:
            while True:
                b0, b1 = self._read(2)
                opcode, length = b0 & 0x0f, b1 & 0x7f
                if length == 126:
                    length = int.from_bytes(self._read(2), 'big')
                elif length == 127:
                    length = int.from_bytes(self._read(8), 'big')
                if length > LIVE_MAX_MESSAGE:
                    reason = 'too_large'
                    break
                mask = self._read(4) if b1 & 0x80 else None
                data = self._read(length)
                if mask:
                    data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
                if opcode == 8:
                    break
                if opcode == 9:
                    self.send(data, 10)
                    continue
                if opcode in (0, 1):
                    message += data
                    if len(message) > LIVE_MAX_MESSAGE:
                        reason = 'too_large'
                        break
                    if b0 & 0x80:
                        try:
                            self.on_message(json.loads(message))
                        except ValueError:
                            pass
                        message = b''
        except (OSError, Refused, ValueError):
            pass
        self.close(reason)

    def close(self, reason='closed'):
        with self.lock:
            if self.closed:
                return
            self.closed = True
        try:
            self.sock.close()
        except OSError:
            pass
        self.on_close(reason)


class InputCounter:
    """Counts human X input by kind (keys, clicks, scrolls) from XI2 raw events.
    Only the event type and button number are read; a key's code never is."""

    def __init__(self, env):
        self.lock = threading.Lock()
        self.counts = {'key': 0, 'click': 0, 'scroll': 0}
        self.process = subprocess.Popen([XINPUT, 'test-xi2', '--root'], stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        kind = None
        for raw in self.process.stdout:
            line = raw.decode('ascii', 'replace').strip()
            if line.startswith('EVENT type '):
                kind = {'13': 'key', '15': 'button'}.get(line.split()[2])
            elif kind and line.startswith('detail:'):
                if kind == 'key':
                    self.add('key')
                else:
                    try:
                        button = int(line.split(':', 1)[1])
                    except ValueError:
                        button = 0
                    self.add('click' if 1 <= button <= 3 else 'scroll' if 4 <= button <= 7 else None)
                kind = None

    def add(self, kind):
        if kind:
            with self.lock:
                self.counts[kind] += 1

    def take(self):
        with self.lock:
            counts, self.counts = dict(self.counts), {'key': 0, 'click': 0, 'scroll': 0}
        return counts


class LiveDesktop:
    """Xvfb, the input counter and Neko for one attempt, all inside this unit."""

    def __init__(self, channel):
        self.channel = channel
        self.dir = os.path.join(WORKSPACE, 'live')
        self.processes = []
        self.conns = {}
        self.lock = threading.Lock()
        self.controller = None

    def start(self):
        for path in (NEKO_BINARY, XVFB, XINPUT):
            if not os.path.isfile(path):
                raise Refused('LIVE_UNAVAILABLE')
        try:
            with open(LIVE_POLICY_PATH, 'rb') as stream:
                if stream.read(65536) != live_policy_bytes():
                    raise Refused('LIVE_POLICY_MISMATCH')
        except OSError as error:
            raise Refused('LIVE_POLICY_MISMATCH') from error
        os.makedirs(os.path.join(self.dir, 'home'), mode=0o700, exist_ok=True)
        auth = os.path.join(self.dir, 'xauth')
        with open(os.open(auth, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb') as stream:
            stream.write(xauthority(LIVE_DISPLAY[1:], os.urandom(16)))
        self.env = {'DISPLAY': LIVE_DISPLAY, 'XAUTHORITY': auth, 'HOME': os.path.join(self.dir, 'home'),
                    'XDG_RUNTIME_DIR': self.dir, 'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin'}
        # No TCP listener and no abstract-namespace socket: only the path socket
        # on this unit's private /tmp, guarded by the cookie.
        self._spawn([XVFB, LIVE_DISPLAY, '-screen', '0', '%dx%dx24' % VIEWPORT, '-nolisten', 'tcp',
                     '-nolisten', 'local', '-noreset', '-auth', auth, '-dpi', '96'])
        self._wait(lambda: os.path.exists('/tmp/.X11-unix/X' + LIVE_DISPLAY[1:]), 'LIVE_DISPLAY_FAILED')
        self.counter = InputCounter(self.env)
        self.processes.append(self.counter.process)
        self.socket = os.path.join(self.dir, 'neko.sock')
        self.token = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('=')
        config = os.path.join(self.dir, 'neko.yaml')
        with open(os.open(config, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
            json.dump(self.neko_config(), stream)
        self._spawn([NEKO_BINARY, 'serve', '--config', config], log=os.path.join(self.dir, 'neko.log'))
        self.api = UnixHttp(self.socket, self.token)
        self._wait(self._healthy, 'LIVE_NEKO_FAILED', seconds=30)
        with open(NEKO_BINARY, 'rb') as stream:
            self.neko_sha256 = hashlib.sha256(stream.read()).hexdigest()
        return self

    def neko_config(self):
        return {
            'server': {'bind': 'unix:' + self.socket, 'metrics': False, 'pprof': False, 'static': ''},
            'desktop': {'display': LIVE_DISPLAY, 'screen': '%dx%d@25' % VIEWPORT, 'input': {'enabled': False},
                        'upload_drop': False, 'file_chooser_dialog': False, 'unminimize': True},
            'capture': {'audio': {'pipeline': LIVE_SILENCE}, 'video': {'codec': 'vp8'},
                        'screencast': {'enabled': False}, 'microphone': {'enabled': False},
                        'webcam': {'enabled': False}, 'broadcast': {'autostart': False}},
            'member': {'provider': 'object', 'object': {'users': '[]'}},
            'session': {'api_token': self.token, 'locked_controls': True, 'implicit_hosting': False,
                        'control_protection': False, 'inactive_cursors': False, 'private_mode': False,
                        'merciful_reconnect': True, 'heartbeat_interval': 10, 'cookie': {'enabled': False}},
            'webrtc': {'udpmux': LIVE_UDP_PORT, 'icelite': True, 'ip_retrieval_url': '',
                       'estimator': {'enabled': False}},
            'plugins': {'enabled': False}, 'chat': {'enabled': False},
            'filetransfer': {'enabled': False}, 'openinapp': {'enabled': False},
        }

    def _spawn(self, argv, log=None):
        out = subprocess.DEVNULL if log is None else open(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb')
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=out, env=self.env)
        if log is not None:
            out.close()
        self.processes.append(process)
        return process

    def _wait(self, ready, code, seconds=15):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if any(p.poll() is not None for p in self.processes):
                raise Refused(code)
            try:
                if ready():
                    return
            except (OSError, Refused):
                pass
            time.sleep(0.1)
        raise Refused(code)

    def _healthy(self):
        return os.path.exists(self.socket) and self.api.request('GET', '/health')[0] == 200

    # -- relay (handled as soon as it arrives; never touches the browser)

    def open(self, conn):
        if not isinstance(conn, str) or not re.fullmatch(r'[a-z0-9]{8,32}', conn):
            raise Refused('INVALID_COMMAND')
        with self.lock:
            if conn in self.conns:
                raise Refused('LIVE_CONN_EXISTS')
            if len(self.conns) >= LIVE_MAX_CONNS:
                raise Refused('LIVE_BUSY')
            self.conns[conn] = None
        try:
            member, secret = 'v' + conn, base64.urlsafe_b64encode(os.urandom(24)).decode()
            status, created = self.api.request('POST', '/api/members', {'username': member, 'password': secret,
                                                                         'profile': self.profile(False)})
            if status != 200 or not isinstance(created, dict) or not isinstance(created.get('id'), str):
                raise Refused('LIVE_MEMBER_FAILED')
            status, login = self.api.request('POST', '/api/login', {'username': member, 'password': secret})
            if status != 200 or not isinstance(login, dict) or not isinstance(login.get('token'), str):
                raise Refused('LIVE_MEMBER_FAILED')
            ws = NekoSocket(self.socket, login['token'], lambda m, c=conn: self._to_viewer(c, m),
                            lambda reason, c=conn: self._closed(c, reason))
        except (OSError, Refused) as error:
            with self.lock:
                self.conns.pop(conn, None)
            raise Refused(getattr(error, 'code', 'LIVE_MEMBER_FAILED'))
        with self.lock:
            self.conns[conn] = {'member': created['id'], 'session': login.get('id') or created['id'], 'ws': ws}
        return {'conn': conn}

    def send(self, conn, data):
        entry = self.conns.get(conn)
        message = live_filter(data, LIVE_FROM_VIEWER)
        if entry is None or message is None:
            return False
        entry['ws'].send(json.dumps(message, separators=(',', ':')))
        return True

    def close_conn(self, conn):
        entry = self.conns.get(conn)
        if entry and entry.get('ws'):
            entry['ws'].close('viewer_closed')

    def _to_viewer(self, conn, message):
        message = live_filter(message, LIVE_TO_VIEWER)
        if message is not None:
            self.channel.emit({'event': 'live', 'conn': conn, 'data': message})

    def _closed(self, conn, reason):
        with self.lock:
            entry = self.conns.pop(conn, None)
        if entry is None:
            return
        try:
            self.api.request('DELETE', '/api/members/%s' % entry['member'])
        except (OSError, Refused):
            pass
        self.channel.emit({'event': 'live_closed', 'conn': conn, 'reason': reason})

    @staticmethod
    def profile(host):
        return {'name': 'viewer', 'is_admin': False, 'can_login': True, 'can_connect': True, 'can_watch': True,
                'can_host': host, 'can_share_media': False, 'can_access_clipboard': False,
                'sends_inactive_cursor': False, 'can_see_inactive_cursors': False,
                'plugins': {'chat.can_send': False, 'chat.can_receive': False, 'filetransfer.enabled': False}}

    # -- control (queued behind any browser command)

    def give(self, conn):
        entry = self.conns.get(conn)
        if entry is None:
            raise Refused('LIVE_CONN_UNKNOWN')
        if self.controller is not None:
            raise Refused('LIVE_CONTROL_HELD')
        status, _ = self.api.request('POST', '/api/members/%s' % entry['member'], self.profile(True))
        if not 200 <= status < 300:
            raise Refused('LIVE_CONTROL_FAILED')
        status, _ = self.api.request('POST', '/api/room/control/give/%s' % entry['session'])
        if not 200 <= status < 300:
            raise Refused('LIVE_CONTROL_FAILED')
        self.counter.take()
        self.controller = conn
        return {'controlling': True}

    def release(self):
        self.api.request('POST', '/api/room/control/reset')
        entry = self.conns.get(self.controller) if self.controller else None
        if entry:
            self.api.request('POST', '/api/members/%s' % entry['member'], self.profile(False))
        self.controller = None
        return {'inputs': self.counter.take()}

    def close(self):
        with self.lock:
            conns = list(self.conns)
        for conn in conns:
            self.close_conn(conn)
        for process in reversed(self.processes):
            if process.poll() is None:
                process.terminate()
        for process in self.processes:
            try:
                process.wait(3)
            except subprocess.TimeoutExpired:
                process.kill()


class Cdp:
    """Chrome DevTools protocol over the browser's private pipe."""

    def __init__(self, write_fd, read_fd):
        self.write_fd, self.read_fd = write_fd, read_fd
        self.lock = threading.Lock()
        self.state = threading.Lock()
        self.counter = 0
        self.pending = {}
        self.handlers = {}
        self.waiters = []
        self.closed = threading.Event()
        threading.Thread(target=self._reader, daemon=True).start()

    def _write(self, message):
        data = json.dumps(message, separators=(',', ':')).encode() + b'\0'
        with self.lock:
            view = memoryview(data)
            while view:
                written = os.write(self.write_fd, view)
                view = view[written:]

    def _message(self, method, params, session):
        with self.state:
            self.counter += 1
            ident = self.counter
        message = {'id': ident, 'method': method, 'params': params or {}}
        if session:
            message['sessionId'] = session
        return ident, message

    def call(self, method, params=None, session=None, timeout=STEP_SECONDS):
        ident, message = self._message(method, params, session)
        done, box = threading.Event(), {}
        with self.state:
            self.pending[ident] = (done, box)
        try:
            self._write(message)
        except OSError as error:
            with self.state:
                self.pending.pop(ident, None)
            raise Refused('BROWSER_CLOSED') from error
        if not done.wait(timeout):
            with self.state:
                self.pending.pop(ident, None)
            raise Refused('BROWSER_TIMEOUT')
        if 'error' in box:
            raise Refused('BROWSER_PROTOCOL')
        return box.get('result', {})

    def notify(self, method, params=None, session=None):
        """Send without waiting; used from event handlers on the reader."""
        ident, message = self._message(method, params, session)
        with self.state:
            self.pending[ident] = None
        try:
            self._write(message)
        except OSError:
            with self.state:
                self.pending.pop(ident, None)

    def on(self, method, handler):
        self.handlers[method] = handler

    def expect(self, method, predicate=lambda params, session: True):
        done, box = threading.Event(), {}
        entry = (method, predicate, done, box)
        with self.state:
            self.waiters.append(entry)

        def wait(timeout=STEP_SECONDS):
            try:
                if not done.wait(timeout):
                    raise Refused('BROWSER_TIMEOUT')
                return box['params']
            finally:
                with self.state:
                    if entry in self.waiters:
                        self.waiters.remove(entry)
        return wait

    def _dispatch(self, message):
        if 'id' in message:
            with self.state:
                slot = self.pending.pop(message['id'], None)
            if slot:
                done, box = slot
                box.update(message)
                done.set()
            return
        method, params = message.get('method'), message.get('params', {})
        session = message.get('sessionId')
        handler = self.handlers.get(method)
        if handler:
            handler(params, session)
        with self.state:
            matched = [w for w in self.waiters if w[0] == method and w[1](params, session)]
        for _, _, done, box in matched:
            box['params'] = params
            done.set()

    def _reader(self):
        buffer = b''
        try:
            while True:
                chunk = os.read(self.read_fd, 65536)
                if not chunk:
                    break
                buffer += chunk
                while b'\0' in buffer:
                    raw, buffer = buffer.split(b'\0', 1)
                    try:
                        message = json.loads(raw)
                    except ValueError:
                        continue
                    if isinstance(message, dict):
                        self._dispatch(message)
        except OSError:
            pass
        finally:
            self.closed.set()
            with self.state:
                pending = [slot for slot in self.pending.values() if slot]
                self.pending.clear()
            for done, box in pending:
                box['error'] = {'message': 'closed'}
                done.set()


# Waits in the page, like Playwright's locator auto-wait: the synthetic app
# renders a loading screen until its own session/config reads return.
FIND_BUTTON = '''(async () => {
  const want = %s, click = %s, until = Date.now() + %d;
  const name = e => ((e.getAttribute('aria-label') || e.textContent || '').trim());
  for (;;) {
    const b = [...document.querySelectorAll('button')].find(e => name(e) === want && e.getClientRects().length);
    if (b) {
      const r = b.getBoundingClientRect();
      if (click) b.click();
      return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
    }
    if (Date.now() >= until) return null;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
})()'''
DIALOG_OPEN = '''(() => {
  const want = 'Sign in to your workspace';
  const label = d => (d.getAttribute('aria-label') || '').trim() ||
    (d.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
      .map(id => (document.getElementById(id)?.textContent || '').trim()).join(' ').trim();
  return [...document.querySelectorAll('[role="dialog"],dialog')]
    .some(d => label(d) === want && (d.tagName !== 'DIALOG' || d.open) && d.getClientRects().length > 0);
})()'''
FIXED_JSON = '''(async () => {
  const r = await fetch(%s, {method: 'GET', credentials: 'same-origin', redirect: 'manual',
    cache: 'no-store', signal: AbortSignal.timeout(10000)});
  if (!r.ok || r.type === 'opaqueredirect' ||
      !(r.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return {ok: false};
  return {ok: true, data: await r.json()};
})()'''
# Typed lookup of the approved origin's login form: the dialog by its accessible
# name, then exactly one username field, one password field and one submit
# button, all in the same form. Returns booleans only, never a field value.
LOGIN_FORM = '''(() => {
  const want = 'Sign in to your workspace';
  const label = d => (d.getAttribute('aria-label') || '').trim() ||
    (d.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
      .map(id => (document.getElementById(id)?.textContent || '').trim()).join(' ').trim();
  const dialogs = [...document.querySelectorAll('[role="dialog"],dialog')]
    .filter(d => label(d) === want && (d.tagName !== 'DIALOG' || d.open) && d.getClientRects().length > 0);
  if (dialogs.length !== 1) return null;
  const users = [...dialogs[0].querySelectorAll('input[autocomplete="username"]')];
  const passwords = [...dialogs[0].querySelectorAll('input[type="password"]')];
  const submits = [...dialogs[0].querySelectorAll('button[type="submit"]')];
  if (users.length !== 1 || passwords.length !== 1 || submits.length !== 1) return null;
  const [user, password, submit] = [users[0], passwords[0], submits[0]];
  if (!user.form || user.form !== password.form || submit.form !== user.form ||
      !['email', 'text'].includes(user.type)) return null;
  const clear = el => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '');
    el.dispatchEvent(new Event('input', {bubbles: true}));
  };
  const op = %s;
  if (op === 'check') return true;
  if (op === 'username' || op === 'password') {
    const el = op === 'username' ? user : password;
    el.focus();
    clear(el);
    return document.activeElement === el && el.value === '';
  }
  if (op === 'filled') return user.value.length === %d && password.value.length === %d;
  if (op === 'submit') { submit.click(); return true; }
  if (op === 'clear') { clear(user); clear(password); return user.value === '' && password.value === ''; }
  return null;
})()'''
LOGOUT = '''(async () => {
  try {
    const r = await fetch('/api/logout', {method: 'POST', credentials: 'same-origin', redirect: 'manual',
      cache: 'no-store', signal: AbortSignal.timeout(8000)});
    return r.ok;
  } catch (e) { return false; }
})()'''
EGRESS_PROBE = '''(async () => {
  const out = {};
  const limit = ms => AbortSignal.timeout(ms);
  const attempt = async (key, fn) => { try { await fn(); out[key] = 'reached'; } catch (e) { out[key] = 'refused'; } };
  const must = async p => { const r = await p; if (!r.ok) throw new Error('status'); };
  await attempt('cross_origin_fetch', () => fetch('https://example.com/', {mode: 'no-cors', signal: limit(5000)}));
  await attempt('raw_ip_fetch', () => fetch('https://1.1.1.1/', {mode: 'no-cors', signal: limit(5000)}));
  await attempt('alternate_port', () => fetch('https://demo.fractionate.ai:8443/', {mode: 'no-cors', signal: limit(5000)}));
  await attempt('plain_http_origin', () => fetch('http://demo.fractionate.ai/', {mode: 'no-cors', signal: limit(5000)}));
  await attempt('login_submission', () => must(fetch('/api/login', {method: 'POST', body: '{}', signal: limit(5000)})));
  await attempt('unlisted_path', () => must(fetch('/api/files/sample-metrics/download', {signal: limit(5000)})));
  await attempt('websocket', () => new Promise((resolve, reject) => {
    const socket = new WebSocket('wss://demo.fractionate.ai/socket');
    socket.onopen = () => { socket.close(); resolve(); };
    socket.onerror = () => reject(new Error('ws'));
    setTimeout(() => reject(new Error('timeout')), 5000);
  }));
  await attempt('cross_origin_image', () => new Promise((resolve, reject) => {
    const image = new Image(); image.onload = resolve; image.onerror = reject;
    image.src = 'https://outside.invalid/pixel.png'; setTimeout(() => reject(new Error('timeout')), 5000);
  }));
  return out;
})()'''


class Browser:
    """One Chromium process tree and its single page, driven by fixed code."""

    def __init__(self, spki, channel, live=None):
        self.channel = channel
        self.statuses = {}
        self.blocked = []
        # A5: set when the armed sign-in request itself was redirected.
        self.login_redirected = False
        self.allowed = 0
        self.main_target = None
        # One-shot sign-in gate: only submit_bound_fixture arms it, for one POST.
        self.login_armed = 0
        self.login_posts = 0
        self.login_status = None
        self.submitted = False
        # The bound account's user name (not secret; the broker's binding names it),
        # kept after a submit so a later session read can name it too.
        self.bound_email = None
        home = os.path.join(WORKSPACE, 'home')
        profile = os.path.join(WORKSPACE, 'profile')
        for path in (home, profile):
            os.makedirs(path, mode=0o700, exist_ok=True)
        self.log_path = os.path.join(WORKSPACE, 'chromium.log')
        to_r, to_w = os.pipe()
        from_r, from_w = os.pipe()
        to_r, to_w, from_r, from_w = (high_fd(fd) for fd in (to_r, to_w, from_r, from_w))
        null = high_fd(os.open('/dev/null', os.O_RDWR))
        log = high_fd(os.open(self.log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600))
        proxy_host = PROXY.split(':', 1)[0]
        # A7 live: the same browser, drawn on the unit's private display in kiosk
        # mode (no address bar or tabs) under the managed policy; still the pipe.
        mode = ['--kiosk', '--ozone-platform=x11', '--window-position=0,0'] if live else ['--headless=new']
        argv = [CHROMIUM, *mode, '--remote-debugging-pipe',
                '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
                '--disable-background-networking', '--disable-component-update',
                '--disable-sync', '--disable-extensions', '--disable-default-apps',
                '--disable-domain-reliability', '--disable-client-side-phishing-detection',
                '--disable-breakpad', '--no-pings', '--disable-quic', '--disable-gpu',
                '--password-store=basic', '--use-mock-keychain',
                '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
                '--proxy-server=http://' + PROXY, '--proxy-bypass-list=<-loopback>',
                '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ' + proxy_host,
                '--ignore-certificate-errors-spki-list=' + spki,
                '--window-size=%d,%d' % VIEWPORT, 'about:blank']
        env = {'HOME': home, 'XDG_CONFIG_HOME': os.path.join(home, '.config'),
               'XDG_CACHE_HOME': os.path.join(home, '.cache'), 'TMPDIR': WORKSPACE,
               'LANG': 'C.UTF-8', 'PATH': '/usr/bin:/bin'}
        if live:
            env.update(DISPLAY=live.env['DISPLAY'], XAUTHORITY=live.env['XAUTHORITY'])
        started = time.monotonic()
        # No --no-sandbox: Chromium keeps its own namespace/seccomp sandbox
        # inside the unprivileged unit.
        self.pid = os.posix_spawn(CHROMIUM, argv, env, file_actions=[
            (os.POSIX_SPAWN_DUP2, null, 0), (os.POSIX_SPAWN_DUP2, null, 1),
            (os.POSIX_SPAWN_DUP2, log, 2), (os.POSIX_SPAWN_DUP2, to_r, 3),
            (os.POSIX_SPAWN_DUP2, from_w, 4)], setsid=True)
        for fd in (to_r, from_w, null, log):
            os.close(fd)
        self.exited = threading.Event()
        threading.Thread(target=self._wait, daemon=True).start()
        self.cdp = Cdp(to_w, from_r)
        self.cdp.on('Fetch.requestPaused', self._paused)
        self.cdp.on('Network.responseReceived', self._response)
        self.cdp.on('Network.requestWillBeSent', self._request)
        self.cdp.on('Target.targetCreated', self._created)
        self.cdp.on('Target.attachedToTarget', self._attached)
        try:
            self.cdp.call('Target.setDiscoverTargets', {'discover': True}, timeout=30)
            pages = [t for t in self.cdp.call('Target.getTargets')['targetInfos'] if t.get('type') == 'page']
            if pages:
                self.main_target = pages[0]['targetId']
            else:
                self.main_target = self.cdp.call('Target.createTarget', {'url': 'about:blank'})['targetId']
            self.session = self.cdp.call('Target.attachToTarget',
                                         {'targetId': self.main_target, 'flatten': True})['sessionId']
            self.cdp.call('Browser.setDownloadBehavior', {'behavior': 'deny'})
            for method, params in (
                    ('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]}),
                    ('Page.enable', {}), ('Network.enable', {}),
                    ('Network.setBypassServiceWorker', {'bypass': True}),
                    ('Network.setCacheDisabled', {'cacheDisabled': True}),
                    ('Emulation.setDeviceMetricsOverride', {'width': VIEWPORT[0], 'height': VIEWPORT[1],
                                                            'deviceScaleFactor': 1, 'mobile': False}),
                    ('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': True,
                                              'flatten': True})):
                self.cdp.call(method, params, self.session)
            for page in pages[1:]:
                self.cdp.notify('Target.closeTarget', {'targetId': page['targetId']})
        except Refused:
            diagnostic = self.diagnostics()
            self.close()
            failure = Refused('BROWSER_START_FAILED')
            failure.diagnostic = diagnostic
            raise failure
        self.start_seconds = round(time.monotonic() - started, 3)

    def _wait(self):
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        self.exited.set()

    def _paused(self, params, session):
        request = params.get('request', {})
        url, method = request.get('url'), request.get('method')
        if method == 'POST' and url == ORIGIN + LOGIN_PATH and self.login_armed > 0:
            # The armed submit's own request; its body is never read or logged here.
            self.login_armed -= 1
            self.login_posts += 1
            self.allowed += 1
            self.cdp.notify('Fetch.continueRequest', {'requestId': params.get('requestId')}, session)
            return
        if permits(url, method):
            self.allowed += 1
            self.cdp.notify('Fetch.continueRequest', {'requestId': params.get('requestId')}, session)
            return
        if len(self.blocked) < 50:
            try:
                parts = urlsplit(url or '')
                self.blocked.append({'method': str(method)[:8], 'scheme': parts.scheme[:8],
                                     'host': (parts.hostname or '')[:80], 'port': parts.port,
                                     'path': parts.path[:80]})
            except ValueError:
                self.blocked.append({'method': str(method)[:8], 'unparsable': True})
        self.cdp.notify('Fetch.failRequest', {'requestId': params.get('requestId'),
                                               'errorReason': 'BlockedByClient'}, session)

    def _request(self, params, session):
        # A redirect of the sign-in request arrives as a new request carrying the
        # login's redirect response. Other page loads after a sign-in (fonts,
        # images) are refused by the policy too, but they are not the sign-in.
        redirect = params.get('redirectResponse')
        if (isinstance(redirect, dict) and redirect.get('url') == ORIGIN + LOGIN_PATH
                and self.login_posts and not self.login_redirected):
            self.login_redirected = True

    def _response(self, params, session):
        response = params.get('response', {})
        if response.get('url') == ORIGIN + LOGIN_PATH and self.login_posts:
            self.login_status = response.get('status')
        if session == getattr(self, 'session', None) and params.get('type') == 'Document':
            self.statuses[params.get('loaderId')] = (params.get('response', {}).get('status'),
                                                     params.get('response', {}).get('url'))

    def _created(self, params, session):
        info = params.get('targetInfo', {})
        # One page only: popups and new windows are closed before use.
        if info.get('type') == 'page' and self.main_target and info.get('targetId') != self.main_target:
            self.cdp.notify('Target.closeTarget', {'targetId': info.get('targetId')})

    def _attached(self, params, session):
        child = params.get('sessionId')
        kind = params.get('targetInfo', {}).get('type')
        if kind in ('service_worker', 'shared_worker'):
            self.cdp.notify('Target.closeTarget', {'targetId': params['targetInfo'].get('targetId')})
            return
        # Frames and dedicated workers get the same request policy first.
        self.cdp.notify('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]}, child)
        self.cdp.notify('Runtime.runIfWaitingForDebugger', {}, child)

    def _frame(self):
        return self.cdp.call('Page.getFrameTree', {}, self.session)['frameTree']['frame']['id']

    def isolated(self, expression, await_promise=False, timeout=STEP_SECONDS):
        """Evaluate fixed code in a private world the page script cannot patch."""
        context = self.cdp.call('Page.createIsolatedWorld',
                                {'frameId': self._frame(), 'worldName': 'pp-a3-broker'},
                                self.session)['executionContextId']
        return self._evaluate(expression, await_promise, timeout, context)

    def main_world(self, expression, timeout):
        return self._evaluate(expression, True, timeout, None)

    def _evaluate(self, expression, await_promise, timeout, context):
        params = {'expression': expression, 'returnByValue': True, 'awaitPromise': await_promise}
        if context is not None:
            params['contextId'] = context
        result = self.cdp.call('Runtime.evaluate', params, self.session, timeout)
        if result.get('exceptionDetails'):
            raise Refused('BROWSER_SCRIPT_FAILED')
        return result.get('result', {}).get('value')

    def navigate(self, path):
        url = ORIGIN + path
        loaded = self.cdp.expect('Page.loadEventFired', lambda p, s: s == self.session)
        result = self.cdp.call('Page.navigate', {'url': url}, self.session)
        if result.get('errorText'):
            raise Refused('BROWSER_NAVIGATION_FAILED')
        loaded()
        status, final = self.statuses.get(result.get('loaderId'), (None, None))
        if (not isinstance(status, int) or not 200 <= status < 300 or final != url
                or self.isolated('location.href') != url):
            raise Refused('BROWSER_NAVIGATION_FAILED')

    def fixed_json(self, path):
        value = self.isolated(FIXED_JSON % json.dumps(path), await_promise=True, timeout=12)
        if not isinstance(value, dict) or value.get('ok') is not True:
            raise Refused('BROWSER_READBACK_FAILED')
        return value.get('data')

    def button(self, name, click):
        wait_ms = STEP_SECONDS * 1000
        return self.isolated(FIND_BUTTON % (json.dumps(name), 'true' if click else 'false', wait_ms),
                             await_promise=True, timeout=STEP_SECONDS + 5)

    def dialog_open(self):
        return self.isolated(DIALOG_OPEN) is True

    def login_form(self, op, filled=(0, 0)):
        return self.isolated(LOGIN_FORM % (json.dumps(op), filled[0], filled[1]))

    def submit_bound_fixture(self, binding_id):
        """Type the broker-delivered value into the typed login form; report the outcome only."""
        if not self.dialog_open() or self.login_form('check') is not True:
            raise Refused('LOGIN_FORM_MISSING')
        username, password = receive_credential(
            os.path.join(WORKSPACE, CREDENTIAL_FIFO),
            on_open=lambda: self.channel.emit({'event': 'credential_channel', 'binding_id': binding_id}))
        try:
            for op, value in (('username', username), ('password', password)):
                if self.login_form(op) is not True:
                    raise Refused('LOGIN_FORM_MISSING')
                self.cdp.call('Input.insertText', {'text': value.decode('ascii')}, self.session)
            if self.login_form('filled', (len(username), len(password))) is not True:
                raise Refused('CREDENTIAL_ENTRY_FAILED')
            self.login_status, self.login_posts, self.login_armed = None, 0, 1
            self.submitted = True
            self.bound_email = username.decode('ascii').lower()
            self.login_redirected = False
            self.login_form('submit')
            deadline = time.monotonic() + STEP_SECONDS
            while self.login_status is None and not self.login_redirected and time.monotonic() < deadline:
                time.sleep(0.1)
            self.login_armed = 0
            status = self.login_status
            try:
                session = self.fixed_json('/api/session')
            except Refused:
                session = None
            as_bound = (isinstance(session, dict) and session.get('authenticated') is True and
                        session.get('email') == username.decode('ascii').lower())
            challenge = session.get('challenge') if isinstance(session, dict) else None
            # The sign-in itself was redirected (a 3xx status is also caught below).
            off_origin = self.login_redirected
        finally:
            self.login_armed = 0
            wipe(username)
            wipe(password)
            try:
                # A rejected sign-in leaves the dialog open: never leave the value in it.
                self.login_form('clear')
            except Refused:
                pass
        outcome = classify_login(status, as_bound, challenge, off_origin)
        return {'binding_id': binding_id, 'outcome': outcome, 'login_requests': self.login_posts,
                'untrusted_page_claim_authenticated_as_bound_account': as_bound}

    def logout(self):
        """POST /api/logout before teardown when this attempt submitted a credential."""
        try:
            return 'done' if self.isolated(LOGOUT, await_promise=True, timeout=10) is True else 'failed'
        except Refused:
            return 'failed'

    def action(self, name, binding_id=None):
        if name == 'submit_bound_fixture':
            if not isinstance(binding_id, str) or not UUID.fullmatch(binding_id):
                raise Refused('INVALID_COMMAND')
            return self.submit_bound_fixture(binding_id)
        if name == 'open_landing':
            self.navigate('/')
            return {'at': 'landing'}
        if name == 'open_login':
            if not self.button('Sign in', True):
                raise Refused('BROWSER_ELEMENT_MISSING')
            deadline = time.monotonic() + STEP_SECONDS
            while not self.dialog_open():
                if time.monotonic() >= deadline:
                    raise Refused('BROWSER_TIMEOUT')
                time.sleep(0.1)
            return {'at': 'login_dialog'}
        if name == 'read_workspace':
            self.navigate('/workspace')
            return {'at': 'workspace'}
        if name == 'read_session':
            data = self.fixed_json('/api/session')
            out = {'untrusted_page_claim_authenticated': isinstance(data, dict) and
                   data.get('authenticated') is True and data.get('email') == 'demo@fractionate.ai'}
            if self.bound_email is not None:
                # A5: after a submit, whether the session names the bound account.
                out['untrusted_page_claim_authenticated_as_bound_account'] = (
                    isinstance(data, dict) and data.get('authenticated') is True and
                    data.get('email') == self.bound_email)
            return out
        if name == 'read_files':
            data = self.fixed_json('/api/files')
            files = data.get('files') if isinstance(data, dict) else None
            return {'untrusted_page_claim_sample_present': isinstance(files, list) and any(
                isinstance(f, dict) and f.get('id') == 'sample-metrics' and
                f.get('name') == 'sample-metrics.csv' for f in files)}
        if name == 'sign_out':
            if not self.button('Sign out', True):
                raise Refused('BROWSER_ELEMENT_MISSING')
            data = self.fixed_json('/api/session')
            return {'untrusted_page_claim_signed_out': isinstance(data, dict) and
                    data.get('authenticated') is False}
        raise Refused('INVALID_BROWSER_ACTION')

    def view(self):
        shot = self.cdp.call('Page.captureScreenshot', {'format': 'png'}, self.session)['data']
        try:
            url = self.isolated('location.href')
        except Refused:
            url = None
        return {'png_base64': shot, 'width': VIEWPORT[0], 'height': VIEWPORT[1],
                'untrusted_page_url': url if isinstance(url, str) else None}

    def human_input(self, value):
        validate_input(value)
        kind = value['kind']
        if kind in ('click', 'scroll'):
            base = {'x': value['x'], 'y': value['y']}
            if kind == 'click':
                for event in ('mouseMoved', 'mousePressed', 'mouseReleased'):
                    params = dict(base, type=event)
                    if event != 'mouseMoved':
                        params.update(button='left', clickCount=1)
                    self.cdp.call('Input.dispatchMouseEvent', params, self.session)
            else:
                self.cdp.call('Input.dispatchMouseEvent', dict(base, type='mouseWheel', deltaX=0,
                                                              deltaY=value['dy']), self.session)
        elif kind == 'key':
            code, text = KEYS[value['key']]
            down = {'type': 'keyDown', 'key': value['key'], 'code': value['key'],
                    'windowsVirtualKeyCode': code, 'nativeVirtualKeyCode': code}
            if text:
                down['text'] = text
            self.cdp.call('Input.dispatchKeyEvent', down, self.session)
            self.cdp.call('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': value['key'], 'code': value['key'],
                                                     'windowsVirtualKeyCode': code,
                                                     'nativeVirtualKeyCode': code}, self.session)
        else:
            self.cdp.call('Input.insertText', {'text': value['text']}, self.session)
        return {'input': kind}

    def observe(self):
        """Operator proof readback of the fixed dialog state; untrusted page data."""
        return {'untrusted_dialog_open': self.dialog_open(),
                'untrusted_page_url': self.isolated('location.href')}

    def locate(self, target):
        names = {'sign_in_button': 'Sign in', 'sign_out_button': 'Sign out'}
        if target not in names:
            raise Refused('INVALID_TARGET')
        point = self.button(names[target], False)
        if not isinstance(point, dict):
            raise Refused('BROWSER_ELEMENT_MISSING')
        return {'x': point.get('x'), 'y': point.get('y')}

    def egress_probe(self):
        before = len(self.blocked)
        result = self.main_world(EGRESS_PROBE, timeout=60)
        # Top-level navigations are not governed by the page's own CSP, so they
        # exercise this runner's request policy on the real origin as well.
        navigations = {}
        for key, url in (('cross_origin', 'https://example.com/'), ('raw_ip', 'https://1.1.1.1/'),
                         ('alternate_port', 'https://demo.fractionate.ai:8443/'),
                         ('plain_http', 'http://demo.fractionate.ai/')):
            try:
                reply = self.cdp.call('Page.navigate', {'url': url}, self.session)
                if reply.get('errorText'):
                    navigations[key] = 'refused'
                else:
                    # Chromium's HTTPS-Upgrades may rewrite http:// before any request;
                    # only the committed URL says where the browser actually went.
                    landed = self.isolated('location.href')
                    navigations[key] = ('upgraded_to_approved_origin' if permits(landed, 'GET')
                                        else 'reached')
            except Refused:
                navigations[key] = 'refused'
        self.navigate('/')
        return {'page_attempts': result, 'navigation_attempts': navigations,
                'browser_layer_refusals': self.blocked[before:]}

    def diagnostics(self):
        try:
            with open(self.log_path, 'rb') as stream:
                stream.seek(0, os.SEEK_END)
                stream.seek(max(0, stream.tell() - 1500))
                return stream.read().decode('utf-8', 'replace')
        except OSError:
            return ''

    def close(self):
        try:
            if not self.exited.is_set():
                self.cdp.notify('Browser.close')
                self.exited.wait(3)
        except Exception:  # noqa: BLE001 - shutdown must continue to SIGKILL.
            pass
        if not self.exited.is_set():
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.exited.wait(3)


def workspace_identity():
    info = os.stat(WORKSPACE)
    fs = os.statvfs(WORKSPACE)
    fstype = None
    try:
        with open('/proc/self/mountinfo') as stream:
            for line in stream:
                fields = line.split()
                if len(fields) > 4 and fields[4] == WORKSPACE:
                    fstype = line.split(' - ', 1)[1].split()[0]
    except (OSError, IndexError):
        fstype = None
    return {'device': '%d:%d' % (os.major(info.st_dev), os.minor(info.st_dev)),
            'fstype': fstype, 'size_kib': fs.f_blocks * fs.f_frsize // 1024}


def own_cgroup():
    try:
        with open('/proc/self/cgroup') as stream:
            return stream.read().strip().split(':')[-1]
    except OSError:
        return None


def cgroup_stat(name):
    group = own_cgroup()
    try:
        with open('/sys/fs/cgroup' + group + '/' + name) as stream:
            return stream.read()
    except (OSError, TypeError):
        return ''


def proof_cpu(channel):
    usage = lambda: dict(l.split() for l in cgroup_stat('cpu.stat').splitlines() if l.strip())  # noqa: E731
    before = usage()
    started = time.monotonic()
    children = []
    for _ in range(2):
        pid = os.fork()
        if pid == 0:
            end = time.monotonic() + 3
            while time.monotonic() < end:
                pass
            os._exit(0)
        children.append(pid)
    for pid in children:
        os.waitpid(pid, 0)
    wall = time.monotonic() - started
    after = usage()
    delta = {k: int(after.get(k, 0)) - int(before.get(k, 0))
             for k in ('usage_usec', 'nr_throttled', 'throttled_usec')}
    channel.emit({'event': 'proof', 'case': 'cpu', 'wall_usec': int(wall * 1e6), **delta})


def proof_memory(channel):
    blocks = []
    for index in range(1, 129):
        # Filled bytes, so every page is resident and charged to the unit.
        blocks.append(b'\x01' * (64 * 1024 * 1024))
        channel.emit({'event': 'progress', 'case': 'memory', 'allocated_mib': index * 64})
    channel.emit({'event': 'proof', 'case': 'memory', 'limit_failed': True})


def proof_tasks(channel):
    gate = threading.Event()
    started = 0
    try:
        while started < 100000:
            thread = threading.Thread(target=gate.wait, daemon=True)
            thread.start()
            started += 1
        result = {'limit_failed': True}
    except RuntimeError:
        result = {'denied_after_threads': started}
    gate.set()
    channel.emit({'event': 'proof', 'case': 'tasks', 'pids_max': cgroup_stat('pids.max').strip(), **result})


def proof_disk(channel):
    written, code = 0, None
    try:
        with open(os.path.join(WORKSPACE, 'fill'), 'wb') as stream:
            while written < 64 * 1024 ** 3:
                stream.write(b'\0' * (1024 * 1024))
                stream.flush()
                written += 1024 * 1024
    except OSError as error:
        code = error.errno
    channel.emit({'event': 'proof', 'case': 'disk', 'written_mib': written // (1024 * 1024),
                  'errno': code, 'enospc': code == 28})


def proof_descendant(channel):
    reader, writer = os.pipe()
    first = os.fork()
    if first == 0:
        os.close(reader)
        os.setsid()
        second = os.fork()
        if second == 0:
            os.write(writer, str(os.getpid()).encode())
            os.close(writer)
            time.sleep(3600)
            os._exit(0)
        os._exit(0)
    os.close(writer)
    os.waitpid(first, 0)
    pid = int(os.read(reader, 32) or b'0')
    os.close(reader)
    # The detached grandchild left the session but not the unit cgroup.
    channel.emit({'event': 'proof', 'case': 'descendant', 'detached_pid': pid,
                  'same_cgroup': open('/proc/%d/cgroup' % pid).read().strip().split(':')[-1] == own_cgroup()})


def proof_escape(channel):
    """In-unit reachability from the worker's own identity; never proxy/fence bypass."""
    results = {}

    def connect(name, family, address, timeout=2):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                s.connect(address)
            results[name] = 'connected'
        except OSError as error:
            results[name] = 'refused:%s' % (error.errno if error.errno is not None else type(error).__name__)

    for name, family, address in (
            ('proxy_listener', socket.AF_INET, ('10.185.17.1', 18083)),
            ('host_incus_api', socket.AF_INET, ('10.185.17.1', 8443)),
            ('host_ssh', socket.AF_INET, ('10.185.17.1', 22)),
            ('host_backend', socket.AF_INET, ('10.185.17.1', 3001)),
            ('host_dns_tcp', socket.AF_INET, ('10.185.17.1', 53)),
            ('public_ipv4', socket.AF_INET, ('1.1.1.1', 443)),
            ('host_ipv6', socket.AF_INET6, ('fd42:53c1:d5e6:16b0::1', 8443)),
            ('public_ipv6', socket.AF_INET6, ('2606:4700:4700::1111', 443)),
            ('loopback', socket.AF_INET, ('127.0.0.1', 22))):
        connect(name, family, address)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(2)
            s.sendto(b'\0' * 12, ('10.185.17.1', 53))
            s.recvfrom(512)
        results['host_dns_udp'] = 'answered'
    except OSError as error:
        results['host_dns_udp'] = 'refused:%s' % error.errno
    # Raw IPv4 needs a real protocol: protocol 0 fails EPROTONOSUPPORT before
    # any privilege check (the first target run recorded exactly that).
    for name, family, kind, proto in (('packet_socket', getattr(socket, 'AF_PACKET', 17), socket.SOCK_RAW, 0),
                                      ('vsock_socket', getattr(socket, 'AF_VSOCK', 40), socket.SOCK_STREAM, 0),
                                      ('raw_ipv4_socket', socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)):
        try:
            socket.socket(family, kind, proto).close()
            results[name] = 'created'
        except OSError as error:
            results[name] = 'refused:%s' % error.errno
    for name, path in (('incus_agent_dir', '/run/incus_agent'), ('guest_api_socket', '/dev/incus/sock'),
                       ('vsock_device', '/dev/vsock'), ('kvm_device', '/dev/kvm'),
                       ('dbus_system_socket', '/run/dbus/system_bus_socket'),
                       ('systemd_private_socket', '/run/systemd/private'),
                       ('shadow', '/etc/shadow'), ('root_home', '/root'), ('var_lib', '/var/lib'),
                       ('pid1_environ', '/proc/1/environ'), ('scsi_disk', '/dev/sda'),
                       ('virtio_disk', '/dev/vda')):
        try:
            if os.path.isdir(path):
                os.listdir(path)
            else:
                with open(path, 'rb') as stream:
                    stream.read(1)
            results[name] = 'readable'
        except OSError as error:
            results[name] = 'refused:%s' % error.errno
    for name, path in (('write_etc', '/etc/pp-a3-escape'), ('write_usr', '/usr/pp-a3-escape'),
                       ('write_var_tmp', '/var/tmp/pp-a3-escape'), ('write_home', '/home/pp-a3-escape')):
        try:
            with open(path, 'wb') as stream:
                stream.write(b'x')
            os.unlink(path)
            results[name] = 'written'
        except OSError as error:
            results[name] = 'refused:%s' % error.errno
    try:
        os.setuid(0)
        results['setuid_root'] = 'succeeded'
    except OSError as error:
        results['setuid_root'] = 'refused:%s' % error.errno
    status = open('/proc/self/status').read()
    fields = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
    results['capabilities_effective'] = fields.get('CapEff', '').strip()
    results['no_new_privs'] = fields.get('NoNewPrivs', '').strip()
    results['uid'] = os.getuid()
    channel.emit({'event': 'proof', 'case': 'escape', 'results': results})


PROOF_RUN = {'proof:cpu': proof_cpu, 'proof:memory': proof_memory, 'proof:tasks': proof_tasks,
             'proof:disk': proof_disk, 'proof:escape': proof_escape, 'proof:descendant': proof_descendant}


# A7: relay operations are answered as they arrive (they only move signalling
# to and from Neko); everything else, including handing control to a person,
# waits its turn in the one command queue behind any browser action.
RELAY_OPS = frozenset(('live_open', 'live_send', 'live_close'))


def relay(command, live, channel):
    ident, op = command.get('id'), command.get('op')
    try:
        if type(ident) is not int or live is None:
            raise Refused('LIVE_UNAVAILABLE' if live is None else 'INVALID_COMMAND')
        shape = {'live_open': {'id', 'op', 'conn'}, 'live_send': {'id', 'op', 'conn', 'data'},
                 'live_close': {'id', 'op', 'conn'}}[op]
        if set(command) != shape:
            raise Refused('INVALID_COMMAND')
        if op == 'live_open':
            channel.emit({'id': ident, 'ok': True, 'result': live.open(command['conn'])})
        elif op == 'live_send':
            # No reply on success: signalling is fire-and-forget; a refusal is an event.
            if not live.send(command['conn'], command['data']):
                channel.emit({'event': 'live_dropped', 'conn': command['conn']})
        else:
            live.close_conn(command['conn'])
            channel.emit({'id': ident, 'ok': True, 'result': {'closed': True}})
    except Refused as error:
        if op == 'live_send':
            channel.emit({'event': 'live_dropped', 'conn': command.get('conn')})
        else:
            channel.emit({'id': ident, 'ok': False, 'error': error.code})


def commands(stream, sink, live=None, channel=None):
    for line in stream:
        try:
            value = json.loads(line)
        except ValueError:
            value = {'malformed': True}
        if isinstance(value, dict) and value.get('op') in RELAY_OPS:
            relay(value, live[0] if live else None, channel)
            continue
        sink.put(value)
    sink.put(None)


def serve(config, channel, stream=None):
    config = validate_config(config)
    workload = config['workload']
    if workload == 'proof:fail':
        channel.emit({'event': 'failed', 'code': 'PROOF_LAUNCH_FAILURE'})
        return 3
    inbox = queue.Queue()
    live_box = [None]
    threading.Thread(target=commands, args=(stream or sys.stdin, inbox, live_box, channel), daemon=True).start()
    browser = None
    ready = {'event': 'ready', 'workload': workload, 'workspace': workspace_identity(),
             'cgroup': own_cgroup(), 'uid': os.getuid()}
    if workload == 'browser':
        try:
            if config.get('live'):
                live_box[0] = LiveDesktop(channel).start()
            browser = Browser(config['spki'], channel, live_box[0])
        except Refused as error:
            if live_box[0] is not None:
                live_box[0].close()
            channel.emit({'event': 'failed', 'code': error.code,
                          'diagnostic': getattr(error, 'diagnostic', None)})
            return 4
        ready.update(browser_pid=browser.pid, browser_start_seconds=browser.start_seconds)
        if live_box[0] is not None:
            ready['live'] = {'udp_port': LIVE_UDP_PORT, 'neko_sha256': live_box[0].neko_sha256,
                             'policy_sha256': hashlib.sha256(live_policy_bytes()).hexdigest()}
    channel.emit(ready)
    try:
        while True:
            try:
                command = inbox.get(timeout=WATCHDOG_SECONDS)
            except queue.Empty:
                channel.emit({'event': 'watchdog'})
                return 70
            if command is None:
                return 0
            ident = command.get('id') if isinstance(command, dict) else None
            try:
                if type(ident) is not int or not isinstance(command.get('op'), str):
                    raise Refused('INVALID_COMMAND')
                op = command['op']
                shape = {'ping': {'id', 'op'}, 'stop': {'id', 'op'}, 'view': {'id', 'op'},
                         'observe': {'id', 'op'}, 'egress_probe': {'id', 'op'}, 'proof': {'id', 'op'},
                         'action': {'id', 'op', 'action'}, 'input': {'id', 'op', 'input'},
                         'locate': {'id', 'op', 'target'}, 'live_give': {'id', 'op', 'conn'},
                         'live_release': {'id', 'op'}}.get(op)
                if op == 'action' and command.get('action') == 'submit_bound_fixture':
                    shape = {'id', 'op', 'action', 'binding_id'}
                if shape is None or set(command) != shape:
                    raise Refused('INVALID_COMMAND')
                if op == 'ping':
                    result = {'pong': True}
                elif op == 'stop':
                    result = {'stopping': True}
                    if browser is not None and browser.submitted and not browser.exited.is_set():
                        result['logout'] = browser.logout()
                    channel.emit({'id': ident, 'ok': True, 'result': result})
                    return 0
                elif op == 'proof':
                    if workload not in PROOF_RUN:
                        raise Refused('INVALID_COMMAND')
                    PROOF_RUN[workload](channel)
                    result = {'proof': workload}
                elif browser is None:
                    raise Refused('INVALID_COMMAND')
                elif browser.exited.is_set():
                    raise Refused('BROWSER_CLOSED')
                elif op == 'action':
                    if command['action'] not in ACTIONS:
                        raise Refused('INVALID_BROWSER_ACTION')
                    result = browser.action(command['action'], command.get('binding_id'))
                elif op == 'view':
                    result = browser.view()
                elif op == 'input':
                    result = browser.human_input(command['input'])
                elif op in ('live_give', 'live_release'):
                    # Queued: an in-flight submit has finished and cleared both
                    # fields before a person can touch the page.
                    if live_box[0] is None:
                        raise Refused('LIVE_UNAVAILABLE')
                    result = live_box[0].give(command['conn']) if op == 'live_give' else live_box[0].release()
                elif op == 'observe':
                    result = browser.observe()
                elif op == 'locate':
                    result = browser.locate(command['target'])
                else:
                    result = browser.egress_probe()
                channel.emit({'id': ident, 'ok': True, 'result': result})
            except Refused as error:
                reply = {'id': ident, 'ok': False, 'error': error.code}
                if browser is not None and error.code == 'BROWSER_CLOSED':
                    reply['diagnostic'] = browser.diagnostics()
                channel.emit(reply)
                if browser is not None and browser.exited.is_set():
                    return 5
    finally:
        if browser is not None:
            browser.close()
        if live_box[0] is not None:
            live_box[0].close()


def main():
    channel = Channel()
    try:
        config = json.loads(sys.argv[1]) if len(sys.argv) == 2 else None
        code = serve(config, channel)
    except Refused as error:
        channel.emit({'event': 'failed', 'code': error.code})
        code = 2
    sys.exit(code)


if __name__ == '__main__':
    main()
