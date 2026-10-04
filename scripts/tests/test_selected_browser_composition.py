"""Actual Chromium + supervisor + gateway composition; local transport only.

Installed Incus/nft/Neko boundaries are fixture-injected, never attested here.
The reviewed supervisor, bundled guest, CDP, request controller, TLS proxy,
wire hash check and upstream response handling run without a fake browser.
"""
import base64
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

import test_selected_browser_supervisor as fixture

s = fixture.s
ROOT = Path(__file__).resolve().parents[1]
SITE = 'https://selected.example'
OTHER = 'https://frame.example'
STARTUP_PHASE_LIMIT = 32
STARTUP_METHODS = ('Target.setDiscoverTargets', 'Target.getTargets', 'Target.createTarget',
    'Target.attachToTarget', 'Browser.setDownloadBehavior', 'Fetch.enable', 'Page.enable',
    'Network.enable', 'Network.setBypassServiceWorker', 'Network.setCacheDisabled',
    'Emulation.setDeviceMetricsOverride', 'Target.setAutoAttach')
STARTUP_PHASES = ('guest_loading', 'guest_loaded', 'serve', 'spawn', 'cdp_call',
    'guest_ready', 'controlled_reply_hold', 'controlled_setup_delay')


def startup_phases(root):
    """Read only the fixture's fixed, bounded, content-free startup marker."""
    result = dict(records=[], invalid=False, incomplete=False)
    try:
        fd = os.open(root / 'guest/startup-phases-fixture.jsonl', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                result['invalid'] = True
                return result
            data = stream.read(16385)
    except FileNotFoundError:
        return result
    except OSError:
        result['invalid'] = True
        return result
    if len(data) > 16384:
        result['invalid'] = True
        return result
    lines = data.splitlines(keepends=True)
    if len(lines) > STARTUP_PHASE_LIMIT:
        result['invalid'] = True
        return result
    for line in lines:
        if not line.endswith(b'\n'):
            result['incomplete'] = True
            break  # A concurrent append may have one incomplete final row.
        try:
            row = json.loads(line)
            if (type(row) is not dict or set(row) != {'phase', 'method', 'status', 'elapsed_ms'} or
                    row['phase'] not in STARTUP_PHASES or row['status'] not in ('start', 'end', 'error') or
                    type(row['elapsed_ms']) is not int or not 0 <= row['elapsed_ms'] <= 86400000 or
                    (row['method'] not in STARTUP_METHODS if row['phase'] in ('cdp_call', 'controlled_reply_hold')
                     else row['method'] is not None)):
                raise ValueError('Invalid fixed startup row')
        except (ValueError, TypeError):
            result['invalid'] = True
            break
        result['records'].append(row)
    return result


def fixture_process(pid):
    """Read a PID fingerprint without confusing a reused PID with our child."""
    try:
        text = (Path('/proc') / str(pid) / 'stat').read_text()
    except (FileNotFoundError, ProcessLookupError):
        return None
    fields = text[text.rfind(')') + 2:].split()
    return dict(pid=pid, state=fields[0], parent=int(fields[1]), group=int(fields[2]),
                session=int(fields[3]), start=int(fields[19]),
                cpu_ticks=int(fields[11])+int(fields[12]), rss_pages=int(fields[21]))


class Origin(BaseHTTPRequestHandler):
    received = []

    def log_message(self, *_):
        pass

    def do_GET(self):
        Origin.received.append((self.command, self.headers.get('Host'), self.path, b''))
        icon = '<link rel="icon" href="data:,">'
        if self.path == '/public-start':
            self.send_response(302);self.send_header('Location',OTHER+'/public-page');self.end_headers();return
        if self.path == '/public-page':
            body=icon+'<h1>Public redirect destination</h1><img src="https://frame.example/asset.png">'
        elif self.path == '/navigation':
            body = icon + '<h1>Original page</h1><a href="https://frame.example/visit">Approved next visit</a>'
        elif self.path == '/resource':
            body = icon + '<h1>Resource page</h1><img src="https://frame.example/asset.png">'
        elif self.path == '/visit':
            body = icon + '<h1>Temporary destination reached</h1>'
        elif self.path == '/write':
            body = icon + '<form action="/save" method="POST"><input name="note" value="fixture"><button>Save fixture</button></form>'
        elif self.path == '/manual-write':
            body = icon + '<form action="/save" method="POST"><button style="position:absolute;left:10px;top:10px;width:180px;height:40px">Save fixture</button></form>'
        elif self.path == '/local-form-preparation':
            body = icon + '''<h1>Local form preparation</h1><p id="state">Not prepared</p>
                <button type="button" onclick="document.getElementById('state').textContent='First local change complete'">First local change</button>
                <button type="button" onclick="document.getElementById('state').textContent='Second local change complete'">Second local change</button>
                <form action="/save" method="POST" onsubmit="event.preventDefault();document.getElementById('state').textContent='Submission stopped locally'">
                <button type="submit">Prevent submission</button></form>'''
        elif self.path == '/cookie-login':
            self._send((icon + '<h1>Fixture account signed in</h1><a href="/cookie-read">Read account</a>').encode(),
                       'text/html', cookie='fixture_session=attempt-private; Secure; HttpOnly; SameSite=Strict; Path=/')
            return
        elif self.path == '/cookie-read':
            body = icon + '<h1>' + ('Account session retained' if self.headers.get('Cookie') ==
                'fixture_session=attempt-private' else 'Account session absent') + '</h1>'
        else:
            body = icon + '<h1>Fixture response</h1>'
        self._send(body.encode(), 'text/html')

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        Origin.received.append((self.command, self.headers.get('Host'), self.path, body))
        self._send(b'<link rel="icon" href="data:"><h1>Saved fixture</h1><img src="https://frame.example/asset.png">', 'text/html')

    def _send(self, body, mime, cookie=None):
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class RealGuestHost(fixture.SelectedHost):
    """OS/readback doubles; all selected-browser state machines remain real."""
    def __init__(self, root, spki, proxy_port, chromium, connection_factory):
        super().__init__(root, time.time)
        self.spki, self.proxy_port, self.chromium = spki, proxy_port, chromium
        self.contacts = []
        self.registry = self.gateway_module.SelectedGatewayRegistry(root / 'real-gateway', require_root=False,
            resolver=self.selected_resolve, connection_factory=connection_factory, clock=time.time)

    def full_boundary(self):
        return dict(super().full_boundary(), spki=self.spki)

    def selected_resolve(self, parts):
        self.contacts.append(('resolve', parts['host']))
        return super().selected_resolve(parts)

    def browser_identity(self):
        marker = self.root / 'browser-ownership-fixture.json'
        if not marker.exists():
            return None
        identity = json.loads(marker.read_text())
        if (set(identity) != {'pid', 'start'} or any(type(v) is not int or v <= 0 for v in identity.values()) or
                identity['pid'] in (os.getpid(), os.getpgrp())):
            raise AssertionError('Invalid fixture browser ownership marker')
        return identity

    def live_browser_members(self):
        identity = self.browser_identity()
        if identity is None:
            return []
        leader = fixture_process(identity['pid'])
        if leader is not None and leader['start'] != identity['start']:
            raise AssertionError('Fixture browser PID was reused; refusing to signal it')
        members = []
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            member = fixture_process(int(path.name))
            if member is None or member['group'] != identity['pid'] or member['state'] in ('Z', 'X'):
                continue
            if member['session'] != identity['pid'] or member['start'] < identity['start']:
                raise AssertionError('Process is outside the recorded fixture browser session')
            members.append(member)
        return members

    def close_fixture_browser(self):
        identity = self.browser_identity()
        if identity is None:
            return
        members = self.live_browser_members()
        if members:
            try:
                os.killpg(identity['pid'], signal.SIGKILL)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 3
        while self.live_browser_members() and time.monotonic() < deadline:
            time.sleep(.02)
        if self.live_browser_members():
            raise AssertionError('Live processes survived fixture browser cleanup')

    def stop_unit(self, unit):
        # Model cgroup-wide fixture cleanup even when the guest died first.
        # The owned browser session is separate from Popen's guest session.
        try:
            return super().stop_unit(unit)
        finally:
            self.close_fixture_browser()

    def selected_gateway(self, method, params):
        result = super().selected_gateway(method, params)
        if method == 'register':
            self.registry.gateway.route_reader = lambda _: 'b' * 64
            self.registry.gateway.public_route_reader = self.selected_public_route_plan
            forward = self.registry.gateway.forward
            def observed_forward(method, url, headers, body):
                self.wire.append((method, url, 'x-proxypilot-request-token' in headers))
                return forward(method, url, headers, body)
            self.registry.gateway.forward = observed_forward
            connect = self.registry.gateway.check_connect
            def observed_connect(authority):
                self.wire.append(('CONNECT', authority, False))
                return connect(authority)
            self.registry.gateway.check_connect = observed_connect
        return result

    def spawn(self, unit, properties, source, config):
        self.trace.append('spawn')
        self.spawns += 1
        self.props[unit] = properties
        workspace = self.root / 'guest'
        workspace.mkdir()
        # Execute the reviewed compressed bundle with a non-main namespace so
        # only test boundary hooks can be set before its real serve() entrypoint.
        # No fake actions, request decisions, observations or grant results.
        code = """import os,sys,json,time,threading,stat
phase_started=time.monotonic()
phase_lock=threading.Lock()
phase_count=0
phase_closed=False
def phase(name,status,method=None):
 global phase_count
 with phase_lock:
  if phase_count>=PHASE_LIMIT or phase_closed:return
  row={'phase':name,'method':method,'status':status,'elapsed_ms':int((time.monotonic()-phase_started)*1000)}
  try:
   fd=os.open(WORKSPACE+'/startup-phases-fixture.jsonl',os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
   with os.fdopen(fd,'w') as stream:
    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):return
    stream.write(json.dumps(row,separators=(',',':'))+'\\n')
  except OSError:return
  phase_count+=1
phase('guest_loading','start')
namespace={'__name__':'selected_fixture_guest'}
exec(compile(SOURCE,'<reviewed-fixture-bundle>','exec'),namespace)
phase('guest_loaded','end')
namespace['PROXY']=PROXY
namespace['CHROMIUM']=CHROMIUM
namespace['WORKSPACE']=WORKSPACE
call=namespace['Cdp'].call
def diagnostic_call(self,method,*args,**kwargs):
 if method not in STARTUP_METHODS:return call(self,method,*args,**kwargs)
 phase('cdp_call','start',method)
 try:result=call(self,method,*args,**kwargs)
 except BaseException:
  phase('cdp_call','error',method)
  raise
 phase('cdp_call','end',method)
 return result
namespace['Cdp'].call=diagnostic_call
write=namespace['Cdp']._write
held_discovery_id=None
def diagnostic_write(self,message):
 global held_discovery_id
 if HOLD_DISCOVERY and message.get('method')=='Target.setDiscoverTargets' and held_discovery_id is None:
  held_discovery_id=message['id']
 return write(self,message)
namespace['Cdp']._write=diagnostic_write
dispatch=namespace['Cdp']._dispatch
def diagnostic_dispatch(self,message):
 if HOLD_DISCOVERY and held_discovery_id is not None and message.get('id')==held_discovery_id:
  # A controlled fixture holds this genuine reply, leaving the original call
  # pending under its unchanged 30s bound until owned transport teardown.
  phase('controlled_reply_hold','start','Target.setDiscoverTargets')
  threading.Event().wait(60)
  return
 if message.get('method')=='Fetch.requestPaused':
  p=message['params'];open(WORKSPACE+'/fetch-fixture.log','a').write(json.dumps({'session':message.get('sessionId'),'id':p.get('requestId'),'network':p.get('networkId'),'url':p.get('request',{}).get('url')})+'\\n')
 return dispatch(self,message)
namespace['Cdp']._dispatch=diagnostic_dispatch
spawn=os.posix_spawn
def fixture_spawn(path,argv,env,**kwargs):
 phase('spawn','start')
 kwargs.pop('setsid',None)
 try:pid=spawn(path,argv,env,**kwargs)
 except BaseException:
  phase('spawn','error')
  raise
 phase('spawn','end')
 return pid
os.posix_spawn=fixture_spawn
emit=namespace['Channel'].emit
def diagnostic_emit(self,value):
 global phase_closed
 if value.get('event')=='ready':
  phase('guest_ready','end')
  with phase_lock:phase_closed=True
 return emit(self,value)
namespace['Channel'].emit=diagnostic_emit
config=json.loads(sys.argv[1]);config.pop('live',None)
if DELAY_SETUP:
 phase('controlled_setup_delay','start')
 threading.Event().wait(22)
 phase('controlled_setup_delay','end')
phase('serve','start')
sys.exit(namespace['serve'](config,namespace['Channel']()))
"""
        values = dict(SOURCE=source, PROXY='127.0.0.1:%d' % self.proxy_port,
                      CHROMIUM=str(self.chromium), WORKSPACE=str(workspace),
                      PHASE_LIMIT=STARTUP_PHASE_LIMIT, STARTUP_METHODS=STARTUP_METHODS,
                      HOLD_DISCOVERY=getattr(self, 'hold_startup_discovery', False),
                      DELAY_SETUP=getattr(self, 'delay_startup_setup', False))
        program = '\n'.join(name + '=' + repr(value) for name, value in values.items()) + '\n' + code
        process = subprocess.Popen([sys.executable, '-c', program, json.dumps(config)], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0, start_new_session=True)
        self.units[unit] = process
        return process


class StartupMarkerTests(unittest.TestCase):
    def test_fixed_marker_refuses_special_file_and_unapproved_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'guest').mkdir()
            path = root / 'guest/startup-phases-fixture.jsonl'
            os.mkfifo(path)
            started = time.monotonic()
            self.assertEqual(startup_phases(root), dict(records=[], invalid=True, incomplete=False))
            self.assertLess(time.monotonic()-started, 1)
            path.unlink()
            valid = dict(phase='cdp_call', method='Target.getTargets', status='start', elapsed_ms=7)
            for row in (dict(valid, params={'password':'private-marker-control'}),
                        dict(valid, method='Runtime.evaluate'), dict(valid, elapsed_ms=True)):
                path.write_text(json.dumps(row)+'\n')
                result = startup_phases(root)
                self.assertEqual(result, dict(records=[], invalid=True, incomplete=False))
                self.assertNotIn('private-marker-control', json.dumps(result))
            path.write_text((json.dumps(valid)+'\n')*(STARTUP_PHASE_LIMIT+1))
            self.assertTrue(startup_phases(root)['invalid'])
            self.assertEqual(startup_phases(root)['records'], [])
            path.write_bytes(b'x'*16385)
            self.assertTrue(startup_phases(root)['invalid'])
            path.unlink()
            path.symlink_to(root / 'not-a-marker')
            self.assertTrue(startup_phases(root)['invalid'])


@unittest.skipUnless(Path('/usr/bin/chromium').exists() and shutil.which('openssl'), 'local Chromium + openssl required')
class BrowserCompositionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chromium_version = subprocess.run(['/usr/bin/chromium', '--version'], check=True,
            capture_output=True, text=True, timeout=10).stdout.strip()[:256]
        print('Selected composition browser: ' + cls.chromium_version, file=sys.stderr, flush=True)

    def setUp(self):
        self.ownership = patch.object(s.installer, 'secure', lambda _: None)
        self.ownership.start()
        # Short paths respect Linux's 108-byte Chromium SingletonSocket bound.
        self.temp = tempfile.TemporaryDirectory(prefix='pp-sbc-')
        self.root = Path(self.temp.name)
        cert, key = self.root / 'cert.pem', self.root / 'cert.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=selected.example', '-addext', 'subjectAltName=DNS:selected.example,DNS:frame.example,DNS:accounts.google.com',
            '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
        pub = subprocess.run(['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'], check=True, capture_output=True).stdout
        der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=pub, check=True, capture_output=True).stdout
        spki = base64.b64encode(hashlib.sha256(der).digest()).decode()
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.load_cert_chain(str(cert), str(key))
        self.origin = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        self.origin.socket = self.tls.wrap_socket(self.origin.socket, server_side=True)
        Origin.received = []
        self.origin_thread = threading.Thread(target=self.origin.serve_forever, daemon=True)
        self.origin_thread.start()
        self.upstream = []
        self.browser_wire = []
        owner = self
        class LocalPinned(fixture.s._module('composition_pinned_gateway', 'selected_browser_gateway.py').PinnedConnection):
            def connect(inner):
                owner.upstream.append((inner.parts['host'], inner.parts['port']))
                sock = socket.create_connection(('127.0.0.1', owner.origin.server_address[1]), timeout=inner.timeout)
                context = ssl.create_default_context(cafile=str(cert))
                inner.sock = context.wrap_socket(sock, server_hostname=inner.parts['host'])
        self.listener = socket.socket()
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen(32)
        self.listener.settimeout(.2)
        wrapper = self.root / 'chromium'
        # Container-only sandbox workaround; production launch is untouched.
        # Publish the browser's exact PID/start time after setsid and before exec.
        # A parent killed during CDP work can no longer orphan an untracked group.
        wrapper.write_text('''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
os.setsid()
text=Path('/proc/self/stat').read_text()
fields=text[text.rfind(')')+2:].split()
marker=Path(__file__).parent/'browser-ownership-fixture.json'
temporary=marker.with_suffix('.tmp')
temporary.write_text(json.dumps({'pid':os.getpid(),'start':int(fields[19])}))
os.replace(temporary,marker)
netlog=Path(__file__).parent/'browser-netlog-fixture.json'
os.execv('/usr/bin/chromium',['/usr/bin/chromium','--no-sandbox','--log-net-log='+str(netlog),*sys.argv[1:]])
''')
        wrapper.chmod(0o755)
        self.host = RealGuestHost(self.root, spki, self.listener.getsockname()[1], wrapper, LocalPinned)
        self.host.wire = self.browser_wire
        self.stop_proxy = threading.Event()
        def proxy():
            while not self.stop_proxy.is_set():
                try:
                    client, _ = self.listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    return
                gateway = self.host.registry.gateway
                if gateway is None:
                    client.close()
                    continue
                def serve(client=client, gateway=gateway):
                    try:
                        self.host.gateway_module.serve_selected_socket(client, gateway, self.tls)
                    finally:
                        client.close()
                threading.Thread(target=serve, daemon=True).start()
        self.proxy_thread = threading.Thread(target=proxy, daemon=True)
        self.proxy_thread.start()
        self.supervisor = s.Supervisor(host=self.host, journal=self.root / 'state.json', clock=time.time)
        self.supervisor.live_available = lambda: {'version': 1}
        self.supervisor.turn_credentials = lambda _: []  # Neko/TURN remains fixture-injected, never attested.
        self.runtime = self.supervisor._selected()
        self.c = json.loads((ROOT.parent / 'contracts/browser-agent/fixtures/general-agent.draft.json').read_text())
        self.c['work']['guide_ref'] = {'id': fixture.GUIDE, 'sha256': 'c' * 64}
        self.c['destinations']['allowed_origins'] = [{'id': 'site', 'origin': SITE,
            'roles': ['navigation', 'resource'], 'session_headers': 'omit'}]
        self.c['destinations']['entry_urls'] = [SITE + '/navigation']
        self.c['destinations']['request_rules'] = [{'id': 'read', 'destination_id': 'site', 'path_prefix': '/',
            'methods': ['GET', 'HEAD'], 'query_keys': [], 'resource_types': ['document', 'fetch', 'xhr', 'image'],
            'effect': 'read', 'max_request_bytes': 0}]
        self.ref = None

    def tearDown(self):
        for attempt in list(self.supervisor._live()):
            self.supervisor._safe_teardown(attempt['attempt_id'], 'failed')
        for process in self.host.units.values():
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(3)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
        # Unconditional: the guest may already have exited or been SIGKILLed.
        self.host.close_fixture_browser()
        self.assertEqual(self.host.live_browser_members(), [])
        if self.host.registry.gateway:
            self.host.registry.gateway.ledger.close()
        self.stop_proxy.set()
        self.listener.close()
        self.proxy_thread.join(3)
        self.origin.shutdown()
        self.origin.server_close()
        self.origin_thread.join(3)
        self.temp.cleanup()
        self.ownership.stop()

    def launch(self, path='/navigation'):
        spec = self.launch_parameters(path)
        self.ref = dict(run_id=spec['run_id'], attempt_id=spec['attempt_id'], fence=1,
                        policy_sha256=spec['configuration_sha256'])
        try:
            self.runtime.launch(spec)
        except s.Refused as error:
            # This subprocess handles synthetic local fixtures only. Retain
            # bounded launch evidence without changing product diagnostics.
            worker = self.supervisor.workers.get(spec['attempt_id'])
            detail = worker.stderr_tail.decode('utf-8', 'replace')[-3000:] if worker else ''
            log = self.root / 'guest/chromium.log'
            if log.exists():
                detail += '\n' + log.read_bytes()[-6000:].decode('utf-8', 'replace')
            detail += '\n' + json.dumps(startup_phases(self.root))
            raise AssertionError('Local composition launch failed: ' + error.code + '\n' + detail) from error

    def launch_parameters(self, path='/navigation'):
        self.c['destinations']['entry_urls'] = [path if path.startswith('https://') else SITE + path]
        text = self.runtime.contract.canonical_json(self.c)
        policy = hashlib.sha256(text.encode()).hexdigest()
        spec = dict(contract_version='selected-browser.v1', project_id=fixture.PROJECT,
            run_id=fixture.helpers.RUN, attempt_id=fixture.helpers.ATTEMPT, workspace_id=fixture.helpers.WORKSPACE,
            fence=1, project_limits_revision=1,
            project_limits=dict(cpu=1, memory_mib=1024, temporary_disk_mib=256,
                max_actions=10, max_seconds=600, max_tokens=10000, max_usd=.25),
            configuration_json=text, configuration_sha256=policy, guide_version_id=fixture.GUIDE,
            guide_hash='c' * 64, consent_hash='d' * 64, deadline_at=s.stamp(time.time() + 600))
        if self.c.get('mode')=='public_navigation':spec.update(guide_version_id=None,guide_hash=None,consent_hash=None)
        return spec

    def test_real_discovery_reply_hold_reports_phase_at_transport_deadline_and_cleans_owned_browser(self):
        # Exercise an explicit short 20s diagnostic transport deadline (the
        # prior Node launch bound), without changing the CDP or host bounds.
        env = dict(os.environ, PROXYPILOT_TEST_BROWSER_LAUNCH_FAULT='stall_discovery')
        messages, events, sent = queue.Queue(), [], []
        fenced = False
        with tempfile.TemporaryFile() as stderr:
            process = subprocess.Popen([sys.executable, '-u', str(ROOT / 'tests/selected_browser_backend_bridge.py')],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, env=env)
            def read_replies():
                try:
                    for line in process.stdout:
                        messages.put(json.loads(line))
                finally:
                    messages.put(None)
            reader = threading.Thread(target=read_replies, daemon=True)
            reader.start()
            def request(method, params=None):
                nonlocal fenced
                if fenced:
                    raise RuntimeError('Fixture transport is fenced')
                sent.append(method)
                ident = len(sent)
                process.stdin.write(json.dumps(dict(id=ident, method=method, params=params or {}))+'\n')
                process.stdin.flush()
                deadline = time.monotonic()+20
                while True:
                    try:
                        value = messages.get(timeout=max(0, deadline-time.monotonic()))
                    except queue.Empty:
                        fenced = True
                        process.terminate()  # No command can be queued behind the held launch.
                        raise TimeoutError('FIXTURE_RPC_DEADLINE')
                    self.assertIsNotNone(value, 'Bridge exited before the controlled transport deadline')
                    if value.get('event') == 'fixture_diagnostics':
                        events.append(value)
                        self.assertLessEqual(len(events), 40)
                    elif value.get('id') == ident:
                        self.assertNotIn('error', value, repr(value))
                        return value['result']
            try:
                request('fixture_bootstrap')
                started = time.monotonic()
                with self.assertRaisesRegex(TimeoutError, 'FIXTURE_RPC_DEADLINE'):
                    request('selected_browser_launch', self.launch_parameters())
                self.assertGreaterEqual(time.monotonic()-started, 20)
                with self.assertRaisesRegex(RuntimeError, 'transport is fenced'):
                    request('fixture_inspect')
                process.wait(8)
                reader.join(3)
                while not messages.empty():
                    value = messages.get_nowait()
                    if value is not None and value.get('event') == 'fixture_diagnostics':
                        events.append(value)
                evidence = next(value['evidence'] for value in reversed(events)
                    if any(row['phase'] == 'controlled_reply_hold'
                           for row in value['evidence']['startup_phases']['records']))
                phases = evidence['startup_phases']
                self.assertFalse(phases['invalid'])
                self.assertFalse(phases['incomplete'])
                rows = phases['records']
                self.assertLessEqual(len(rows), STARTUP_PHASE_LIMIT)
                self.assertEqual([(r['phase'], r['status']) for r in rows[:5]],
                    [('guest_loading','start'), ('guest_loaded','end'), ('serve','start'),
                     ('spawn','start'), ('spawn','end')])
                self.assertTrue(any(r['phase']=='cdp_call' and r['method']=='Target.setDiscoverTargets' and
                    r['status']=='start' for r in rows))
                self.assertFalse(any(r['phase']=='cdp_call' and r['status'] in ('end','error') for r in rows))
                self.assertFalse(any(r['phase']=='guest_ready' for r in rows))
                self.assertEqual(sent, ['fixture_bootstrap', 'selected_browser_launch'])
                self.assertTrue(evidence['workers'])
                self.assertFalse(evidence['workers'][0]['ready'])
                self.assertEqual(evidence['gateway']['requests'], 0)
                self.assertEqual(evidence['gateway']['effects_sent'], 0)
                self.assertEqual(evidence['received'], [])
                self.assertEqual(evidence['upstream'], [])
                identity = evidence['browser_process']
                self.assertIsNotNone(identity)
                members = evidence['browser_processes']
                self.assertTrue(members)
                self.assertLessEqual(len(members), 16)
                for member in members:
                    self.assertEqual(member['group'], identity['pid'])
                    self.assertEqual(member['session'], identity['pid'])
                    self.assertGreaterEqual(member['start'], identity['start'])
                    self.assertGreaterEqual(member['cpu_ticks'], 0)
                    self.assertGreaterEqual(member['rss_pages'], 0)
                survivors = []
                for path in Path('/proc').iterdir():
                    if path.name.isdigit():
                        member = fixture_process(int(path.name))
                        if (member and member['group']==identity['pid'] and member['session']==identity['pid'] and
                                member['start']>=identity['start'] and member['state'] not in ('Z','X')):
                            survivors.append(member)
                self.assertEqual(survivors, [], 'Controlled startup left a live owned browser')
                self.assertEqual(process.returncode, 1)  # SIGTERM ran the bridge's verified finally cleanup.
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(8)
                process.stdin.close()
                process.stdout.close()
                reader.join(3)

    def action(self, kind, predicate=lambda _: True):
        try:
            observed = self.runtime.observe(self.ref)
        except s.Refused as error:
            self.fail(error.code + '\n' + self.diagnostics())
        candidate = next(c for c in observed['candidates'] if c['operation']['kind'] == kind and predicate(c))
        ordinal = self.supervisor.state['runs'][self.ref['run_id']]['action_count'] + 1
        envelope = dict(schema='proxypilot.browser-action.proposal.v1', **self.ref, ordinal=ordinal,
            snapshot_ref=observed['snapshot_ref'], candidate_ref=candidate['candidate_ref'],
            approval_ref=({'id':str(uuid.uuid4()),'sha256':'d'*64} if candidate['effect']=='external_change' else None),
            operation=candidate['operation'])
        result = self.runtime.action(dict(self.ref, envelope=envelope))
        self.assertEqual(result['kind'], 'pending')
        return ordinal, envelope

    def diagnostics(self):
        gate = self.host.registry.gateway
        cdp = self.root / 'guest/fetch-fixture.log'
        return repr({'browser_version':self.chromium_version, 'browser_process':self.host.browser_identity(),
            'startup_phases':startup_phases(self.root), 'browser_processes':self.host.live_browser_members()[:16],
            'browser_service_requests':self.browser_service_requests(), 'status': gate.status(),
            'cdp':cdp.read_text()[-3000:] if cdp.exists() else '', 'received': Origin.received, 'upstream': self.upstream,
            'pending': gate.pending, 'tickets': list(gate.tickets.values()),
            'trace': self.host.trace[-20:], 'wire': self.browser_wire, 'ledger': gate.ledger.rows[:5] + gate.ledger.rows[-3:]})[:6000]

    def browser_service_requests(self):
        # Synthetic-fixture-only netlog. Disclose bounded service paths and
        # annotation hashes, never cookies, headers, bodies, URL queries or keys.
        path = self.root / 'browser-netlog-fixture.json'
        if not path.exists():
            return []
        with path.open('rb') as stream:
            data = stream.read(1024 * 1024).decode('utf-8', 'replace')
        rows = []
        for line in data.splitlines()[2:]:
            try:
                event = json.loads(line.rstrip(','))
                params = event.get('params', {})
                url = urlsplit(params.get('url', ''))
                if (url.scheme not in ('http', 'https') or url.hostname in ('selected.example', 'frame.example') or
                        (url.hostname == 'accounts.google.com' and url.path in ('/cookie-login', '/cookie-read'))):
                    continue
                if not url.hostname:
                    continue
                rows.append(dict(origin=url.scheme+'://'+url.hostname, path=url.path[:128],
                    event=event.get('type'), method=params.get('method'),
                    traffic_annotation=params.get('traffic_annotation'), source=event.get('source')))
            except (ValueError, TypeError, AttributeError):
                continue  # An active browser may have one incomplete final row.
            if len(rows) >= 10:
                break
        return rows

    def force_fixture_component_update(self, *, remove_fixed_endpoint):
        # Positive/negative native-service controls only. Registration and the
        # accelerated scheduler cannot create a gateway exemption or page ticket.
        # Primary Chromium154 contracts:
        # chrome/browser/navigation_predictor/search_engine_preconnector.cc
        # components/component_updater/{configurator_impl,
        # component_updater_command_line_config_policy}.cc
        wrapper = self.root / 'chromium'
        source = wrapper.read_text()
        if remove_fixed_endpoint:
            source = source.replace('*sys.argv[1:]',
                "*[a for a in sys.argv[1:] if a!='--disable-component-update' and not a.startswith('--component-updater=')]")
            source = source.replace("'--no-sandbox',", "'--no-sandbox','--component-updater=initial-delay=0.1',")
        else:
            # Retain the product's actual endpoint; add only a test scheduler
            # delay. Inventing a duplicate about:blank flag would hide a missing
            # or broken product override.
            source = source.replace('*sys.argv[1:]',
                "*[a+',initial-delay=0.1' if a.startswith('--component-updater=') else a for a in sys.argv[1:] if a!='--disable-component-update']")
            source = source.replace("os.execv('/usr/bin/chromium'", "assert '--component-updater=url-source=about:blank' in sys.argv[1:]\n"+
                "assert any(a.startswith('--disable-features=') and 'PreconnectToSearch' in a.split('=',1)[1].split(',') for a in sys.argv[1:])\n"+
                "os.execv('/usr/bin/chromium'")
        wrapper.write_text(source)

    def poll(self, ordinal, kinds=('done', 'uncertain', 'off_list', 'request_approval')):
        deadline = time.monotonic() + 8
        result = None
        while time.monotonic() < deadline:
            result = self.runtime.poll_action(dict(self.ref, ordinal=ordinal))
            if result['kind'] in kinds:
                return result
            time.sleep(.02)
        self.fail('Action did not settle: ' + repr(result) + '\n' + self.diagnostics())

    def grant(self, origin, role):
        pending = self.runtime.pending(self.ref)
        exact = next(p for p in pending['pending'] if p['kind'] == 'off_list_destination' and p['origin'] == origin)
        identity = self.host.registry.gateway.policy.identity
        grant = dict(schema='proxypilot.selected-browser.destination-grant.v1', id=fixture.APPROVAL,
            identity=identity, origin=origin, roles=[role], purpose_sha256=self.runtime.policy.digest(exact['purpose']),
            expires_at=int(time.time() + 30), persist_to_allowlist=False, wildcards=False)
        destination = dict(id='temporary', origin=origin, roles=[role], session_headers='omit')
        return self.runtime.grant_destination(dict(self.ref, grant=grant, destination=destination))

    def retained_off_list_request(self, ordinal, origin):
        result = self.poll(ordinal)
        # A finished/idle before-contact block may settle before the retained
        # destination review. Discover that review through the real host state;
        # it must survive action settlement and still identify the exact target.
        pending = self.runtime.pending(self.ref)['pending']
        requests = [p for p in pending if p['kind'] == 'off_list_destination' and p['origin'] == origin]
        self.assertEqual(len(requests), 1, self.diagnostics())
        request = requests[0]
        self.assertTrue(request['no_contact'])
        if result['kind'] == 'off_list':
            self.assertEqual(result['escalation'], {k:v for k,v in request.items() if k != 'kind'})
        else:
            self.assertEqual(result['kind'], 'done')
            self.assertEqual(result['state'], 'blocked')
            self.assertEqual(result['code'], 'BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT')
            version, payload, signature = result['attestation'].split('.')
            self.assertEqual(version, 'sbr1')
            body = base64.urlsafe_b64decode(payload+'==')
            self.assertEqual(base64.urlsafe_b64decode(signature+'=='), self.host.sign(body))
            proof = json.loads(body)
            for key, value in self.ref.items():
                self.assertEqual(proof[key], value)
            self.assertEqual(proof['ordinal'], ordinal)
            self.assertIn(request['request_ref'], proof['request_refs'])
            self.assertTrue(proof['no_effect_sent'])
            self.assertFalse(proof['replay_allowed'])
        return request

    def approve_wire_request(self, pending):
        grant = dict(schema='proxypilot.selected-browser.effect-grant.v1', id=str(uuid.uuid4()),
            identity=self.host.registry.gateway.policy.identity, request_ref=pending['request_ref'],
            binding_sha256=pending['binding_sha256'], expires_at=int(time.time()+25), purpose_sha256='e'*64)
        return self.runtime.approve_request(dict(self.ref, request_ref=pending['request_ref'], grant=grant))

    def verify_signed_denial(self,denied,request_ref):
        version,payload,signature=denied['attestation'].split('.')
        self.assertEqual(version,'sbr1')
        body=base64.urlsafe_b64decode(payload+'==')
        proof=json.loads(body)
        self.assertEqual(base64.urlsafe_b64decode(signature+'=='),self.host.sign(body))
        self.assertEqual(proof['attempt_id'],self.ref['attempt_id'])
        self.assertEqual(proof['request_ref'],request_ref)
        self.assertFalse(proof['replay_allowed'])

    def test_public_navigation_redirect_resource_and_cleanup_with_real_chromium(self):
        self.c=json.loads((ROOT.parent/'contracts/browser-agent/fixtures/public-navigation.draft.json').read_text())
        self.host.marker_missing=True
        self.host.public_navigation_inventory=lambda:dict(v=1,vm_uuid=s.VM_UUID,protected_hosts=['controller.example'],protected_addresses=['10.185.17.1','10.185.17.179'])
        self.host.selected_managed_policy_hash=lambda:hashlib.sha256(s.runner.live_policy_bytes()).hexdigest()
        self.supervisor.turn_credentials=lambda _:[]
        # This fixture models public dual-stack DNS on an IPv4-only host.
        # Actual host-route boundaries remain injected; Chromium/TLS/gateway run.
        self.host.selected_resolve=lambda _:['1.1.1.1','2606:4700:4700::1111']
        self.host.registry.resolver=self.host.selected_resolve
        self.host.selected_public_route_plan=lambda _:dict(addresses=['1.1.1.1'],route_sha256='b'*64)
        self.launch('/public-start')
        route_reader=Mock(wraps=self.host.selected_public_route_plan)
        self.host.registry.gateway.public_route_reader=route_reader
        ordinal,envelope=self.action('navigate')
        result=self.poll(ordinal)
        self.assertEqual(result['kind'],'done',self.diagnostics())
        self.assertTrue(any(host=='frame.example' and path=='/public-page' for _,host,path,_ in Origin.received),self.diagnostics())
        self.assertTrue(any(path=='/asset.png' for _,_,path,_ in Origin.received),self.diagnostics())
        route_reader.assert_any_call(['1.1.1.1','2606:4700:4700::1111'])
        observation=self.runtime.observe(self.ref)
        self.assertIn('Public redirect destination',observation['observation'])
        self.assertEqual(self.runtime.pending(self.ref)['pending'],[])
        self.assertEqual(self.host.registry.gateway.status()['effects_sent'],0)
        frame=self.runtime.view(self.ref)
        self.assertEqual(set(frame),{'png_base64','width','height'})
        pixels=base64.b64decode(frame['png_base64'],validate=True)
        self.assertTrue(pixels.startswith(b'\x89PNG\r\n\x1a\n'))
        self.assertEqual(int.from_bytes(pixels[16:20],'big'),frame['width'])
        self.assertEqual(int.from_bytes(pixels[20:24],'big'),frame['height'])
        self.assertGreater(len(pixels),100)
        receipt=self.runtime.stop(dict(self.ref,fence=2,reason='cancelled'))
        # Stop removes the gateway; eager diagnostics must not dereference it.
        self.assertTrue(all(receipt['closed'].values()),repr(receipt))
        evidence=receipt['public_navigation_evidence']
        self.assertEqual(evidence['completed_redirects'],1)
        self.assertGreaterEqual(evidence['cross_origin_resources'],1)
        self.assertEqual(evidence['last_completed_document_origin'],OTHER)
        self.assertEqual(evidence['last_completed_document_url_sha256'],hashlib.sha256((OTHER+'/public-page').encode()).hexdigest())
        self.assertNotIn('/public-page',json.dumps(receipt))
        signed=json.loads(base64.urlsafe_b64decode(receipt['attestation'].split('.')[1]+'=='))
        self.assertEqual(signed['public_navigation_evidence'],evidence)
        self.assertEqual(signed['gateway_ledger_sha256'],receipt['final_network']['ledger_sha256'])
        self.assertIsNone(self.supervisor.state['active'])
        self.assertFalse(self.host.live_browser_members())

    def test_navigation_escalation_grant_settles_unsent_action_and_offers_new_exact_path(self):
        self.launch()
        first, _ = self.action('navigate')
        first_result = self.poll(first)
        self.assertEqual(first_result['kind'], 'done', repr(first_result) + '\n' + self.diagnostics())
        old, old_envelope = self.action('navigate', lambda c: c['operation']['url'] == OTHER + '/visit')
        escalation = self.retained_off_list_request(old, OTHER)
        self.assertTrue(escalation['no_contact'])
        self.assertFalse(any(host == 'frame.example' for host, _ in self.upstream))
        self.assertFalse(any(host == 'frame.example' for _, host in self.host.contacts))
        base = copy.deepcopy(self.c['destinations'])
        # No additional completion poll before grant: the first poll may already
        # have signed the blocked result while retaining its destination review.
        self.grant(OTHER, 'navigation')
        state = json.loads(self.supervisor.journal_path.read_text())
        old_record = next(r for r in state['attempts'][self.ref['attempt_id']]['actions'] if r['ordinal'] == old)
        self.assertEqual(old_record['state'], 'blocked')
        self.assertEqual(self.runtime.poll_action(dict(self.ref, ordinal=old))['code'], 'BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT')
        self.assertEqual(json.loads(state['attempts'][self.ref['attempt_id']]['configuration_json'])['destinations'], base)
        self.assertFalse(any(r[1] == 'frame.example' for r in Origin.received))
        new, envelope = self.action('navigate', lambda c: c['operation']['url'] == OTHER + '/visit')
        self.assertEqual(new, old + 1)
        self.assertNotEqual(envelope['candidate_ref'], old_envelope['candidate_ref'])
        self.assertEqual(envelope['operation']['destination_id'], 'temporary')
        # A destination grant never grants a wire effect. The previously absent
        # temporary-site read rule independently requires exact payload approval.
        result = self.poll(new)
        self.assertEqual(result['kind'], 'request_approval')
        self.assertFalse(any(r[1] == 'frame.example' for r in Origin.received))
        # Exercise the actual gateway TLS socket, not a request-controller double:
        # approval remains possible after the demo's ten-second socket deadline.
        held_until = time.monotonic()+10.3
        while time.monotonic()<held_until:
            time.sleep(.1)
        held = self.poll(new)
        self.assertEqual(held['kind'], 'request_approval')
        self.assertEqual(held['request']['request_ref'], result['request']['request_ref'])
        self.assertFalse(any(host=='frame.example' for host,_ in self.upstream))
        self.approve_wire_request(held['request'])
        settled = self.poll(new, kinds=('done','uncertain'))
        self.assertEqual(settled['kind'], 'uncertain')  # Unclassified GET has no business readback.
        self.assertEqual(settled['code'], 'SITE_EFFECT_READBACK_REQUIRED')
        self.assertEqual([r[2] for r in Origin.received if r[1]=='frame.example'], ['/visit'])
        self.assertEqual(self.host.registry.gateway.status()['outstanding_requests'], 0)

    def test_native_component_update_is_denied_before_any_upstream_contact(self):
        self.force_fixture_component_update(remove_fixed_endpoint=True)
        self.launch()
        deadline = time.monotonic() + 8
        while self.host.registry.gateway.status()['state'] != 'paused' and time.monotonic() < deadline:
            time.sleep(.02)
        status = self.host.registry.gateway.status()
        self.assertEqual(status['state'], 'paused', self.diagnostics())
        self.assertIn(('CONNECT', 'update.googleapis.com:443', False), self.browser_wire)
        self.assertEqual(self.upstream, [])
        self.assertEqual(Origin.received, [])
        self.assertEqual(status['requests'], 0)
        self.assertEqual(status['effects_sent'], 0)
        self.assertEqual(status['effects_uncertain'], 0)
        self.assertEqual(status['outstanding_requests'], 0)
        self.assertTrue(any(r['origin'] == 'https://update.googleapis.com' and r['path'] == '/service/update2/json'
            for r in self.browser_service_requests()), self.diagnostics())

    def test_fixed_component_endpoint_suppresses_service_without_page_url_exemption(self):
        self.force_fixture_component_update(remove_fixed_endpoint=False)
        self.launch()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            self.assertEqual(self.host.registry.gateway.status()['state'], 'running', self.diagnostics())
            time.sleep(.05)
        self.assertEqual(self.browser_wire, [])
        self.assertEqual(self.browser_service_requests(), [])
        status = self.host.registry.gateway.status()
        self.assertEqual(status['requests'], 0)
        self.assertEqual(status['effects_sent'], 0)
        self.assertEqual(status['effects_uncertain'], 0)
        self.assertEqual(status['outstanding_requests'], 0)
        self.assertEqual(self.upstream, [])
        ordinal, _ = self.action('navigate')
        self.assertEqual(self.poll(ordinal)['kind'], 'done')
        self.assertEqual([(r[1], r[2]) for r in Origin.received], [('selected.example', '/navigation')])
        self.assertTrue(all(ticket for method, _, ticket in self.browser_wire if method != 'CONNECT'))
        ordinal, _ = self.action('navigate', lambda c: c['operation']['url'] == OTHER + '/visit')
        offlist = self.retained_off_list_request(ordinal, OTHER)
        self.assertTrue(offlist['no_contact'])
        self.assertFalse(any(host == 'frame.example' for host, _ in self.upstream))

    def test_resource_escalation_grant_allows_fresh_read_without_replaying_page_load(self):
        self.launch('/resource')
        old, _ = self.action('navigate')
        result = self.retained_off_list_request(old, OTHER)
        self.assertEqual(result['origin'], OTHER)
        self.assertFalse(any(host == 'frame.example' for host, _ in self.upstream))
        before = list(Origin.received)
        self.grant(OTHER, 'resource')
        self.assertEqual(self.runtime.poll_action(dict(self.ref, ordinal=old))['code'], 'BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT')
        new, _ = self.action('read')
        result = self.poll(new)
        self.assertEqual(result['kind'], 'done')
        self.assertEqual(new, old + 1)
        self.assertEqual(Origin.received, before)  # Grant/read replayed no HTTP.
        pending = self.runtime.pending(self.ref)
        self.assertEqual(pending['pending'], [])
        self.assertEqual(pending['cumulativeusage']['requests'], 1)

    def test_sent_write_then_off_list_resource_cannot_be_settled_or_replayed(self):
        self.launch('/write')
        first,_ = self.action('navigate')
        self.assertEqual(self.poll(first)['kind'],'done')
        ordinal,_ = self.action('submit')
        review = self.poll(ordinal)
        # Synthetic fixture only: retain the first refusal and request ordering
        # before teardown. A generic `done` cannot stand in for wire approval.
        gate = self.host.registry.gateway
        fetch_log = self.root / 'guest/fetch-fixture.log'
        diagnostic = repr(dict(ordinal=ordinal, result=review, gateway=gate.status(),
            pending=gate.pending, ledger_rows=gate.ledger.rows[-48:],
            browser_wire=self.browser_wire[-48:], upstream=self.upstream[-48:],
            received=[(method, host, path, len(body)) for method, host, path, body in Origin.received[-48:]],
            trace=self.host.trace[-48:],
            fetch=fetch_log.read_text()[-8192:] if fetch_log.exists() else ''))
        self.assertFalse(any(r[0]=='POST' for r in Origin.received),diagnostic)
        self.assertEqual(review['kind'],'request_approval',diagnostic)
        self.approve_wire_request(review['request'])
        result = self.poll(ordinal,kinds=('off_list','uncertain'))
        if result['kind'] == 'uncertain':
            self.assertEqual(result['code'], 'SITE_EFFECT_READBACK_REQUIRED')
            self.assertEqual(result['state'], 'uncertain')
            self.assertNotIn('attestation', result)  # Never a signed no-effect block.
        else:
            self.assertEqual(result['kind'], 'off_list')
            self.assertEqual(result['escalation']['origin'], OTHER)
        pending = self.runtime.pending(self.ref)['pending']
        escalation = next(p for p in pending if p['kind'] == 'off_list_destination' and p['origin'] == OTHER)
        self.assertTrue(escalation['no_contact'])
        self.assertEqual(self.host.registry.gateway.status()['effects_sent'],1)
        self.assertEqual(len([r for r in Origin.received if r[0]=='POST']),1)
        self.assertFalse(any(host=='frame.example' for host,_ in self.upstream))
        with self.assertRaises(s.Refused) as caught:
            self.grant(OTHER,'resource')
        self.assertEqual(caught.exception.code,'BROWSER_ACTION_UNCERTAIN')
        self.assertEqual(len([r for r in Origin.received if r[0]=='POST']),1)
        self.assertEqual(self.host.registry.gateway.status()['temporary_destinations'],0)
        self.assertFalse(any(host == 'frame.example' for _, host in self.host.contacts))
        self.assertFalse(any(host == 'frame.example' for host, _ in self.upstream))

    def test_local_form_preparation_then_unobserved_submit_blocks_continuation(self):
        self.launch('/local-form-preparation')
        first, _ = self.action('navigate')
        self.assertEqual(self.poll(first)['kind'], 'done')
        received = list(Origin.received)
        requests = self.host.registry.gateway.status()['requests']
        self.assertEqual(requests, 1)
        for label in ('First local change', 'Second local change'):
            ordinal, _ = self.action('click', lambda c: c['label'] == 'Click ' + label)
            completed = self.poll(ordinal)
            self.assertEqual(completed['kind'], 'done', self.diagnostics())
            self.assertEqual(completed['facts'], [dict(code='BROWSER_LOCAL_OPERATION_COMPLETED', source_ref=None)])
            self.assertEqual(completed['result']['effect'], 'unverified_until_gateway_and_site_readback')
            self.assertIn(label + ' complete', self.runtime.observe(self.ref)['observation'])
            self.assertEqual(completed['usage']['requests'], requests)
            self.assertEqual(Origin.received, received)

        ordinal, envelope = self.action('submit')
        sent = self.runtime.actions[(self.ref['attempt_id'], ordinal)]
        uncertain = self.poll(ordinal, kinds=('done', 'uncertain'))
        self.assertEqual(sent[2]['reply']['error'], 'SUBMISSION_NETWORK_NOT_OBSERVED')
        self.assertEqual(uncertain['kind'], 'uncertain')
        self.assertEqual(uncertain['code'], 'SITE_EFFECT_READBACK_REQUIRED')
        self.assertEqual(uncertain['facts'], [dict(code='BROWSER_OPERATION_UNCERTAIN', source_ref=None)])
        self.assertEqual(uncertain['usage']['requests'], requests)
        observed = self.runtime.observe(self.ref)
        self.assertIn('Submission stopped locally', observed['observation'])
        journal = json.loads(self.supervisor.journal_path.read_text())
        records = journal['attempts'][self.ref['attempt_id']]['actions']
        self.assertEqual([r['state'] for r in records], ['completed', 'completed', 'completed', 'uncertain'])
        # Neither a new action nor replay of the original submission may pass
        # uncertainty. Model admission is checked before any provider bridge call.
        for proposed in (envelope, dict(envelope, ordinal=ordinal + 1)):
            with self.assertRaises(s.Refused) as caught:
                self.runtime.action(dict(self.ref, envelope=proposed))
            self.assertEqual(caught.exception.code, 'BROWSER_ACTION_UNCERTAIN')
        with patch.object(self.runtime.model, 'model') as provider:
            for purpose in ('decision', 'draft_input', 'report'):
                params = dict(purpose=purpose, run_id=self.ref['run_id'], attempt_id=self.ref['attempt_id'],
                    fence=self.ref['fence'], policy_hash=self.ref['policy_sha256'])
                with self.assertRaises(s.Refused) as caught:
                    self.runtime.dispatch('selected_browser_model', params)
                self.assertEqual(caught.exception.code, 'BROWSER_MODEL_ACTION_UNCERTAIN')
            provider.assert_not_called()
        status = self.host.registry.gateway.status()
        self.assertEqual(status['requests'], requests)
        self.assertEqual(status['effects_sent'], 0)
        self.assertEqual(status['effects_uncertain'], 0)
        self.assertEqual(status['outstanding_requests'], 0)
        self.assertEqual(Origin.received, received)

    def test_forced_guest_death_cleans_recorded_browser_group_without_other_processes(self):
        self.launch()
        ordinal, _ = self.action('navigate')
        self.assertEqual(self.poll(ordinal)['kind'], 'done')
        owned = self.host.live_browser_members()
        self.assertTrue(owned)
        identity = self.host.browser_identity()
        self.assertTrue(any(p['pid'] == identity['pid'] for p in owned))
        attempt = self.supervisor.state['attempts'][self.ref['attempt_id']]
        guest = self.host.units[attempt['unit']]
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        try:
            # A healthy Chromium often exits itself on CDP EOF. Stop the owned
            # browser first to exercise a wedged shutdown deterministically;
            # cleanup must not depend on that voluntary exit.
            os.killpg(identity['pid'], signal.SIGSTOP)
            deadline = time.monotonic() + 1
            while fixture_process(identity['pid'])['state'] not in ('T', 't') and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertIn(fixture_process(identity['pid'])['state'], ('T', 't'))
            # Reproduce the ownership gap: terminate only the guest's group.
            os.killpg(guest.pid, signal.SIGKILL)
            guest.wait(3)
            self.assertTrue(self.host.live_browser_members(), 'Fixture did not reproduce orphaned browser group')
            # Fake systemd stop must now include the recorded child session,
            # including the case where the guest itself is already gone.
            self.host.stop_unit(attempt['unit'])
            self.assertEqual(self.host.live_browser_members(), [])
            self.assertIsNone(unrelated.poll(), 'Fixture cleanup signalled an unrelated process')
        finally:
            unrelated.terminate()
            unrelated.wait(3)

    def test_agent_wire_denial_is_signed_and_does_not_send_or_replay_submission(self):
        self.launch('/write')
        first,_=self.action('navigate')
        self.assertEqual(self.poll(first)['kind'],'done')
        ordinal,_=self.action('submit')
        review=self.poll(ordinal)
        self.assertEqual(review['kind'],'request_approval')
        denied=self.runtime.deny_request(dict(self.ref,request_ref=review['request']['request_ref']))
        self.assertTrue(denied['denied'])
        self.assertTrue(denied['no_contact'])
        self.assertEqual(denied['state'],'paused')
        self.verify_signed_denial(denied,review['request']['request_ref'])
        self.assertEqual(self.runtime.poll_action(dict(self.ref,ordinal=ordinal))['code'],
            'BROWSER_OPERATION_BLOCKED_BEFORE_EFFECT')
        self.runtime.resume(self.ref)
        new,_=self.action('read')
        self.assertEqual(self.poll(new)['kind'],'done')
        self.assertFalse(any(r[0]=='POST' for r in Origin.received))
        self.assertEqual(self.host.registry.gateway.status()['outstanding_requests'],0)

    def test_manual_wire_denial_keeps_capture_paused_and_disposes_actual_held_request(self):
        self.c['destinations']['allowed_origins'][0]['roles'].append('authentication')
        self.launch('/manual-write')
        first,_=self.action('navigate')
        self.assertEqual(self.poll(first)['kind'],'done')
        controller=str(uuid.uuid4())
        custody=self.runtime.takeover(dict(self.ref,controller_id=controller,
            session_id=str(uuid.uuid4()),manual_auth=True,conn=None))
        self.assertTrue(custody['awaiting_live_connection'])
        with self.assertRaises(s.Refused):self.runtime.observe(self.ref)
        # Local typed CDP input is the disposable human transport fixture.
        # This does not attest an installed Neko connection or native custody.
        worker=self.supervisor.workers[self.ref['attempt_id']]
        reply=worker.request('selected_control',3,input=dict(kind='click',x=40,y=25))
        self.assertTrue(reply['ok'])
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            pending=self.runtime.pending(self.ref)['pending']
            if pending:break
            time.sleep(.02)
        self.assertTrue(pending,self.diagnostics())
        request=next(p for p in pending if p['kind']=='network_effect')
        denied=self.runtime.deny_request(dict(self.ref,request_ref=request['request_ref']))
        self.assertEqual(denied['state'],'human_control')
        self.assertTrue(denied['manual_auth'])
        self.verify_signed_denial(denied,request['request_ref'])
        self.assertFalse(any(r[0]=='POST' for r in Origin.received))
        self.assertEqual(self.host.registry.gateway.status()['outstanding_requests'],0)
        with self.assertRaises(s.Refused):self.runtime.observe(self.ref)
        self.runtime.release(dict(self.ref,controller_id=controller))

    def test_explicit_account_website_and_attempt_session_headers_remain_ticketed(self):
        account='https://accounts.google.com'
        self.c['destinations']['allowed_origins']=[dict(id='account',origin=account,
            roles=['navigation','resource','authentication'],session_headers='this_origin_session')]
        self.c['destinations']['request_rules']=[dict(id='account-read',destination_id='account',path_prefix='/',
            methods=['GET','HEAD'],query_keys=[],resource_types=['document','fetch','xhr','image'],effect='read',max_request_bytes=0)]
        # Synthetic HTTPS origin and session cookie; no Google DNS or socket.
        # Browser-service overrides never rewrite a page's accounts.google.com URL.
        self.launch(account+'/cookie-login')
        first,_=self.action('navigate')
        self.assertEqual(self.poll(first)['kind'],'done')
        self.assertTrue(Origin.received, self.diagnostics())
        self.assertEqual(Origin.received[0][1:3],('accounts.google.com','/cookie-login'))
        controller=str(uuid.uuid4())
        self.runtime.takeover(dict(self.ref,controller_id=controller,session_id=str(uuid.uuid4()),
            manual_auth=True,conn=None))
        with self.assertRaises(s.Refused):self.runtime.observe(self.ref)
        with self.assertRaises(s.Refused):self.runtime.view(self.ref)
        self.runtime.release(dict(self.ref,controller_id=controller))
        self.runtime.resume(self.ref)
        next_ordinal,_=self.action('navigate',lambda c:c['operation']['url']==account+'/cookie-read')
        self.assertEqual(self.poll(next_ordinal)['kind'],'done')
        observed=self.runtime.observe(self.ref)
        self.assertIn('Account session retained',observed['observation'])
        self.assertNotIn('attempt-private',json.dumps(observed))
        self.assertFalse(any(host!='accounts.google.com' for host,_ in self.upstream))
        self.assertTrue(all(ticket for method,_,ticket in self.browser_wire if method!='CONNECT'))


if __name__ == '__main__':
    unittest.main()
