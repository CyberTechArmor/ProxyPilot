"""All-request host gateway. No CONNECT passthrough, DNS fallback or retries.

The installed supervisor controls this module through a root-only Unix socket.
The isolated browser supplies only opaque single-use tickets; page headers cannot
mint role, effect approval, network scope, or an attempt identity. No executable
code, request body, cookie or credential belongs in control events/ledger rows.
"""
import hashlib
import http.client
import importlib.util
import ipaddress
import os
from pathlib import Path
import re
import secrets
import socket
import socketserver
import ssl
import stat
import struct
import subprocess
import sys
import threading
import time
from urllib.parse import urljoin

# Import the exact reviewed sibling even when the supervisor uses importlib or
# Python -I. No checkout/cwd/PYTHONPATH fallback is used for host policy code.
_policy_path = Path(__file__).with_name('selected_browser_policy.py')
_policy = sys.modules.get('selected_browser_policy')
if _policy is None or Path(_policy.__file__).resolve() != _policy_path.resolve():
    _spec = importlib.util.spec_from_file_location('pp_selected_gateway_policy', _policy_path)
    _policy = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_policy)
for _name in ('Denied', 'GatewayPolicy', 'HEX', 'METHODS', 'RESOURCE_TYPES', 'UUID', 'canonical',
              'digest', 'exact', 'safe_int', 'strict_json', 'url_parts'):
    globals()[_name] = getattr(_policy, _name)

TICKET_HEADER = 'x-proxypilot-request-token'
MAX_HEADER_BYTES = 32768
MAX_BODY_BYTES = 67108864
MAX_CONTROL_BYTES = 524288
HOP = frozenset(('connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
                 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization'))
SESSION = frozenset(('cookie', 'authorization', 'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token'))
RESOURCE_HEADERS = frozenset(('accept', 'accept-language', 'user-agent', 'cache-control', 'pragma',
                              'if-none-match', 'if-modified-since', 'range', 'content-type'))
ACTION_KEYS = ('ordinal', 'candidate_ref', 'snapshot_ref', 'approval_ref')
LOADED_HELPER_HASHES = dict(selected_browser_gateway=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                           selected_browser_policy=hashlib.sha256(_policy_path.read_bytes()).hexdigest())


class MemoryLedger:
    """Test/in-process ledger. Installed control server always uses FileLedger."""
    def __init__(self):
        self.rows = []
        self.lock = threading.RLock()
        self._approvals = set()

    def append(self, kind, data):
        with self.lock:
            previous = self.rows[-1]['sha256'] if self.rows else '0' * 64
            row = dict(sequence=len(self.rows) + 1, previous_sha256=previous, kind=kind, data=data)
            row['sha256'] = digest(canonical(row))
            self._write(row)
            self.rows.append(row)
            return row['sha256']

    def _write(self, row):
        pass

    def consume(self, approval_id, binding_sha256):
        with self.lock:
            if approval_id in self._approvals:
                raise Denied('APPROVAL_ALREADY_CONSUMED')
            self.append('approval_consumed', dict(approval_id=approval_id, binding_sha256=binding_sha256))
            self._approvals.add(approval_id)

    @property
    def sha256(self):
        return self.rows[-1]['sha256'] if self.rows else '0' * 64


class FileLedger(MemoryLedger):
    def __init__(self, path, require_root=True):
        super().__init__()
        self.path = Path(path)
        fd = os.open(self.path, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            s = os.fstat(fd)
            if (not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_mode & 0o077 or
                    (require_root and s.st_uid != 0) or s.st_size > 64 * 1024 * 1024):
                raise Denied('LEDGER_UNSAFE')
            with os.fdopen(os.dup(fd), 'r', encoding='utf-8') as stream:
                for line in stream:
                    if not line.endswith('\n'):
                        raise Denied('LEDGER_INCOMPLETE')
                    row = strict_json(line)
                    if not exact(row, ('sequence', 'previous_sha256', 'kind', 'data', 'sha256')):
                        raise Denied('LEDGER_INVALID')
                    claimed = row['sha256']
                    unsigned = {k: v for k, v in row.items() if k != 'sha256'}
                    if (row['sequence'] != len(self.rows) + 1 or row['previous_sha256'] != self.sha256 or
                            claimed != digest(canonical(unsigned))):
                        raise Denied('LEDGER_INVALID')
                    self.rows.append(row)
                    if row['kind'] == 'approval_consumed':
                        self._approvals.add(row['data']['approval_id'])
            self.fd = fd
        except Exception:
            os.close(fd)
            raise

    def _write(self, row):
        raw = (canonical(row) + '\n').encode()
        written = os.write(self.fd, raw)
        if written != len(raw):
            raise Denied('LEDGER_WRITE_FAILED')
        os.fsync(self.fd)

    def close(self):
        os.close(self.fd)


def validate_request_metadata(value, policy):
    fields = ('url', 'method', 'body_sha256', 'body_bytes', 'resource_type', 'role',
              'run_id', 'attempt_id', 'fence', 'policy_sha256', 'current_action')
    if not exact(value, fields):
        raise Denied('REQUEST_METADATA_INVALID')
    if any(value[k] != policy.identity[k] for k in ('run_id', 'attempt_id', 'fence', 'policy_sha256')):
        raise Denied('REQUEST_IDENTITY_MISMATCH')
    if (value['method'] not in METHODS or value['resource_type'] not in RESOURCE_TYPES or
            value['role'] not in ('navigation', 'resource', 'authentication') or
            (value['role'] == 'navigation' and value['resource_type'] != 'document') or
            (value['role'] == 'authentication' and value['resource_type'] not in ('document', 'xhr', 'fetch')) or
            (value['resource_type'] == 'document' and value['role'] == 'resource') or
            not isinstance(value['body_sha256'], str) or not HEX.fullmatch(value['body_sha256']) or
            not safe_int(value['body_bytes'], 0, MAX_BODY_BYTES) or
            (value['body_bytes'] == 0 and value['body_sha256'] != digest(b'')) or
            (value['method'] in ('GET', 'HEAD') and value['body_bytes'] != 0)):
        raise Denied('REQUEST_METADATA_INVALID')
    action = value['current_action']
    if action is not None:
        def pin(v):
            return (exact(v, ('id', 'sha256')) and isinstance(v['id'], str) and UUID.fullmatch(v['id']) and
                    isinstance(v['sha256'], str) and HEX.fullmatch(v['sha256']))
        if (not exact(action, ACTION_KEYS) or not safe_int(action['ordinal'], 1, 2147483647) or
                not pin(action['candidate_ref']) or not pin(action['snapshot_ref']) or
                (action['approval_ref'] is not None and not pin(action['approval_ref']))):
            raise Denied('REQUEST_ACTION_INVALID')
    p = url_parts(value['url'])
    if value['url'] != p['url']:
        raise Denied('REQUEST_URL_NONCANONICAL')
    return strict_json(canonical(value)), p


class PinnedConnection(http.client.HTTPConnection):
    def __init__(self, parts, address, timeout):
        super().__init__(parts['host'], parts['port'], timeout=timeout)
        self.parts, self.address = parts, address

    def connect(self):
        # The selected numerical address is used by the actual socket. There is
        # no second DNS lookup, proxy environment, tunnel, or certificate bypass.
        sock = socket.create_connection((self.address, self.parts['port']), timeout=self.timeout)
        if self.parts['scheme'] == 'https':
            try:
                context = ssl.create_default_context()
                context.minimum_version = ssl.TLSVersion.TLSv1_2
                context.set_alpn_protocols(['http/1.1'])
                sock = context.wrap_socket(sock, server_hostname=self.parts['host'])
            except Exception:
                sock.close()
                raise
        self.sock = sock


_dns_slots = threading.BoundedSemaphore(4)


def resolve_host(parts):
    try:
        return [str(ipaddress.ip_address(parts['host']))]
    except ValueError:
        # libc lookup has no portable timeout. A bounded daemon pool prevents
        # hung lookups from hanging cancellation or exhausting threads.
        if not _dns_slots.acquire(blocking=False):
            raise Denied('DNS_LOOKUP_CAPACITY')
        done, outcome = threading.Event(), {}
        def lookup():
            try:
                outcome['addresses'] = sorted({s[4][0] for s in socket.getaddrinfo(parts['host'], parts['port'], type=socket.SOCK_STREAM)})
            except Exception:
                outcome['error'] = True
            finally:
                _dns_slots.release()
                done.set()
        threading.Thread(target=lookup, daemon=True, name='selected-dns').start()
        if not done.wait(5):
            raise Denied('DNS_LOOKUP_TIMEOUT')
        answers = outcome.get('addresses')
        if not answers or len(answers) > 16:
            raise Denied('DNS_LOOKUP_UNVERIFIED')
        return answers


def route_hash(addresses):
    routes = []
    deadline = time.monotonic() + 5
    for address in sorted(set(addresses)):
        ipaddress.ip_address(address)
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Denied('NETWORK_ROUTE_UNVERIFIED')
            out = subprocess.run(['ip', '-j', 'route', 'get', address], stdin=subprocess.DEVNULL,
                                 capture_output=True, timeout=remaining, check=True)
            value = strict_json(out.stdout.decode())
        except Exception:
            raise Denied('NETWORK_ROUTE_UNVERIFIED') from None
        if not isinstance(value, list) or len(value) != 1 or value[0].get('type', 'unicast') != 'unicast':
            raise Denied('NETWORK_ROUTE_UNVERIFIED')
        routes.append(dict(address=address, route={k:value[0][k] for k in
            ('dst', 'gateway', 'dev', 'prefsrc', 'src', 'table') if k in value[0]}))
    return digest(canonical(routes))


class AttemptGateway:
    def __init__(self, policy, ledger, resolver=resolve_host, connection_factory=PinnedConnection,
                 clock=time.time, ticket_seconds=15, route_reader=route_hash):
        self.policy, self.ledger, self.resolver = policy, ledger, resolver
        self.connection_factory, self.clock = connection_factory, clock
        self.route_reader = route_reader
        self.ticket_seconds = ticket_seconds
        self.lock = threading.RLock()
        self.started_at = clock()
        self.state, self.reason = 'running', None
        self.requests = self.response_bytes = 0
        self.effects_sent = self.effects_uncertain = self.inflight = 0
        self.pending, self.tickets = {}, {}
        self.additions, self.extra_targets, self.purposes = {}, {}, {}
        self.connections = set()
        self.ledger.append('attempt_registered', dict(identity=policy.identity, policy_sha256=policy.identity['policy_sha256'],
                                                      network_plan_sha256=policy.network_plan_sha256))

    def _audit(self, kind, data):
        try:
            self.ledger.append(kind, data)
        except Exception:
            self.state, self.reason = 'revoked', 'LEDGER_WRITE_FAILED'
            self.tickets.clear()
            raise Denied('LEDGER_WRITE_FAILED')

    def _check(self, allow_paused=False):
        if self.state == 'revoked':
            raise Denied('GATEWAY_REVOKED')
        self.policy.check_fresh()
        if self.clock() >= self.started_at + self.policy.configuration['budgets']['max_seconds']:
            self.state, self.reason = 'revoked', 'TIME_BUDGET_EXHAUSTED'
            self.tickets.clear()
            raise Denied(self.reason)
        if self.state != 'running' and not allow_paused:
            raise Denied('GATEWAY_PAUSED')

    def _freeze(self, code, origin=None, request_ref=None):
        if self.state == 'revoked':
            return
        self.state, self.reason = 'paused', code
        for ticket in self.tickets.values():
            self.pending.pop(ticket['request_ref'], None)
        self.tickets.clear()
        self._audit('escalation', dict(code=code, origin=origin, request_ref=request_ref))

    def check_connect(self, authority):
        # CONNECT only creates local intercepted TLS. Unknown hosts are denied
        # before target DNS, target socket or any upstream request byte.
        try:
            # CONNECT always names an explicit port, canonical HTTP origins omit
            # the default port. Normalize only this required CONNECT syntax.
            origin_authority = authority[:-4] if authority.endswith(':443') else authority
            p = url_parts('https://' + origin_authority)
            expected = ('[' + p['host'] + ']' if ':' in p['host'] else p['host']) + ':' + str(p['port'])
            if authority != expected:
                raise Denied('CONNECT_INVALID')
            with self.lock:
                self._check()
                self.policy.protected_url(p)
                if p['origin'] not in self.policy.origins and p['origin'] not in self.additions:
                    raise Denied('OFF_LIST_DESTINATION')
            return p
        except Denied as e:
            with self.lock:
                self._freeze(e.code)
            raise

    def review_request(self, request_ref, metadata):
        if not isinstance(request_ref, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', request_ref):
            raise Denied('REQUEST_REF_INVALID')
        with self.lock:
            self._check(allow_paused=True)
            if request_ref in self.pending:
                raise Denied('REQUEST_REF_REUSED')
            try:
                meta, parts = validate_request_metadata(metadata, self.policy)
                dest = self.policy.destination(parts, meta['role'], self.additions)
                temporary = self.purposes.get((parts['origin'], meta['role']))
                if temporary and temporary['expires_at'] <= self.clock():
                    raise Denied('DESTINATION_GRANT_EXPIRED')
                # CONNECT preconnect may have frozen an unknown origin before
                # the CDP event arrives. Classify that exact event first so the
                # supervisor can escalate it without DNS; paused known origins
                # still receive no ticket or new upstream authority.
                self._check()
                effect = self.policy.classify(parts, dest, meta['method'], meta['resource_type'], meta['body_bytes'])
                binding = digest(canonical(dict(identity=self.policy.identity, request_ref=request_ref, metadata=meta,
                                                network_plan_sha256=self.policy.network_plan_sha256,
                                                destination_grant=temporary)))
                record = dict(metadata=meta, parts=parts, destination=dest, effect=effect, binding_sha256=binding,
                              expires_at=min(self.started_at + self.policy.configuration['budgets']['max_seconds'],
                                             self.policy.expires_at))
                self.pending[request_ref] = record
                if effect != 'read':
                    self._freeze('EXTERNAL_CHANGE_APPROVAL_REQUIRED' if effect == 'external_change'
                                 else 'UNCLASSIFIED_REQUEST_APPROVAL_REQUIRED', parts['origin'], request_ref)
                    return dict(decision='approval_required', code=self.reason, request_ref=request_ref,
                                binding_sha256=binding, origin=parts['origin'], method=meta['method'],
                                body_sha256=meta['body_sha256'], body_bytes=meta['body_bytes'])
                return self._ticket(request_ref, record)
            except Denied as e:
                self._freeze(e.code, request_ref=request_ref)
                raise

    def _ticket(self, request_ref, record):
        token = secrets.token_hex(32)
        self.tickets[token] = dict(record, request_ref=request_ref,
                                  expires_at=min(record['expires_at'], self.clock() + self.ticket_seconds))
        return dict(decision='allow', request_ref=request_ref, ticket=token,
                    binding_sha256=record['binding_sha256'])

    def approve_request(self, request_ref, grant):
        with self.lock:
            self._check(allow_paused=True)
            record = self.pending.get(request_ref)
            if not record or record.get('approval_id') or record['effect'] == 'read' or record['expires_at'] <= self.clock():
                raise Denied('REQUEST_APPROVAL_STALE')
            if (not exact(grant, ('schema', 'id', 'identity', 'request_ref', 'binding_sha256', 'expires_at', 'purpose_sha256')) or
                    grant['schema'] != 'proxypilot.selected-browser.effect-grant.v1' or
                    not isinstance(grant['id'], str) or not UUID.fullmatch(grant['id']) or
                    grant['identity'] != self.policy.identity or grant['request_ref'] != request_ref or
                    grant['binding_sha256'] != record['binding_sha256'] or
                    not safe_int(grant['expires_at'], 1, 2**53 - 1) or grant['expires_at'] <= self.clock() or
                    grant['expires_at'] > self.clock() + 30 or
                    not isinstance(grant['purpose_sha256'], str) or not HEX.fullmatch(grant['purpose_sha256'])):
                raise Denied('EFFECT_GRANT_INVALID')
            # Approval is reserved durably BEFORE a ticket can be returned; a
            # lost reply consumes authority rather than enabling a replay.
            try:
                self.ledger.consume(grant['id'], record['binding_sha256'])
            except Denied as e:
                if e.code != 'APPROVAL_ALREADY_CONSUMED':
                    self.state, self.reason = 'revoked', 'LEDGER_WRITE_FAILED'
                    self.tickets.clear()
                raise
            except Exception as e:
                self.state, self.reason = 'revoked', 'LEDGER_WRITE_FAILED'
                raise Denied('LEDGER_WRITE_FAILED') from e
            record['approval_id'] = grant['id']
            record['expires_at'] = min(record['expires_at'], grant['expires_at'])
            self.state, self.reason = 'running', None
            return self._ticket(request_ref, record)

    def grant_destination(self, grant, destination, target):
        with self.lock:
            self._check(allow_paused=True)
            item = self.policy.validate_destination(destination)
            t = self.policy.validate_target(target)
            base = self.policy.origins.get(item['origin'])
            existing = self.additions.get(item['origin'], {})
            if (not exact(grant, ('schema', 'id', 'identity', 'origin', 'roles', 'purpose_sha256', 'expires_at',
                                 'persist_to_allowlist', 'wildcards')) or
                    grant['schema'] != 'proxypilot.selected-browser.destination-grant.v1' or
                    not isinstance(grant['id'], str) or not UUID.fullmatch(grant['id']) or
                    grant['identity'] != self.policy.identity or grant['origin'] != item['origin'] or
                    grant['roles'] != item['roles'] or t['origin'] != item['origin'] or
                    grant['persist_to_allowlist'] is not False or grant['wildcards'] is not False or
                    not isinstance(grant['purpose_sha256'], str) or not HEX.fullmatch(grant['purpose_sha256']) or
                    not safe_int(grant['expires_at'], 1, self.policy.expires_at) or grant['expires_at'] <= self.clock() or
                    len(item['roles']) != 1 or
                    any(role in existing or (base and role in base['roles']) for role in item['roles']) or
                    (item['origin'] in self.policy.targets and t != self.policy.targets[item['origin']]) or
                    (item['origin'] in self.extra_targets and t != self.extra_targets[item['origin']]) or
                    any(o['id'] == item['id'] for o in (*self.policy.origins.values(),
                        *(v for roles in self.additions.values() for v in roles.values())))):
                raise Denied('DESTINATION_GRANT_INVALID')
            try:
                self.ledger.consume(grant['id'], digest(canonical(dict(grant=grant, destination=item, target=t))))
            except Exception as e:
                if not isinstance(e, Denied) or e.code != 'APPROVAL_ALREADY_CONSUMED':
                    self.state, self.reason = 'revoked', 'LEDGER_WRITE_FAILED'
                    self.tickets.clear()
                raise Denied(e.code if isinstance(e, Denied) else 'LEDGER_WRITE_FAILED') from e
            self._audit('destination_granted', dict(grant_id=grant['id'], origin=item['origin'], roles=item['roles'],
                                                   purpose_sha256=grant['purpose_sha256'], expires_at=grant['expires_at'],
                                                   target_sha256=digest(canonical(t))))
            self.additions.setdefault(item['origin'], {})[item['roles'][0]] = item
            self.extra_targets[item['origin']] = t
            self.purposes[(item['origin'], item['roles'][0])] = grant
            # A grant only admits this origin. Each new request still receives
            # exact per-request effect approval because the base has no rules
            # for the temporary destination. Previously blocked requests expire.
            self.state, self.reason = 'running', None

    def pause(self, reason='USER_PAUSED'):
        with self.lock:
            self._check(allow_paused=True)
            self._freeze(reason)
            self.pending.clear()
            return self.status()

    def resume(self):
        with self.lock:
            self._check(allow_paused=True)
            if self.reason != 'USER_PAUSED':
                raise Denied('ESCALATION_UNRESOLVED')
            self._audit('resumed', dict(identity=self.policy.identity))
            self.state, self.reason = 'running', None
            return self.status()

    def revoke(self):
        with self.lock:
            self.state, self.reason = 'revoked', 'GATEWAY_REVOKED'
            self.tickets.clear()
            for conn in tuple(self.connections):
                try:
                    if conn.sock:
                        conn.sock.shutdown(socket.SHUT_RDWR)
                    conn.close()
                except OSError:
                    pass
            self._audit('revoked', dict(identity=self.policy.identity))
            return self.status()

    def status(self):
        with self.lock:
            expired = [token for token,record in self.tickets.items() if record['expires_at'] <= self.clock()]
            for token in expired:
                self.pending.pop(self.tickets.pop(token)['request_ref'], None)
            if expired and self.state != 'revoked':
                self._freeze('REQUEST_TICKET_EXPIRED')
            return dict(schema='proxypilot.selected-browser.gateway-status.v1', identity=self.policy.identity,
                        state=self.state, reason=self.reason, requests=self.requests,
                        response_bytes=self.response_bytes, ledger_sha256=self.ledger.sha256,
                        effects_sent=self.effects_sent, effects_uncertain=self.effects_uncertain, inflight=self.inflight,
                        outstanding_requests=len(self.pending),
                        network_plan_sha256=self.policy.network_plan_sha256,
                        destinations=len(self.policy.origins), temporary_destinations=len(self.additions))

    def admit(self, method, url, headers, body):
        with self.lock:
            self._check()
            token = headers.get(TICKET_HEADER)
            if not isinstance(token, str) or not HEX.fullmatch(token):
                self._freeze('REQUEST_TICKET_REQUIRED')
                raise Denied('REQUEST_TICKET_REQUIRED')
            record = self.tickets.pop(token, None)
            if record is None or record['expires_at'] <= self.clock():
                self._freeze('REQUEST_TICKET_STALE')
                raise Denied('REQUEST_TICKET_STALE')
            p = url_parts(url)
            meta = record['metadata']
            if (method != meta['method'] or p['url'] != meta['url'] or len(body) != meta['body_bytes'] or
                    digest(body) != meta['body_sha256']):
                self._freeze('REQUEST_WIRE_MISMATCH')
                raise Denied('REQUEST_WIRE_MISMATCH')
            self.policy.destination(p, meta['role'], self.additions)
            temporary = self.purposes.get((p['origin'], meta['role']))
            if temporary and temporary['expires_at'] <= self.clock():
                self._freeze('DESTINATION_GRANT_EXPIRED')
                raise Denied('DESTINATION_GRANT_EXPIRED')
            if (headers.get('upgrade') or headers.get('transfer-encoding') or headers.get('expect') or
                    'upgrade' in headers.get('connection', '').lower() or headers.get('proxy-authorization')):
                self._freeze('REQUEST_TRANSPORT_UNSUPPORTED')
                raise Denied('REQUEST_TRANSPORT_UNSUPPORTED')
            if self.requests >= self.policy.configuration['budgets']['max_requests']:
                self._freeze('REQUEST_BUDGET_EXHAUSTED')
                raise Denied('REQUEST_BUDGET_EXHAUSTED')
            self.requests += 1
            self.pending.pop(record['request_ref'], None)
            self._audit('request_admitted', dict(request_ref=record['request_ref'], binding_sha256=record['binding_sha256'],
                                                 effect=record['effect'], approval_id=record.get('approval_id')))
            return record, p

    def forward(self, method, url, headers, body):
        record, parts = self.admit(method, url, headers, body)
        conn = None
        sent = False
        try:
            answers = self.resolver(parts)
            with self.lock:
                self._check()
                target = self.extra_targets.get(parts['origin']) or self.policy.targets[parts['origin']]
                addresses = self.policy.screen_answers(parts, answers, target)
                if self.route_reader(target['addresses']) != target['route_sha256']:
                    raise Denied('NETWORK_ROUTE_CHANGED')
                remaining = self.started_at + self.policy.configuration['budgets']['max_seconds'] - self.clock()
                conn = self.connection_factory(parts, addresses[0], max(0.1, min(10, remaining)))
                self.connections.add(conn)
                # Holding the gate across connect/write makes pause/cancel a
                # precise boundary: already-started effects become uncertain,
                # while later requests cannot race through revoked authority.
                conn.connect()
                self._check()
                forward = {k: v for k, v in headers.items() if k not in HOP and
                           k not in (TICKET_HEADER, 'host', 'content-length', 'accept-encoding', 'referer', 'origin')}
                if record['destination']['session_headers'] == 'omit':
                    # Omit arbitrary site-specific bearer/session headers too;
                    # a denylist of known cookie/header names is insufficient.
                    forward = {k: v for k, v in forward.items() if k in RESOURCE_HEADERS}
                forward.update(Host=parts['origin'].split('://', 1)[1], Connection='close')
                # Preserve browser negotiation but bound the encoded wire bytes.
                # Decoding is Chromium's job; gateway never stores private bytes.
                if headers.get('accept-encoding'):
                    forward['Accept-Encoding'] = headers['accept-encoding']
                # Origin is sent only when same-origin; Referer may disclose
                # private paths/query values cross-origin and is always omitted.
                if headers.get('origin') == parts['origin']:
                    forward['Origin'] = parts['origin']
                self._audit('send_started', dict(request_ref=record['request_ref'], binding_sha256=record['binding_sha256'],
                                                address_sha256=digest(addresses[0])))
                sent = True
                self.inflight += 1
                if record['effect'] != 'read':
                    self.effects_sent += 1
                conn.request(method, parts['target'], body=body, headers=forward)
            response = conn.getresponse()
            if response.status == 101:
                raise Denied('RESPONSE_TRANSPORT_UNSUPPORTED')
            response_headers = response.getheaders()
            locations = [v for k, v in response_headers if k.lower() == 'location']
            if 300 <= response.status < 400:
                if len(locations) != 1:
                    raise Denied('REDIRECT_INVALID')
                redirect = url_parts(urljoin(parts['url'], locations[0]))
                with self.lock:
                    self.policy.destination(redirect, record['metadata']['role'], self.additions)
                    temporary = self.purposes.get((redirect['origin'], record['metadata']['role']))
                    if temporary and temporary['expires_at'] <= self.clock():
                        raise Denied('DESTINATION_GRANT_EXPIRED')
            chunks = []
            while True:
                with self.lock:
                    self._check(allow_paused=True)
                    max_bytes = self.policy.configuration['budgets']['max_response_bytes']
                    remaining_bytes = max_bytes - self.response_bytes
                    if remaining_bytes < 0:
                        raise Denied('RESPONSE_BUDGET_EXHAUSTED')
                chunk = response.read(min(65536, remaining_bytes + 1))
                if not chunk:
                    break
                with self.lock:
                    self.response_bytes += len(chunk)
                    if self.response_bytes > max_bytes:
                        raise Denied('RESPONSE_BUDGET_EXHAUSTED')
                chunks.append(chunk)
            clean = []
            for k, v in response_headers:
                if not re.fullmatch(r'[A-Za-z0-9-]+', k) or '\r' in v or '\n' in v or '\x00' in v:
                    raise Denied('RESPONSE_HEADER_INVALID')
                if k.lower() in HOP or k.lower() == 'content-length':
                    continue
                if record['destination']['session_headers'] == 'omit' and k.lower() == 'set-cookie':
                    continue
                # These headers could make the browser connect on an alternate
                # transport or leak URLs to a reporting endpoint. No implicit
                # HTTP/3, reporting/nel transport, or refresh destination grant.
                if k.lower() in ('alt-svc', 'report-to', 'reporting-endpoints', 'nel', 'refresh'):
                    continue
                clean.append((k, v))
            self._audit('response_completed', dict(request_ref=record['request_ref'], status=response.status,
                                                    bytes=sum(map(len, chunks)), effect=record['effect']))
            return response.status, clean, b''.join(chunks)
        except Exception as e:
            code = e.code if isinstance(e, Denied) else 'UPSTREAM_FAILED'
            with self.lock:
                if sent and record['effect'] != 'read':
                    self.effects_uncertain += 1
                self._freeze(code, parts['origin'], record['request_ref'])
                self._audit('request_uncertain' if sent and record['effect'] != 'read' else 'request_failed',
                            dict(request_ref=record['request_ref'], binding_sha256=record['binding_sha256'], code=code,
                                 sent=sent, replay_allowed=False))
            if isinstance(e, Denied):
                raise
            raise Denied(code) from e
        finally:
            if conn is not None:
                with self.lock:
                    if sent:
                        self.inflight -= 1
                    self.connections.discard(conn)
                conn.close()


def read_request(reader):
    line = reader.readline(MAX_HEADER_BYTES + 1)
    if not line or len(line) > MAX_HEADER_BYTES or not line.endswith(b'\r\n'):
        raise Denied('HTTP_REQUEST_INVALID')
    try:
        method, target, version = line[:-2].decode('ascii').split(' ')
    except (ValueError, UnicodeError) as e:
        raise Denied('HTTP_REQUEST_INVALID') from e
    if version != 'HTTP/1.1':
        raise Denied('HTTP_VERSION_UNSUPPORTED')
    headers, total = {}, len(line)
    while True:
        line = reader.readline(MAX_HEADER_BYTES + 1)
        total += len(line)
        if not line or total > MAX_HEADER_BYTES or not line.endswith(b'\r\n'):
            raise Denied('HTTP_HEADERS_INVALID')
        if line == b'\r\n':
            break
        if line[:1] in (b' ', b'\t') or b':' not in line:
            raise Denied('HTTP_HEADERS_INVALID')
        name, value = line[:-2].split(b':', 1)
        if not re.fullmatch(rb'[A-Za-z0-9-]+', name) or any(v < 32 and v != 9 or v == 127 for v in value):
            raise Denied('HTTP_HEADERS_INVALID')
        key = name.decode('ascii').lower()
        if key in headers:
            raise Denied('HTTP_DUPLICATE_HEADER')
        headers[key] = value.decode('latin-1').strip()
    return method, target, headers


def send_response(writer, status, headers=(), body=b''):
    phrase = http.client.responses.get(status, 'Response')
    writer.write(f'HTTP/1.1 {status} {phrase}\r\n'.encode())
    for k, v in headers:
        writer.write(f'{k}: {v}\r\n'.encode('latin-1'))
    writer.write(f'Content-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode())
    writer.write(body)
    writer.flush()


def serve_selected_socket(request, gateway, tls):
    """Called only after the existing proxy authenticates the fixed guest peer."""
    request.settimeout(10)
    reader = request.makefile('rb')
    writer = request.makefile('wb')
    client = None
    try:
        method, target, headers = read_request(reader)
        if method == 'CONNECT':
            if headers.get('host') != target or set(headers) - {'host', 'proxy-connection', 'user-agent'}:
                raise Denied('CONNECT_INVALID')
            parts = gateway.check_connect(target)
            writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            writer.flush()
            reader.close()
            writer.close()
            client = tls.wrap_socket(request, server_side=True)
            client.settimeout(10)
            reader, writer = client.makefile('rb'), client.makefile('wb')
            method, target, headers = read_request(reader)
            if (not target.startswith('/') or target.startswith('//') or '#' in target or
                    headers.get('host') != parts['origin'].split('://', 1)[1]):
                raise Denied('HTTP_TARGET_INVALID')
            url = parts['origin'] + target
        else:
            parts = url_parts(target)
            if parts['scheme'] != 'http' or headers.get('host') != parts['origin'].split('://', 1)[1]:
                raise Denied('HTTP_TARGET_INVALID')
            url = parts['url']
        if headers.get('transfer-encoding') or headers.get('expect'):
            raise Denied('REQUEST_TRANSPORT_UNSUPPORTED')
        length = headers.get('content-length', '0')
        if not re.fullmatch(r'0|[1-9][0-9]{0,8}', length) or int(length) > MAX_BODY_BYTES:
            raise Denied('HTTP_BODY_INVALID')
        body = reader.read(int(length))
        if len(body) != int(length):
            raise Denied('HTTP_BODY_INCOMPLETE')
        status, response_headers, body = gateway.forward(method, url, headers, body)
        send_response(writer, status, response_headers, body)
    except (Denied, OSError, ssl.SSLError, http.client.HTTPException) as e:
        with gateway.lock:
            try:
                gateway._freeze(e.code if isinstance(e, Denied) else 'CLIENT_TRANSPORT_FAILED')
            except Denied:
                pass
        try:
            send_response(writer, 403)
        except (OSError, ValueError):
            pass
    finally:
        reader.close()
        writer.close()
        if client:
            client.close()


class SelectedGatewayRegistry:
    """One fixed guest identity, one attempt, immutable base, restart denied.

The durable latch is installed before policy/tickets are accepted. A crash loses
all live authority and keeps this peer blocked until the supervisor verifies
guest teardown. An absent active attempt never implies selected->demo fallback.
"""
    def __init__(self, directory, require_root=True, resolver=resolve_host, connection_factory=PinnedConnection,
                 clock=time.time, proxy_source=None):
        self.directory = Path(directory)
        self.require_root = require_root
        self.resolver, self.connection_factory = resolver, connection_factory
        self.clock = clock
        self.loaded_files = {name+'.py':sha for name,sha in LOADED_HELPER_HASHES.items()}
        self.loaded_files['a3-origin-proxy.py'] = digest(Path(proxy_source or Path(__file__).with_name('a3-origin-proxy.py')).read_bytes())
        self.lock = threading.RLock()
        self.gateway = None
        self.latch_path = self.directory / 'selected-gateway-latch.json'
        self._directory()
        self.latched_identity = None
        if self.latch_path.exists():
            self._safe_file(self.latch_path)
            data = strict_json(self.latch_path.read_text())
            if not exact(data, ('schema', 'identity')) or data['schema'] != 'proxypilot.selected-browser.gateway-latch.v1':
                raise Denied('GATEWAY_LATCH_INVALID')
            self.latched_identity = data['identity']

    def _directory(self):
        self.directory.mkdir(mode=0o700, parents=False, exist_ok=True)
        s = self.directory.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_mode & 0o077 or (self.require_root and s.st_uid != 0):
            raise Denied('GATEWAY_DIRECTORY_UNSAFE')

    def _safe_file(self, path):
        s = path.lstat()
        if (not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077 or s.st_nlink != 1 or
                (self.require_root and s.st_uid != 0) or s.st_size > MAX_CONTROL_BYTES):
            raise Denied('GATEWAY_FILE_UNSAFE')

    def _sync_directory(self):
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def register(self, params):
        if not exact(params, ('configuration', 'configuration_json', 'network_plan', 'identity')):
            raise Denied('REGISTER_INVALID')
        with self.lock:
            if self.latched_identity is not None:
                raise Denied('GATEWAY_ATTEMPT_ACTIVE_OR_UNRECONCILED')
            policy = GatewayPolicy(**params, clock=self.clock)
            # Exclusive file creation ensures two daemon/controller instances
            # cannot silently switch the attempt receiving this fixed peer.
            fd = os.open(self.latch_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                raw = canonical(dict(schema='proxypilot.selected-browser.gateway-latch.v1', identity=policy.identity)).encode()
                if os.write(fd, raw) != len(raw):
                    raise Denied('GATEWAY_LATCH_WRITE_FAILED')
                os.fsync(fd)
            finally:
                os.close(fd)
            self._sync_directory()
            self.latched_identity = policy.identity
            try:
                ledger = FileLedger(self.directory / ('selected-' + policy.identity['attempt_id'] + '.ledger'),
                                    require_root=self.require_root)
                # A recovered ledger from the same attempt cannot be revived.
                if ledger.rows:
                    ledger.close()
                    raise Denied('GATEWAY_ATTEMPT_REUSED')
                self.gateway = AttemptGateway(policy, ledger, self.resolver, self.connection_factory, clock=self.clock)
            except Exception:
                self.gateway = None
                raise
            return self.gateway.status()

    def selected(self):
        with self.lock:
            return self.latched_identity is not None, self.gateway

    def _bound(self, params, extra=()):
        if not exact(params, ('identity', *extra)) or params['identity'] != self.latched_identity:
            raise Denied('CONTROL_IDENTITY_MISMATCH')
        if self.gateway is None:
            raise Denied('GATEWAY_RECONCILIATION_REQUIRED')
        return self.gateway

    def release(self, params):
        with self.lock:
            if (not exact(params, ('identity', 'cleanup')) or params['identity'] != self.latched_identity or
                    params['cleanup'] != dict(descendants_gone=True, workspace_gone=True, fence_still_installed=True)):
                raise Denied('CLEANUP_UNVERIFIED')
            if self.gateway:
                if self.gateway.state != 'revoked':
                    raise Denied('GATEWAY_REVOKE_REQUIRED')
                self.gateway.ledger.close()
                self.gateway = None
            self.latch_path.unlink()
            self._sync_directory()
            self.latched_identity = None
            return dict(released=True, selected_execution_enabled=False)

    def dispatch(self, value):
        if not exact(value, ('v', 'method', 'params')) or value['v'] != 1:
            raise Denied('CONTROL_ENVELOPE_INVALID')
        method, params = value['method'], value['params']
        if method == 'health':
            if params != {}:
                raise Denied('CONTROL_ENVELOPE_INVALID')
            return dict(contract_version='selected-browser.v1', protocol='selected-gateway.v1',
                        active=self.latched_identity is not None, files=dict(self.loaded_files))
        if method == 'register':
            return self.register(params)
        if method == 'release':
            return self.release(params)
        with self.lock:
            extras = {'request': ('request_ref', 'metadata'), 'approve': ('request_ref', 'grant'),
                      'destination_grant': ('grant', 'destination', 'target'), 'pause': (),
                      'resume': (), 'revoke': (), 'status': ()}
            if method not in extras:
                raise Denied('CONTROL_METHOD_INVALID')
            if (method in ('status', 'revoke') and self.gateway is None and self.latched_identity is not None and
                    exact(params, ('identity',)) and params['identity'] == self.latched_identity):
                return dict(state='revoked', reason='GATEWAY_RECOVERED_CLOSED', identity=self.latched_identity,
                            ledger_sha256=None, recovery_required=True)
            gateway = self._bound(params, extras[method])
            if method == 'request':
                return gateway.review_request(params['request_ref'], params['metadata'])
            if method == 'approve':
                return gateway.approve_request(params['request_ref'], params['grant'])
            if method == 'destination_grant':
                gateway.grant_destination(params['grant'], params['destination'], params['target'])
                return gateway.status()
            return getattr(gateway, method)()


class ControlHandler(socketserver.BaseRequestHandler):
    def handle(self):
        # Linux root peer identity is required independently of socket mode.
        # This socket is never mounted inside the backend or browser VM.
        creds = self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
        _, uid, _ = struct.unpack('3i', creds)
        if uid != self.server.peer_uid:
            return
        self.request.settimeout(10)
        reader = self.request.makefile('rb')
        try:
            raw = reader.readline(MAX_CONTROL_BYTES + 1)
            if not raw.endswith(b'\n') or len(raw) > MAX_CONTROL_BYTES:
                raise Denied('CONTROL_REQUEST_TOO_LARGE')
            result = self.server.registry.dispatch(strict_json(raw.decode('utf-8')))
            response = dict(ok=True, result=result)
        except Exception as e:
            response = dict(ok=False, code=e.code if isinstance(e, Denied) else 'CONTROL_FAILED')
        finally:
            reader.close()
        self.request.sendall((canonical(response) + '\n').encode())


class ControlServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 16


def start_control(registry, socket_path, peer_uid=0):
    path = Path(socket_path)
    if path.exists() or path.is_symlink():
        parent, old = path.parent.lstat(), path.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o022 or
                not stat.S_ISSOCK(old.st_mode) or old.st_uid != os.geteuid() or old.st_mode & 0o077):
            raise Denied('CONTROL_SOCKET_EXISTS')
        # Recover only a proven dead root-owned socket. The durable attempt
        # latch remains in place, so restart never restores request authority.
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(.2)
            try:
                probe.connect(str(path))
            except ConnectionRefusedError:
                current = path.lstat()
                if (current.st_dev, current.st_ino) != (old.st_dev, old.st_ino):
                    raise Denied('CONTROL_SOCKET_EXISTS')
                path.unlink()
            except OSError:
                raise Denied('CONTROL_SOCKET_EXISTS') from None
            else:
                raise Denied('CONTROL_SOCKET_EXISTS')
    server = ControlServer(str(path), ControlHandler)
    os.chmod(path, 0o600)
    server.registry, server.peer_uid = registry, peer_uid
    thread = threading.Thread(target=server.serve_forever, daemon=True, name='selected-gateway-control')
    thread.start()
    return server


def control_call(path, method, params):
    """Typed local supervisor helper. No HTTP/MCP/backend network endpoint."""
    value = dict(v=1, method=method, params=params)
    raw = (canonical(value) + '\n').encode()
    if len(raw) > MAX_CONTROL_BYTES:
        raise Denied('CONTROL_REQUEST_TOO_LARGE')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(10)
        sock.connect(str(path))
        sock.sendall(raw)
        with sock.makefile('rb') as reader:
            raw = reader.readline(MAX_CONTROL_BYTES + 1)
    if not raw.endswith(b'\n') or len(raw) > MAX_CONTROL_BYTES:
        raise Denied('CONTROL_RESPONSE_INVALID')
    response = strict_json(raw.decode())
    if response.get('ok') is not True:
        raise Denied(response.get('code', 'CONTROL_FAILED'))
    return response['result']
