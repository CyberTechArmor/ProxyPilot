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
"""
import base64
import fcntl
import json
import os
import queue
import re
import signal
import socket
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
    # Sign-in submission remains A4-only: A3 has no credential broker.
    if method == 'POST':
        return parts.path == '/api/logout'
    return False


def validate_config(value):
    if not isinstance(value, dict) or set(value) != {'attempt_id', 'workload', 'spki'}:
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


FIND_BUTTON = '''(() => {
  const want = %s;
  const name = e => ((e.getAttribute('aria-label') || e.textContent || '').trim());
  const b = [...document.querySelectorAll('button')].find(e => name(e) === want && e.getClientRects().length);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  if (%s) b.click();
  return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
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

    def __init__(self, spki, channel):
        self.channel = channel
        self.statuses = {}
        self.blocked = []
        self.allowed = 0
        self.main_target = None
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
        argv = [CHROMIUM, '--headless=new', '--remote-debugging-pipe',
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

    def _response(self, params, session):
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
        return self.isolated(FIND_BUTTON % (json.dumps(name), 'true' if click else 'false'))

    def dialog_open(self):
        return self.isolated(DIALOG_OPEN) is True

    def action(self, name):
        if name == 'submit_bound_fixture':
            raise Refused('CREDENTIAL_BROKER_UNAVAILABLE')
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
            return {'untrusted_page_claim_authenticated': isinstance(data, dict) and
                    data.get('authenticated') is True and data.get('email') == 'demo@fractionate.ai'}
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
        return {'page_attempts': result, 'browser_layer_refusals': self.blocked[before:]}

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
    for name, family, kind in (('packet_socket', getattr(socket, 'AF_PACKET', 17), socket.SOCK_RAW),
                               ('vsock_socket', getattr(socket, 'AF_VSOCK', 40), socket.SOCK_STREAM),
                               ('raw_ipv4_socket', socket.AF_INET, socket.SOCK_RAW)):
        try:
            socket.socket(family, kind).close()
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


def commands(stream, sink):
    for line in stream:
        try:
            value = json.loads(line)
        except ValueError:
            value = {'malformed': True}
        sink.put(value)
    sink.put(None)


def serve(config, channel, stream=None):
    config = validate_config(config)
    workload = config['workload']
    if workload == 'proof:fail':
        channel.emit({'event': 'failed', 'code': 'PROOF_LAUNCH_FAILURE'})
        return 3
    inbox = queue.Queue()
    threading.Thread(target=commands, args=(stream or sys.stdin, inbox), daemon=True).start()
    browser = None
    ready = {'event': 'ready', 'workload': workload, 'workspace': workspace_identity(),
             'cgroup': own_cgroup(), 'uid': os.getuid()}
    if workload == 'browser':
        try:
            browser = Browser(config['spki'], channel)
        except Refused as error:
            channel.emit({'event': 'failed', 'code': error.code,
                          'diagnostic': getattr(error, 'diagnostic', None)})
            return 4
        ready.update(browser_pid=browser.pid, browser_start_seconds=browser.start_seconds)
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
                         'locate': {'id', 'op', 'target'}}.get(op)
                if shape is None or set(command) != shape:
                    raise Refused('INVALID_COMMAND')
                if op == 'ping':
                    result = {'pong': True}
                elif op == 'stop':
                    channel.emit({'id': ident, 'ok': True, 'result': {'stopping': True}})
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
                    result = browser.action(command['action'])
                elif op == 'view':
                    result = browser.view()
                elif op == 'input':
                    result = browser.human_input(command['input'])
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
