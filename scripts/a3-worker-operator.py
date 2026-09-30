#!/usr/bin/env python3
"""Root operator client for the A3 worker supervisor, with human view/control.

Talks only to /run/proxypilot-a3/operator.sock. The `human` subcommand serves
one small page on loopback (default 127.0.0.1:18090, reach it with an SSH
local forward). The page shows the worker's screenshot, and after an explicit
Take over, which fences the model's attempt first, it sends typed clicks,
fixed keys and bounded text through the same supervisor path. There is no
DevTools endpoint, no URL bar and no script input. Every browser request
still passes the in-browser origin policy, the host proxy and the fence.
"""
import argparse
import base64
import http.server
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

OPERATOR_SOCKET = Path('/run/proxypilot-a3/operator.sock')
BACKEND_SOCKET = Path('/run/proxypilot-a3-backend/supervisor.sock')
PUBLIC_KEY = Path('/etc/proxypilot-a3-proof/supervisor-pub.pem')


class CallFailed(Exception):
    def __init__(self, reply):
        super().__init__(reply.get('error'))
        self.reply = reply
        self.code = reply.get('error')


def call(method, params=None, path=OPERATOR_SOCKET, timeout=180):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(timeout)
        client.connect(str(path))
        client.sendall((json.dumps({'method': method, 'params': params or {}}) + '\n').encode())
        line = client.makefile().readline()
    if not line:
        raise CallFailed({'error': 'CONNECTION_CLOSED'})
    reply = json.loads(line)
    if not reply.get('ok'):
        raise CallFailed(reply)
    return reply['result']


def decode(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def verify_receipt(receipt, public_key=PUBLIC_KEY):
    """Independent check of a supervisor receipt with the host public key."""
    prefix, body, signature = receipt['attestation'].split('.')
    if prefix != 'a3r1':
        return False, None
    payload = json.loads(decode(body))
    with tempfile.TemporaryDirectory(prefix='pp-a3-verify-') as temp:
        message, sig = Path(temp) / 'm', Path(temp) / 's'
        message.write_bytes(decode(body))
        sig.write_bytes(decode(signature))
        result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(public_key), '-rawin',
                                 '-in', str(message), '-sigfile', str(sig)], capture_output=True, timeout=20)
    matches = all(payload.get(k) == receipt.get(k) for k in ('run_id', 'attempt_id', 'fence', 'descendants_gone',
                                                             'workspace_removed'))
    return result.returncode == 0 and matches, payload


PAGE = '''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>A3 human control</title>
<style>
:root{color-scheme:light dark;--bg:#0f172a;--fg:#e2e8f0;--muted:#94a3b8;--accent:#22c55e}
body{margin:0;font:15px system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:1320px;margin:0 auto;padding:12px 16px}
header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
button,input{font:inherit;min-height:44px;min-width:44px;border-radius:8px;border:1px solid #334155;
background:#1e293b;color:var(--fg);padding:0 12px}
button.primary{background:var(--accent);color:#052e16;border-color:var(--accent)}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
img{width:100%;height:auto;border:1px solid #334155;border-radius:8px;cursor:crosshair;display:block}
#state{color:var(--muted)}
</style></head><body><main>
<header><strong>A3 human view and control</strong><span id="state">view only</span></header>
<p id="note">Page content is untrusted. Take over fences the agent's attempt first; the agent cannot resume it.</p>
<div class="row"><button class="primary" id="take">Take over</button><button id="stop">Stop and tear down</button></div>
<img id="frame" alt="Worker browser screenshot">
<div class="row">
<button data-key="Tab">Tab</button><button data-key="Enter">Enter</button><button data-key="Escape">Esc</button>
<button data-key="Backspace">Backspace</button><button data-key="ArrowUp">Up</button>
<button data-key="ArrowDown">Down</button><button data-key="ArrowLeft">Left</button><button data-key="ArrowRight">Right</button>
<button data-scroll="400">Scroll down</button><button data-scroll="-400">Scroll up</button>
</div>
<form class="row" id="typing"><input id="text" maxlength="256" autocomplete="off" placeholder="Text to type (max 256)">
<button>Type</button></form>
</main><script>
const base = location.pathname.replace(/\\/$/, '');
const state = document.getElementById('state');
let human = false;
async function post(path, body) {
  const r = await fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body || {})});
  const data = await r.json();
  state.textContent = data.ok ? (human ? 'human control' : 'view only') : ('refused: ' + data.error);
  return data;
}
async function refresh() {
  const r = await fetch(base + '/frame', {cache: 'no-store'});
  const data = await r.json();
  if (data.ok) document.getElementById('frame').src = 'data:image/png;base64,' + data.result.png_base64;
  else state.textContent = 'refused: ' + data.error;
}
document.getElementById('take').onclick = async () => { const d = await post('/takeover'); if (d.ok) { human = true; state.textContent = 'human control'; } };
document.getElementById('stop').onclick = () => post('/stop');
document.getElementById('frame').onclick = e => {
  if (!human) { state.textContent = 'Take over before sending input'; return; }
  const img = e.target, rect = img.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) * img.naturalWidth / rect.width);
  const y = Math.round((e.clientY - rect.top) * img.naturalHeight / rect.height);
  post('/input', {kind: 'click', x, y}).then(refresh);
};
document.querySelectorAll('[data-key]').forEach(b => b.onclick = () => post('/input', {kind: 'key', key: b.dataset.key}).then(refresh));
document.querySelectorAll('[data-scroll]').forEach(b => b.onclick = () => post('/input', {kind: 'scroll', x: 640, y: 400, dy: Number(b.dataset.scroll)}).then(refresh));
document.getElementById('typing').onsubmit = e => { e.preventDefault(); const t = document.getElementById('text');
  if (t.value) post('/input', {kind: 'text', text: t.value}).then(() => { t.value = ''; refresh(); }); };
refresh(); setInterval(refresh, 1500);
</script></body></html>'''


def human_server(ref, listen, token, caller=call):

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def allowed(self):
            # Loopback Host only (no DNS rebinding) and the per-run token in the path.
            parts = urlsplit(self.path)
            bound = self.server.server_address[1]
            return (self.headers.get('Host') in ('127.0.0.1:%d' % bound, 'localhost:%d' % bound)
                    and (parts.path == '/' + token or parts.path.startswith('/' + token + '/'))
                    and not parts.query)

        def reply(self, status, body, kind='application/json'):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy',
                             "default-src 'none'; img-src data:; style-src 'unsafe-inline'; "
                             "script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'")
            self.send_header('X-Frame-Options', 'DENY')
            self.end_headers()
            self.wfile.write(data)

        def relay(self, method, params):
            try:
                return {'ok': True, 'result': caller(method, params)}
            except CallFailed as error:
                return {'ok': False, 'error': error.code}
            except OSError:
                return {'ok': False, 'error': 'SUPERVISOR_UNREACHABLE'}

        def do_GET(self):  # noqa: N802
            if not self.allowed():
                return self.reply(404, {'ok': False})
            suffix = urlsplit(self.path).path[len(token) + 1:]
            if suffix in ('', '/'):
                return self.reply(200, PAGE.encode(), 'text/html; charset=utf-8')
            if suffix == '/frame':
                return self.reply(200, self.relay('view', dict(ref)))
            return self.reply(404, {'ok': False})

        def do_POST(self):  # noqa: N802
            if not self.allowed() or self.headers.get('Content-Type') != 'application/json':
                return self.reply(404, {'ok': False})
            length = int(self.headers.get('Content-Length') or 0)
            if length > 4096:
                return self.reply(413, {'ok': False})
            try:
                body = json.loads(self.rfile.read(length) or b'{}')
            except ValueError:
                return self.reply(400, {'ok': False})
            suffix = urlsplit(self.path).path[len(token) + 1:]
            if suffix == '/takeover':
                return self.reply(200, self.relay('takeover', dict(ref)))
            if suffix == '/stop':
                return self.reply(200, self.relay('stop', dict(ref, reason='taken_over')))
            if suffix == '/input':
                return self.reply(200, self.relay('input', dict(ref, input=body)))
            return self.reply(404, {'ok': False})

    return http.server.ThreadingHTTPServer(listen, Handler)


def parse_listen(value):
    host, _, port = value.rpartition(':')
    if host not in ('127.0.0.1', 'localhost') or not port.isdigit():
        raise argparse.ArgumentTypeError('Listen on loopback only, e.g. 127.0.0.1:18090')
    return ('127.0.0.1', int(port))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    journal = sub.add_parser('journal')
    journal.add_argument('attempt_id')
    for name in ('stop', 'view', 'human', 'takeover'):
        command = sub.add_parser(name)
        command.add_argument('run_id')
        command.add_argument('attempt_id')
        command.add_argument('fence', type=int)
        if name == 'stop':
            command.add_argument('--reason', default='cancelled',
                                 choices=('cancelled', 'blocked', 'failed', 'taken_over', 'proof'))
        if name == 'view':
            command.add_argument('--out', type=Path, required=True)
        if name == 'human':
            command.add_argument('--listen', type=parse_listen, default=('127.0.0.1', 18090))
    verify = sub.add_parser('verify-receipt')
    verify.add_argument('receipt_json')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run in the host root terminal')
    if args.command == 'status':
        print(json.dumps(call('status'), indent=2))
    elif args.command == 'journal':
        print(json.dumps(call('journal', {'attempt_id': args.attempt_id}), indent=2))
    elif args.command == 'verify-receipt':
        valid, payload = verify_receipt(json.loads(args.receipt_json))
        print(json.dumps({'valid': valid, 'payload': payload}, indent=2))
        sys.exit(0 if valid else 1)
    else:
        ref = {'run_id': args.run_id, 'attempt_id': args.attempt_id, 'fence': args.fence}
        if args.command == 'stop':
            receipt = call('stop', dict(ref, reason=args.reason))['receipt']
            print(json.dumps({'receipt': receipt, 'verified': verify_receipt(receipt)[0]}, indent=2))
        elif args.command == 'takeover':
            print(json.dumps(call('takeover', ref), indent=2))
        elif args.command == 'view':
            view = call('view', ref)
            args.out.write_bytes(base64.b64decode(view['png_base64']))
            os.chmod(args.out, 0o600)
            print(json.dumps({'saved': str(args.out), 'width': view['width'], 'height': view['height']}))
        else:
            token = secrets.token_urlsafe(24)
            server = human_server(ref, args.listen, token)
            print('Human control page (keep this terminal open; Ctrl-C ends the page, not the attempt):')
            print('  ssh -L %d:127.0.0.1:%d <host>   then open  http://127.0.0.1:%d/%s/'
                  % (args.listen[1], args.listen[1], args.listen[1], token), flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                server.server_close()


if __name__ == '__main__':
    try:
        main()
    except CallFailed as error:
        print('A3 operator call refused: %s %s' % (error.code, error.reply.get('detail') or ''), file=sys.stderr)
        sys.exit(1)
    except OSError as error:
        print('A3 operator call failed: %s' % error, file=sys.stderr)
        sys.exit(1)
