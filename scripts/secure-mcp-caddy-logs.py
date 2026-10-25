#!/usr/bin/env python3
"""Retrofit standard installer Caddy logs. Refuse custom formats for local review.

Called by install/update before exposing the new backend. Does not print config
or requests. Existing file metadata is retained; validation/reload failure rolls
back both files. Callers must stop the upgrade on failure.
"""
import hashlib
import http.client
import http.server
import json
import os
import pathlib
import secrets
import socket
import tempfile
import threading
import time
import urllib.parse
import re
import subprocess
import sys

LEGACY_MARKER = '# ProxyPilot MCP credential redaction v1'
LEGACY_FORMAT = '''format filter {
            wrap json
            request>uri regexp "/api/mcp[^ ]*" "[redacted MCP URL]"
            request>headers>Referer delete
            request>headers>Authorization delete
            request>headers>Cookie delete
        }'''
MARKER = '# ProxyPilot MCP credential redaction v2'
# Two encoder layers: retain the existing MCP URL mask, then remove bearer
# query keys from every structured request URI (including HTTP error logs).
# Neither layer modifies the request Caddy forwards to the upstream.
FORMAT = '''format filter {
            wrap filter {
                wrap json
                request>uri query {
                    delete auth
                    delete rauth
                    delete login
                }
            }
            request>uri regexp "/api/mcp[^ ]*" "[redacted MCP URL]"
            request>headers>Referer delete
            request>headers>Authorization delete
            request>headers>Cookie delete
        }'''

def transform(text, global_config=False):
    if re.search(r'^\s*(?:log_credentials|debug)\b', text, re.M):
        raise ValueError('Custom/debug logging needs local credential-redaction review')
    if MARKER in text:
        if text.count(MARKER) != 1 or FORMAT not in text:
            raise ValueError('Modified v2 log filter needs local review')
        return text
    if LEGACY_MARKER in text:
        expected = LEGACY_MARKER + '\n        ' + LEGACY_FORMAT
        if text.count(LEGACY_MARKER) != 1 or expected not in text:
            raise ValueError('Modified v1 log filter needs local review')
        return text.replace(expected, MARKER + '\n        ' + FORMAT, 1)
    if re.search(r'^\s*(?:format|log_credentials|debug)\b', text, re.M):
        raise ValueError('Custom/debug logging needs local credential-redaction review')
    log = 'log {\n        ' + MARKER + '\n        ' + FORMAT + '\n'
    if global_config:
        if re.search(r'^\s*log\b', text, re.M):
            raise ValueError('Custom runtime logger needs local review')
        match = re.search(r'^\s*\{\s*$', text, re.M)
        if not match:
            raise ValueError('Global Caddy options block missing')
        return text[:match.end()] + '\n    ' + log + '    }\n' + text[match.end():]
    if len(re.findall(r'^\s*log\s*\{', text, re.M)) != 1:
        raise ValueError('Expected one standard dashboard access logger')
    return re.sub(r'log\s*\{\s*\n', lambda _: log, text, count=1)


# Mirrors siteAccessLogFilterLines(); fixed data, never caller-supplied config.
SERVICE_FORMAT = """format filter {
    wrap json
    request>uri query {
        delete auth
        delete rauth
        delete login
    }
    request>headers>Referer query {
        delete auth
        delete rauth
        delete login
    }
}"""
LIMIT = 8 * 1024 * 1024
COMMAND_TIMEOUT = 20



def query_encoder():
    return {'filter': 'query', 'actions': [
        {'type': 'delete', 'parameter': key} for key in ('auth', 'rauth', 'login')]}


SERVICE_ENCODER = {'format': 'filter', 'wrap': {'format': 'json'}, 'fields': {
    'request>uri': query_encoder(), 'request>headers>Referer': query_encoder()}}
GLOBAL_ENCODER = {'format': 'filter', 'wrap': {
    'format': 'filter', 'wrap': {'format': 'json'},
    'fields': {'request>uri': query_encoder()}}, 'fields': {
    'request>uri': {'filter': 'regexp', 'regexp': '/api/mcp[^ ]*', 'value': '[redacted MCP URL]'},
    **{'request>headers>' + key: {'filter': 'delete'}
       for key in ('Referer', 'Authorization', 'Cookie')}}}

def require(condition):
    if not condition:
        raise ValueError('Caddy credential log verification failed')


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def parse_json(data):
    require(len(data) <= LIMIT)
    result = json.loads(data)
    require(isinstance(result, dict))
    return result


def run_caddy(*args, capture=False):
    # Captures can contain configuration; they are only parsed in-process.
    with tempfile.TemporaryFile() as output:
        subprocess.run(['caddy', *args], check=True, stdout=output if capture else subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=COMMAND_TIMEOUT)
        if capture:
            output.seek(0)
            result = output.read(LIMIT + 1)
            require(len(result) <= LIMIT)
            return result


def adapt(path):
    return parse_json(run_caddy('adapt', '--config', str(path), capture=True))


def default_encoder(config):
    return config.get('logging', {}).get('logs', {}).get('default', {}).get('encoder')


def prove_config(config, expected_encoder):
    require(isinstance(expected_encoder, dict) and expected_encoder.get('format') == 'filter')
    require(default_encoder(config) == expected_encoder)
    logs = config.get('logging', {}).get('logs', {})
    require(logs and all(str(log.get('level', 'INFO')).upper() not in ('DEBUG', 'TRACE')
                         for log in logs.values()))
    default = logs['default']
    require(not default.get('include'))
    require(all(name == 'http.log.access' or name.startswith('http.log.access.')
                for name in default.get('exclude', [])))
    # Other named loggers may select access logs only; no parallel unfiltered
    # runtime/error sink is permitted to bypass the default encoder.
    for name, logger in logs.items():
        if name != 'default':
            include = logger.get('include', [])
            require(include and all(item.startswith('http.log.access.') for item in include))
    servers = config.get('apps', {}).get('http', {}).get('servers', {})
    require(all(not (server.get('logs') or {}).get('should_log_credentials', False)
                for server in servers.values()))
    return {'global_default_encoder': True, 'debug_disabled': True,
            'credential_headers_disabled': True}


def active_config(disk):
    # Do not follow redirects, proxy environment, arbitrary hosts or Unix paths.
    admin = disk.get('admin', {})
    require(not admin.get('disabled', False))
    listen = admin.get('listen', 'localhost:2019')
    host, sep, port = listen.rpartition(':')
    require(sep and host in ('localhost', '127.0.0.1', '[::1]') and port.isdigit())
    conn = http.client.HTTPConnection(host.strip('[]'), int(port), timeout=5)
    try:
        conn.request('GET', '/config/')
        response = conn.getresponse()
        require(response.status == 200)
        return parse_json(response.read(LIMIT + 1))
    finally:
        conn.close()


def read_records(path):
    if not path.exists():
        return []
    require(path.stat().st_size <= LIMIT)
    # Never drop malformed or partial lines silently.
    return [parse_json(line) for line in path.read_bytes().splitlines() if line.strip()]


def prove_records(records, sentinels, expected):
    for record in records:
        text = json.dumps(record, ensure_ascii=False)
        # Catch raw, escaped and percent-encoded marker values in ANY field.
        for _ in range(3):
            require(not any(marker in text for marker in sentinels))
            text = urllib.parse.unquote(text)
    access = [r for r in records if isinstance(r.get('request'), dict) and 'status' in r]
    for path, status, masked in expected:
        matches = [r for r in access if r.get('status') == status and
                   (r['request'].get('uri') == '[redacted MCP URL]' if masked else
                    urllib.parse.urlsplit(r['request'].get('uri', '')).path == path)]
        require(len(matches) == 1)
        if not masked:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(matches[0]['request']['uri']).query)
            require(query == {'keep': ['visible']})
    require(len(access) == len(expected))
    return len(access)


def reserve_port():
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    return sock


def stop_child(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)


def verify_fixture():
    """Only loopback listeners, synthetic data, own child, private temporary files."""
    with tempfile.TemporaryDirectory(prefix='pp-caddy-log-') as directory:
        root = pathlib.Path(directory)
        received = []
        class Upstream(http.server.BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(2)
            def do_GET(self):
                received.append(self.path)
                self.send_response(200)
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'OK')
            def log_message(self, *_args):
                pass
        upstream = http.server.HTTPServer(('127.0.0.1', 0), Upstream)
        upstream.timeout = 0.2
        done = threading.Event()
        def serve():
            while not done.is_set():
                upstream.handle_request()
        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        reserved = [reserve_port() for _ in range(3)]
        ports = [s.getsockname()[1] for s in reserved]
        runtime = root / 'runtime.json'
        access_paths = [root / 'global-access.json', root / 'service-access.json']
        config_path = root / 'Caddyfile'
        config = '{\n admin off\n auto_https off\n log {\n output file ' + str(runtime) + '\n' + FORMAT + '\n }\n}\n'
        for port, access, fmt in zip(ports[:2], access_paths, [FORMAT, SERVICE_FORMAT]):
            config += (f'http://127.0.0.1:{port} {{\n log {{\n output file {access}\n{fmt}\n }}\n'
                       f' handle /__pp_error {{\n reverse_proxy 127.0.0.1:{ports[2]}\n }}\n'
                       f' handle {{\n reverse_proxy 127.0.0.1:{upstream.server_port}\n }}\n}}\n')
        config_path.write_text(config)
        child = None
        try:
            reference = adapt(config_path)
            expected_encoder = default_encoder(reference)
            require(expected_encoder == GLOBAL_ENCODER)
            prove_config(reference, expected_encoder)
            # Validate installed modules before starting the isolated process.
            run_caddy('validate', '--config', str(config_path))
            for sock in reserved[:2]:
                sock.close()
            # The third socket stays bound but never listens: controlled refusal.
            with (root / 'process.log').open('wb') as process_log:
                child = subprocess.Popen(['caddy', 'run', '--config', str(config_path)],
                                         stdout=process_log, stderr=process_log,
                                         env={**os.environ, 'XDG_DATA_HOME': str(root / 'data'),
                                              'XDG_CONFIG_HOME': str(root / 'config')})
                deadline = time.monotonic() + 5
                while True:
                    require(child.poll() is None)
                    try:
                        with socket.create_connection(('127.0.0.1', ports[0]), timeout=0.2):
                            break
                    except OSError:
                        require(time.monotonic() < deadline)
                        time.sleep(0.05)
                nonce = secrets.token_hex(16)
                sentinels = [f'PP_{key}_{nonce}_{i}' for key in ('auth', 'rauth', 'login') for i in (1, 2)]
                parts = ['keep=visible']
                for key, encoded in [('auth', 'a%75th'), ('rauth', 'r%61uth'), ('login', 'lo%67in')]:
                    first, second = [s for s in sentinels if s.startswith('PP_' + key + '_')]
                    parts.extend([key + '=' + first, encoded + '=%50' + second[1:]])
                query = '&'.join(parts)
                expected_sets = []
                expected_upstream = []
                for index, port in enumerate(ports[:2]):
                    cases = [('/__pp_normal', 200, False), ('/__pp_error', 502, False)]
                    if index == 0:
                        cases.append(('/api/mcp/__pp_probe', 200, True))
                    expected_sets.append(cases)
                    for path, status, _masked in cases:
                        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                        try:
                            target = path + '?' + query
                            conn.request('GET', target, headers={'Referer': 'http://example.invalid/view?' + query})
                            response = conn.getresponse()
                            require(response.status == status)
                            response.read(1024)
                            if status == 200:
                                expected_upstream.append(target)
                        finally:
                            conn.close()
                stop_child(child)
            require(received == expected_upstream)
            counts = []
            all_records = read_records(runtime)
            for access, expected in zip(access_paths, expected_sets):
                records = read_records(access)
                counts.append(prove_records(records, sentinels, expected))
                if access == access_paths[1]:
                    for record in records:
                        if 'status' in record:
                            refs = record.get('request', {}).get('headers', {}).get('Referer')
                            require(isinstance(refs, list) and len(refs) == 1)
                            ref = urllib.parse.urlsplit(refs[0])
                            require(ref.path == '/view' and
                                    urllib.parse.parse_qs(ref.query) == {'keep': ['visible']})
                all_records.extend(records)
            # Require an actual global runtime error for each refused upstream.
            runtime_errors = [r for r in read_records(runtime) if r.get('level') == 'error'
                              and r.get('logger', '').startswith('http.log.error')]
            require(len(runtime_errors) == 2)
            for record in runtime_errors:
                uri = urllib.parse.urlsplit(record.get('request', {}).get('uri', ''))
                require(record.get('status') == 502 and uri.path == '/__pp_error' and
                        urllib.parse.parse_qs(uri.query) == {'keep': ['visible']})
            # process.log is not assumed JSON (Caddy CLI startup diagnostics).
            process_text = (root / 'process.log').read_text(errors='replace')
            require(not any(marker in urllib.parse.unquote(process_text) for marker in sentinels))
            for record in all_records:
                text = json.dumps(record)
                for _ in range(3):
                    require(not any(marker in text for marker in sentinels))
                    text = urllib.parse.unquote(text)
            return expected_encoder, {'fixture_verified': True, 'requests': sum(counts),
                'runtime_errors': 2, 'fixture_all_fields_redacted': True, 'upstream_query_unchanged': True,
                'path_status_keep_preserved': True, 'mcp_mask_preserved': True,
                'service_referer_redacted': True}
        finally:
            if child is not None:
                stop_child(child)
            for sock in reserved:
                sock.close()
            done.set()
            worker.join(timeout=2)
            upstream.server_close()


def verify(config_path, no_reload=False):
    encoder, fixture = verify_fixture()
    disk = adapt(config_path)
    proof = prove_config(disk, encoder)
    version, version_digest = safe_version()
    receipt = {'type': 'proxypilot.caddy-log-verification', 'version': 1,
               'caddy_version': version,
               'caddy_version_sha256': version_digest,
               'disk_config_sha256': canonical_hash(disk), **proof, **fixture}
    if no_reload:
        receipt.update(active_global_verified=False, result='pending_reload')
    else:
        active = active_config(disk)
        prove_config(active, encoder)
        require(default_encoder(disk) == default_encoder(active))
        require(disk['logging']['logs']['default'].get('level', 'INFO') ==
                active['logging']['logs']['default'].get('level', 'INFO'))
        receipt.update(active_global_verified=True, active_config_sha256=canonical_hash(active),
                       default_logger_matches_disk=True, result='verified')
    return receipt



def safe_version():
    raw = run_caddy('version', capture=True)
    token = raw.decode('utf-8', errors='replace').split()[0] if raw.split() else 'unknown'
    value = token if re.fullmatch(r'(?:v[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+_-]{0,80}|\(devel\))', token) else 'custom'
    return value, hashlib.sha256(raw).hexdigest()


def valid_domain(domain):
    return (isinstance(domain, str) and len(domain) <= 253 and domain == domain.lower()
            and bool(re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', domain)))


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def matches_host(pattern, domain):
    pattern = pattern.lower()
    return pattern == domain or (pattern.startswith('*.') and
           domain.endswith(pattern[1:]) and len(domain.split('.')) == len(pattern.split('.')))



def route_could_match(route, domain):
    # Match groups are ORed; a group without a host constraint can accept this
    # Host. Do not miss catch-all servers merely because no domain is written.
    groups = route.get('match', [])
    return not groups or any('host' not in group or
        any(matches_host(host, domain) for host in group['host']) for group in groups)

def logger_selects(logger, topic):
    def specificity(names):
        return max((len(name) for name in names if topic == name or topic.startswith(name + '.')), default=-1)
    include, exclude = logger.get('include', []), logger.get('exclude', [])
    included, excluded = specificity(include), specificity(exclude)
    if include and included < 0:
        return False
    return excluded < 0 or (include and included > excluded)


def prove_domain(config, domain):
    require(valid_domain(domain))
    prove_config(config, GLOBAL_ENCODER)
    logs = config['logging']['logs']
    names = set()
    bound_servers = 0
    for server in config.get('apps', {}).get('http', {}).get('servers', {}).values():
        settings = server.get('logs') or {}
        mappings = settings.get('logger_names', {})
        route_nodes = list(walk(server.get('routes', []))) + list(walk(server.get('errors', {})))
        route_match = any(route_could_match(route, domain) for route in server.get('routes', []))
        if not any(matches_host(host, domain) for host in mappings) and not route_match:
            continue
        # Caddy disables access logging when Server.Logs is absent/null;
        # an explicit empty object enables default logging and must be checked.
        if server.get('logs') is None:
            continue
        bound_servers += 1
        require(settings)
        require(not any(matches_host(host, domain) for host in settings.get('skip_hosts', [])))
        # Managed routes never override logging or append unfiltered URI copies.
        require(all(not str(node.get('handler', '')).startswith('log_') and
                    node.get('handler') != 'invoke' for node in route_nodes))
        require(all(not any('log' in key.lower() for key in node.get('vars', {})) for node in route_nodes))
        require(all(node.get('handler') != 'vars' or not any('log' in key.lower() for key in node if key != 'handler')
                    for node in route_nodes))
        selected = mappings.get(domain)
        if selected is None:
            wildcards = [value for host, value in mappings.items() if matches_host(host, domain)]
            require(len(wildcards) <= 1)
            if wildcards:
                selected = wildcards[0]
            else:
                require(not settings.get('skip_unmapped_hosts', False))
                selected = settings.get('default_logger_name')
        if isinstance(selected, str):
            selected = [selected]
        require(isinstance(selected, list) and selected and len(selected) <= 16)
        for name in selected:
            require(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', name))
            topic = 'http.log.access.' + name
            sinks = [(sink_name, logger) for sink_name, logger in logs.items() if logger_selects(logger, topic)]
            require(sinks)
            for sink_name, logger in sinks:
                # Default global redaction deletes Referer, so is safe as an
                # additional sink but cannot substitute for the service filter.
                require(logger.get('encoder') in (SERVICE_ENCODER, GLOBAL_ENCODER))
            require(any(logger.get('encoder') == SERVICE_ENCODER and
                        logger.get('writer', {}).get('output') == 'file' and
                        logger.get('writer', {}).get('filename') == '/var/log/caddy/' + domain + '.log'
                        for _, logger in sinks))
            names.add(name)
    require(bound_servers > 0 and names and len(names) <= 16)
    return sorted(names)


def active_proof(domain):
    """Read only: no config files, fixture process, mutation, or request to a service."""
    require(valid_domain(domain))
    config = active_config({'admin': {'listen': '127.0.0.1:2019'}})
    names = prove_domain(config, domain)
    version, _digest = safe_version()
    require(len(version) <= 64 and re.fullmatch(r'v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', version))
    return {'schema': 1, 'scope': 'active-global-and-domain', 'domain': domain,
            'verified': True, 'activeConfigSha256': canonical_hash(config), 'caddyVersion': version,
            'global': {'present': True, 'credentialRedaction': True, 'loggerNames': ['default']},
            'service': {'present': True, 'credentialRedaction': True, 'loggerNames': names}}


def active_proof_cli(args):
    domain = args[0] if len(args) == 1 and valid_domain(args[0]) else ''
    try:
        require(domain)
        receipt = active_proof(domain)
        code = 0
    except Exception:
        receipt = {'schema': 1, 'scope': 'active-global-and-domain', 'domain': domain,
                   'verified': False, 'code': 'verification_failed'}
        code = 1
    print(json.dumps(receipt, sort_keys=True, separators=(',', ':')), flush=True)
    return code

def main():
    root = pathlib.Path('/etc/caddy')
    sites = [p for p in (root / 'sites').iterdir() if p.is_file() and not p.is_symlink()
             and '# ProxyPilot Admin Dashboard' in p.read_text()]
    if len(sites) != 1:
        raise ValueError('Expected one installer-owned dashboard site; review locally')
    paths = [root / 'Caddyfile', sites[0]]
    if any(p.is_symlink() for p in paths):
        raise ValueError('Refusing symlink Caddy configuration')
    originals = [p.read_text() for p in paths]
    changed = [transform(originals[0], True), transform(originals[1])]
    no_reload = '--no-reload' in sys.argv
    reloaded = False
    try:
        if changed != originals:
            for p, data in zip(paths, changed):
                p.write_text(data)
            for command in (['adapt'] if no_reload else ['validate', 'reload']):
                reloaded = reloaded or command == 'reload'
                run_caddy(command, '--config', str(paths[0]))
        receipt = verify(paths[0], no_reload)
        print(json.dumps(receipt, sort_keys=True, separators=(',', ':')), flush=True)
    except BaseException:
        for p, data in zip(paths, originals):
            p.write_text(data)
        # Restore the live config too if this invocation already reloaded it.
        # Failure is propagated; the caller must never continue this update.
        if reloaded:
            run_caddy('reload', '--config', str(paths[0]))
        raise

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--active-proof':
        sys.exit(active_proof_cli(sys.argv[2:]))
    try:
        main()
    except Exception:
        print(json.dumps({'type': 'proxypilot.caddy-log-verification', 'version': 1,
                          'result': 'failed', 'active_global_verified': False}), flush=True)
        print('MCP log hardening or verification failed; review Caddy logging locally before continuing.', file=sys.stderr)
        sys.exit(1)
