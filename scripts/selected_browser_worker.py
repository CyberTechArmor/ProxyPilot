"""Selected-site guest adapter. Only the installed supervisor may start it.

The existing A3 Browser owns Chromium, its private pipe and live desktop. This
adapter replaces its demo request policy with a before-send host ticket gate.
It never resolves a target, grants an approval, invokes a model or reads a host
path. All page-derived text and claims remain untrusted. The host independently
checks every wire request and approval; this browser gate is defense in depth.
"""
import base64
import hashlib
import json
import re
import secrets
import threading
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

HEX = re.compile(r'[0-9a-f]{64}\Z')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
REF = re.compile(r'[A-Za-z0-9_-]{1,128}\Z')
KINDS = frozenset(('navigate', 'read', 'click', 'scroll', 'type', 'wait', 'download',
                   'copy', 'paste', 'screenshot', 'upload', 'submit'))
EFFECTS = frozenset(('click', 'type', 'paste', 'upload', 'submit'))
OP_KEYS = {
    'navigate': {'kind', 'destination_id', 'url'},
    'read': {'kind', 'scope', 'selection_ref'}, 'click': {'kind', 'element_ref'},
    'scroll': {'kind', 'dx', 'dy'}, 'type': {'kind', 'element_ref', 'input_ref'},
    'wait': {'kind', 'max_ms'}, 'download': {'kind', 'resource_ref'},
    'copy': {'kind', 'selection_ref'}, 'paste': {'kind', 'element_ref', 'clipboard_ref'},
    'screenshot': {'kind', 'area', 'selection_ref'},
    'upload': {'kind', 'element_ref', 'asset_ref'},
    'submit': {'kind', 'form_ref', 'field_set_sha256'},
}
ENVELOPE_KEYS = {'schema', 'run_id', 'attempt_id', 'fence', 'ordinal', 'policy_sha256',
                 'snapshot_ref', 'candidate_ref', 'approval_ref', 'operation'}
MAX_TEXT_BYTES = 12000
MAX_ELEMENTS = 48
MAX_CANDIDATES = 192
MAX_REQUESTS_PENDING = 64
SENSITIVE = re.compile(r'password|passwd|secret|token|otp|one.time|verification.code|credit.card|cvv|cvc|ssn', re.I)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def utf8_bound(value, maximum):
    return str(value).encode('utf-8', 'replace')[:maximum].decode('utf-8', 'ignore')


def clean_text(value, maximum=160):
    # The observation does not read form values. Mask common secret-like strings
    # in ordinary page text too, without pretending this proves arbitrary text
    # or pixels contain no secrets. Host disclosure consent still applies.
    value = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', str(value))
    value = re.sub(r'(?i)\b(?:bearer\s+|(?:password|secret|token|api[_ -]?key)\s*[:=]\s*)\S+', '[redacted]', value)
    return utf8_bound(value, maximum)


def origin(url):
    if not isinstance(url, str) or len(url) > 2048 or re.search(r'[\s\\\x00-\x1f\x7f]', url):
        return None
    try:
        p = urlsplit(url)
        if p.scheme not in ('http', 'https') or not p.hostname or p.username is not None or p.password is not None:
            return None
        # Chrome URL parsing and the gateway are authoritative. This check only
        # narrows the set; ambiguous authorities do not reach the host gateway.
        if '%' in p.netloc or p.hostname.endswith('.') or p.hostname.lower() != p.hostname:
            return None
        if ':' not in p.hostname and (len(p.hostname) > 253 or any(
                not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                for label in p.hostname.split('.'))):
            return None
        host = '[' + p.hostname + ']' if ':' in p.hostname else p.hostname
        default = 443 if p.scheme == 'https' else 80
        return p.scheme + '://' + host + (':' + str(p.port) if p.port and p.port != default else '')
    except ValueError:
        return None


def safe_url(url):
    try:
        p = urlsplit(url)
        return (origin(url) or '') + clean_text(p.path, 300)
    except ValueError:
        return ''


def pinned_ref(value, asset=False):
    keys = {'id', 'sha256', 'mime_type', 'byte_count'} if asset else {'id', 'sha256'}
    return (isinstance(value, dict) and set(value) == keys and isinstance(value.get('id'), str) and UUID.fullmatch(value['id'])
            and isinstance(value.get('sha256'), str) and HEX.fullmatch(value['sha256']) and (not asset or
            isinstance(value.get('mime_type'), str) and 0 < len(value['mime_type']) <= 100
            and type(value.get('byte_count')) is int and 0 < value['byte_count'] <= 67108864))


def validate_operation(op, refused):
    if not isinstance(op, dict) or op.get('kind') not in OP_KEYS or set(op) != OP_KEYS[op['kind']]:
        raise refused('INVALID_SELECTED_ACTION')
    kind = op['kind']
    for key in ('element_ref', 'form_ref', 'resource_ref'):
        if key in op and (not isinstance(op[key], str) or not REF.fullmatch(op[key])):
            raise refused('INVALID_SELECTED_ACTION')
    if 'selection_ref' in op and op['selection_ref'] is not None and (
            not isinstance(op['selection_ref'], str) or not REF.fullmatch(op['selection_ref'])):
        raise refused('INVALID_SELECTED_ACTION')
    if kind == 'navigate' and (not origin(op['url']) or not isinstance(op['destination_id'], str)
                              or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', op['destination_id'])):
        raise refused('INVALID_SELECTED_ACTION')
    if kind == 'scroll' and any(type(op[k]) is not int or not -2000 <= op[k] <= 2000 for k in ('dx', 'dy')):
        raise refused('INVALID_SELECTED_ACTION')
    if kind == 'wait' and (type(op['max_ms']) is not int or not 1 <= op['max_ms'] <= 10000):
        raise refused('INVALID_SELECTED_ACTION')
    if kind == 'read' and (op['scope'] not in ('visible_page', 'selection') or
                           (op['scope'] == 'selection') != (op['selection_ref'] is not None)):
        raise refused('INVALID_SELECTED_ACTION')
    if kind == 'screenshot' and (op['area'] not in ('viewport', 'selection') or
                                 (op['area'] == 'selection') != (op['selection_ref'] is not None)):
        raise refused('INVALID_SELECTED_ACTION')
    if kind == 'copy' and op['selection_ref'] is None:
        raise refused('INVALID_SELECTED_ACTION')
    for key in ('input_ref', 'clipboard_ref', 'asset_ref'):
        if key in op and not pinned_ref(op[key], asset=key == 'asset_ref'):
            raise refused('INVALID_SELECTED_ACTION')
    if kind == 'submit' and (not isinstance(op.get('field_set_sha256'), str) or not HEX.fullmatch(op['field_set_sha256'])):
        raise refused('INVALID_SELECTED_ACTION')
    return op


def validate_selected_config(value, refused):
    keys = {'run_id', 'attempt_id', 'fence', 'policy_sha256', 'configuration'}
    if (not isinstance(value, dict) or set(value) != keys or
            not isinstance(value.get('run_id'), str) or not UUID.fullmatch(value['run_id']) or
            not isinstance(value.get('attempt_id'), str) or not UUID.fullmatch(value['attempt_id']) or
            type(value.get('fence')) is not int or not 1 <= value['fence'] <= 2147483647 or
            not isinstance(value.get('policy_sha256'), str) or not HEX.fullmatch(value['policy_sha256'])):
        raise refused('INVALID_SELECTED_CONFIG')
    c = value['configuration']
    # The host validates the complete packaged JSON schema and policy hash.
    # The guest additionally refuses weaker values at every authority boundary.
    try:
        if (c['schema'] != 'proxypilot.browser-agent.proposal.v1' or c['workflow'] != 'selected_browser_v1' or
                c['destinations']['network_scope'] != 'explicit_destinations' or
                c['destinations']['off_list'] != 'pause_and_escalate_before_send' or
                c['permissions']['external_change_approval'] != 'per_action' or
                c['permissions']['preauthorization_refs'] != [] or
                c['authentication'] != {'mode': 'manual_takeover', 'session_lifetime': 'attempt', 'persist_session': False} or
                c['artifacts']['capture_during_manual_auth'] is not False or
                c['artifacts']['record_video'] is not False or
                not set(c['permissions']['actions']).issubset(KINDS)):
            raise refused('INVALID_SELECTED_CONFIG')
        for dest in c['destinations']['allowed_origins']:
            if origin(dest['origin']) != dest['origin'] or not dest['roles']:
                raise refused('INVALID_SELECTED_CONFIG')
        for name in ('max_seconds', 'max_actions', 'max_requests', 'max_response_bytes', 'max_artifact_bytes'):
            if type(c['budgets'][name]) is not int or c['budgets'][name] <= 0:
                raise refused('INVALID_SELECTED_CONFIG')
    except (KeyError, TypeError, ValueError) as error:
        raise refused('INVALID_SELECTED_CONFIG') from error
    return value


# Fixed isolated-world program: references live in this world's closure, never
# DOM attributes or page-controlled selectors. No input values enter the result.
SNAPSHOT = r'''(() => {
 const nonce = %s, cap = %d;
 const visible = e => e.isConnected && e.getClientRects().length &&
   getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' &&
   (()=>{const r=e.getBoundingClientRect();return r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;})();
 const secret = e => /password|passwd|secret|token|otp|one.time|verification.code|credit.card|cvv|cvc|ssn/i.test(
   [e.type,e.name,e.id,e.autocomplete,e.getAttribute('aria-label')].join(' '));
 const label = e => (e.getAttribute('aria-label') || e.labels?.[0]?.innerText ||
   e.getAttribute('placeholder') || (e.tagName==='INPUT' ? e.type : e.innerText) || e.tagName).trim().slice(0,160);
 const registry = new Map(), fingerprints = new Map(), nodes = [], forms = [], resources = [];
 const fingerprint = e => [e.outerHTML,e.form?.action,e.form?.method].join('\n');
 const bind = (e,kind) => { const ref = nonce+'_'+kind+'_'+registry.size; registry.set(ref,e);fingerprints.set(ref,fingerprint(e));return ref; };
 for(const e of document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]')) {
   if(nodes.length>=cap) break;
   if(!visible(e) || e.disabled || secret(e)) continue;
 const kind = e.tagName==='INPUT' && e.type==='file' ? 'file' :
     e.tagName==='TEXTAREA' || e.tagName==='SELECT' || e.isContentEditable || e.tagName==='INPUT' && !['submit','button','checkbox','radio','hidden'].includes(e.type) ? 'input' : 'click';
   const r=e.getBoundingClientRect();
   const node={ref:bind(e,'element'),kind,label:label(e),tag:e.tagName.toLowerCase(),
     bounds:{x:r.x,y:r.y,width:r.width,height:r.height}, href:e.tagName==='A'?e.href:null};
   nodes.push(node);
   if(e.tagName==='A' && e.hasAttribute('download')) resources.push({ref:bind(e,'resource'),url:e.href,label:label(e)});
 }
 for(const form of document.forms) {
   if(forms.length>=12) break;
   if(!visible(form) || [...form.elements].some(secret)) continue;
   forms.push({ref:bind(form,'form'),method:(form.method||'get').toUpperCase(),url:form.action});
 }
 // TreeWalker excludes script/style/templates, hidden elements and all form
 // values. The text itself can still contain private/injected prose.
 const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);
 const chunks=[];let count=0,node;
 while((node=walker.nextNode()) && count<24000) {
   const parent=node.parentElement;
   if(!parent || ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','TEXTAREA','OPTION'].includes(parent.tagName) ||
      parent.closest('input,textarea,[contenteditable="true"],[hidden]') || !visible(parent)) continue;
   const text=node.textContent.trim();if(!text) continue;
   chunks.push(text.slice(0,2000));count+=text.length;
 }
 const text=chunks.join('\n').slice(0,24000), selection=nonce+'_selection';
 globalThis.__ppSelected={nonce,registry,fingerprints,fingerprint,text,selection,href:location.href};
 return {url:location.href,title:document.title,text,selection_ref:selection,nodes,forms,resources};
})()'''

FORM_VALUES = r'''(() => {
 const s=globalThis.__ppSelected, f=s?.registry.get(%s);
 if(!f || !f.isConnected || f.tagName!=='FORM' || s.href!==location.href) return null;
 const values=[];for(const e of f.elements) {
   if(/password|passwd|secret|token|otp|one.time|verification.code|credit.card|cvv|cvc|ssn/i.test(
      [e.type,e.name,e.id,e.autocomplete].join(' '))) return null;
   if(e.type==='file') values.push([e.name,e.type,[...e.files].map(x=>[x.name,x.size,x.type])]);
   else values.push([e.name,e.type,e.value,e.checked??null]);
 }
 return {method:(f.method||'get').toUpperCase(),url:f.action,values};
})()'''


def selected_browser_class(base, refused, *, validate_configuration=None, validate_action=None):
    """Factory avoids an import cycle with the installed A3 guest runner."""
    class SelectedBrowser(base):
        def __init__(self, selected, spki, channel, live=None):
            self.selected = validate_selected_config(selected, refused)
            self.config = selected['configuration']
            if validate_configuration is not None:
                try:
                    validate_configuration(self.config)
                except Exception as error:
                    raise refused('INVALID_SELECTED_CONFIG') from error
            self.manual_auth = False
            self.paused = False
            self.frozen = False
            self.current_action = None
            self.snapshot = None
            self.candidates = {}
            self.input_targets = {}
            self.resources = {}
            self.frame_contexts = {}
            self.child_sessions = {}
            self.child_target_types = {}
            self.owned_pages = set()
            self.stage_bindings = {}
            self.request_lock = threading.RLock()
            self.request_watchdog_stop = threading.Event()
            self.requests = {}
            self.request_count = 0
            self.response_bytes = 0
            self.artifact_bytes = 0
            self.next_ordinal = 1
            self.started = time.monotonic()
            self.destinations = {d['origin']: d for d in self.config['destinations']['allowed_origins']}
            self.temporary_destinations = {}
            self.ticketed_documents = set()
            self.navigation_load = None
            self.submission_network = None
            self.proposed_navigation = None
            super().__init__(spki, channel, live)
            self.owned_pages.add(self.main_target)
            # Chromium never saves downloads to arbitrary paths. Typed download
            # fetches below return bounded bytes into the private host artifact path.
            self.cdp.on('Network.dataReceived', self._data_received)
            self.cdp.on('Page.loadEventFired', self._loaded)
            # Browser-level auto-attach covers new windows before their page
            # scripts run. The gateway still independently refuses unticketed
            # initial requests, including an early popup navigation.
            self.cdp.call('Target.setAutoAttach', {'autoAttach': True,
                'waitForDebuggerOnStart': True, 'flatten': True})
            threading.Thread(target=self._expire_requests, daemon=True).start()

        def identity(self):
            return {k: self.selected[k] for k in ('run_id', 'attempt_id', 'fence', 'policy_sha256')}

        def _loaded(self, params, session):
            waiting = self.navigation_load
            if waiting and waiting[0] == session:
                waiting[1].set()

        def _remaining_seconds(self):
            self._check()
            return max(0.001, self.config['budgets']['max_seconds'] - (time.monotonic() - self.started))

        def _destination(self, url):
            """A host-reviewed temporary hint never replaces network authority."""
            key = origin(url)
            temporary = self.temporary_destinations.get(key)
            if temporary and temporary['deadline'] <= time.monotonic():
                self.temporary_destinations.pop(key)
                if key not in self.destinations:
                    self.ticketed_documents.discard(key)
                self._invalidate()
                temporary = None
            return temporary['destination'] if temporary else self.destinations.get(key)

        def grant_destination(self, destination, expires_at):
            # Only the fixed supervisor command may provide this hint after the
            # independent gateway has admitted the exact attempt/purpose grant.
            # It permits fresh proposals and controls header omission; every new
            # request still requires its own one-shot ticket from that gateway.
            keys = {'id', 'origin', 'roles', 'session_headers'}
            if (not isinstance(destination, dict) or set(destination) != keys or
                    not isinstance(destination.get('id'), str) or
                    not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', destination['id']) or
                    not origin(destination.get('origin')) or origin(destination['origin']) != destination['origin'] or
                    not isinstance(destination.get('roles'), list) or not destination['roles'] or
                    any(role not in ('navigation', 'resource', 'authentication') for role in destination['roles']) or
                    len(set(destination['roles'])) != len(destination['roles']) or
                    destination.get('session_headers') not in ('omit', 'this_origin_session') or
                    destination['roles'] == ['resource'] and destination['session_headers'] != 'omit' or
                    destination['origin'].startswith('http://') and
                    ('authentication' in destination['roles'] or destination['session_headers'] != 'omit') or
                    not isinstance(expires_at, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z', expires_at)):
                raise refused('INVALID_DESTINATION_GRANT')
            try:
                expiry = datetime.fromisoformat(expires_at.replace('Z', '+00:00')).timestamp()
            except ValueError as error:
                raise refused('INVALID_DESTINATION_GRANT') from error
            remaining = self.config['budgets']['max_seconds'] - (time.monotonic() - self.started)
            ttl = expiry - datetime.now(timezone.utc).timestamp()
            if self.exited.is_set() or not 0 < ttl <= remaining:
                raise refused('DESTINATION_GRANT_EXPIRED')
            if any(d['id'] == destination['id'] and d['origin'] != destination['origin']
                   for d in list(self.destinations.values()) +
                   [t['destination'] for t in self.temporary_destinations.values()]):
                raise refused('INVALID_DESTINATION_GRANT')
            self.temporary_destinations[destination['origin']] = {
                'destination': json.loads(canonical(destination)), 'deadline': time.monotonic() + ttl}
            self._invalidate()
            return {'granted': True, 'origin': destination['origin'], 'id': destination['id'],
                    'expires_at': expires_at, 'base_allowlist_unchanged': True,
                    'fresh_observation_required': True}

        def _check(self, capture=False, allow_paused=False):
            for key in list(self.temporary_destinations):
                self._destination(key)
            if self.exited.is_set():
                raise refused('BROWSER_CLOSED')
            if time.monotonic() - self.started >= self.config['budgets']['max_seconds']:
                self.frozen = True
                raise refused('DEADLINE')
            if self.frozen:
                raise refused('SELECTED_REQUEST_BLOCKED')
            if self.paused and not allow_paused:
                raise refused('SELECTED_PAUSED')
            if capture and self.manual_auth:
                raise refused('MANUAL_AUTH_CAPTURE_BLOCKED')

        def _invalidate(self):
            for ident, binding in list(self.stage_bindings.items()):
                if binding.get('single_use'):
                    binding['data'][:] = b'\0' * len(binding['data'])
                    self.stage_bindings.pop(ident)
            self.snapshot = None
            self.candidates = {}
            self.input_targets = {}
            self.resources = {}
            self.frame_contexts = {}

        def _refused_request(self, params, session, code):
            self.frozen = True
            self._invalidate()
            self.cdp.notify('Fetch.failRequest', {'requestId': params['requestId'], 'errorReason': 'BlockedByClient'}, session)
            self.channel.emit({'event': 'selected_request_blocked', 'code': code, **self.identity()})

        def _paused(self, params, session):
            request = params.get('request', {})
            url, method = request.get('url'), request.get('method')
            if not origin(url) or not isinstance(method, str) or not re.fullmatch(r'[A-Z]{1,16}', method):
                return self._refused_request(params, session, 'SELECTED_SCHEME_BLOCKED')
            if self.frozen or self.paused:
                return self._refused_request(params, session, 'SELECTED_PAUSED')
            if time.monotonic() - self.started >= self.config['budgets']['max_seconds']:
                return self._refused_request(params, session, 'DEADLINE')
            # Exact binary postDataEntries, when present, are the only accepted
            # materialization for binary uploads. The proxy recomputes this hash
            # over the decrypted wire body; a mismatch never reaches upstream.
            try:
                if request.get('postDataEntries'):
                    entries = request['postDataEntries']
                    if not all(isinstance(e, dict) and isinstance(e.get('bytes'), str) for e in entries):
                        raise ValueError('body unavailable')
                    body = b''.join(base64.b64decode(e['bytes'], validate=True) for e in entries)
                elif 'postData' in request:
                    body = request['postData'].encode('utf-8')
                elif request.get('hasPostData'):
                    raise ValueError('body unavailable')
                else:
                    body = b''
                if len(body) > self.config['artifacts']['upload_max_bytes'] + 65536:
                    raise ValueError('body oversized')
            except (TypeError, ValueError, KeyError, UnicodeError):
                return self._refused_request(params, session, 'REQUEST_BODY_UNVERIFIED')
            dest = self._destination(url)
            # Metadata is trusted browser context, never user-supplied headers.
            resource_type = str(params.get('resourceType', 'Other')).lower()
            role = ('authentication' if self.manual_auth and resource_type in ('document', 'xhr', 'fetch') else
                    'navigation' if resource_type == 'document' else 'resource')
            metadata = {**self.identity(), 'url': url, 'method': method,
                        'body_sha256': hashlib.sha256(body).hexdigest(), 'body_bytes': len(body),
                        'resource_type': resource_type, 'role': role,
                        'current_action': self.current_action}
            del body
            with self.request_lock:
                self.request_count += 1
                if self.request_count > self.config['budgets']['max_requests'] or len(self.requests) >= MAX_REQUESTS_PENDING:
                    return self._refused_request(params, session, 'REQUEST_LIMIT')
                request_ref = secrets.token_urlsafe(24)
                remaining = max(0.001, self.config['budgets']['max_seconds'] - (time.monotonic() - self.started))
                self.requests[request_ref] = {'params': params, 'session': session, 'destination': dest,
                                              'expires': time.monotonic() + remaining, 'role': role,
                                              'resource_type': resource_type}
                if self.submission_network is not None and self.current_action is not None:
                    if resource_type == 'document':
                        self.submission_network['document'] = True
                    self.submission_network['observed'].set()
            self.channel.emit({'event': 'selected_request', 'request_ref': request_ref, 'metadata': metadata})

        def _expire_requests(self):
            # One thread for the attempt, not a timer/process per request. The
            # guest's finite TasksMax must not depend on completed request count.
            while not self.request_watchdog_stop.wait(0.2):
                with self.request_lock:
                    expired = [ref for ref, p in self.requests.items() if p['expires'] <= time.monotonic()]
                for ref in expired:
                    try:
                        self.request_decision({'request_ref': ref, 'decision': 'block', 'code': 'REQUEST_AUTHORITY_TIMEOUT'})
                    except refused:
                        return

        def request_decision(self, decision):
            """Only the trusted supervisor control channel calls this method."""
            if not isinstance(decision, dict) or not isinstance(decision.get('request_ref'), str):
                raise refused('INVALID_REQUEST_DECISION')
            with self.request_lock:
                pending = self.requests.pop(decision['request_ref'], None)
            if pending is None:
                return {'accepted': False}
            if (decision.get('decision') != 'allow' or set(decision) != {'request_ref', 'decision', 'ticket'} or
                    not isinstance(decision.get('ticket'), str) or not HEX.fullmatch(decision['ticket']) or
                    self.frozen or self.paused or time.monotonic() > pending['expires']):
                code = decision.get('code', 'REQUEST_AUTHORITY_DENIED')
                return self._refused_request(pending['params'], pending['session'],
                    code if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', code) else 'REQUEST_AUTHORITY_DENIED')
            request = pending['params']['request']
            dest = self._destination(request['url'])
            omit = not dest or dest.get('session_headers') == 'omit'
            headers = [{'name': key, 'value': value} for key, value in request.get('headers', {}).items()
                       if key.lower() != 'x-proxypilot-request-token' and
                       (not omit or key.lower() not in ('cookie', 'authorization', 'proxy-authorization'))]
            headers.append({'name': 'X-ProxyPilot-Request-Token', 'value': decision['ticket']})
            if pending['resource_type'] == 'document':
                self.ticketed_documents.add(origin(request['url']))
            self.cdp.notify('Fetch.continueRequest', {'requestId': pending['params']['requestId'],
                                                   'headers': headers}, pending['session'])
            return {'accepted': True}

        def _request(self, params, session):
            pass  # Redirects re-enter Fetch and require their own ticket.

        def _response(self, params, session):
            response = params.get('response', {})
            if session == getattr(self, 'session', None) and params.get('type') == 'Document':
                self.statuses[params.get('loaderId')] = (response.get('status'), response.get('url'))

        def _data_received(self, params, session):
            self.response_bytes += max(0, int(params.get('dataLength', 0)))
            if self.response_bytes > self.config['budgets']['max_response_bytes']:
                self.frozen = True
                self.cdp.notify('Page.stopLoading', {}, getattr(self, 'session', None))
                self.channel.emit({'event': 'selected_request_blocked', 'code': 'RESPONSE_LIMIT', **self.identity()})

        def _attached(self, params, session):
            # Same A3 policy in all child sessions; disable bypass transports.
            child = params.get('sessionId')
            kind = params.get('targetInfo', {}).get('type')
            if kind in ('service_worker', 'shared_worker'):
                self.cdp.notify('Target.closeTarget', {'targetId': params['targetInfo'].get('targetId')})
                return
            info = params.get('targetInfo', {})
            # Browser-level auto-attach also offers the main page that the base
            # runner has already attached. Two Fetch agents on one target would
            # mint two tickets for one wire request and strand unused authority.
            # Keep its existing gated session and detach the redundant offer.
            if (kind == 'page' and info.get('targetId') == self.main_target and
                    hasattr(self, 'session') and child != self.session):
                self.cdp.notify('Runtime.runIfWaitingForDebugger', {}, child)
                self.cdp.notify('Target.detachFromTarget', {'sessionId': child})
                return
            if kind == 'page' and info.get('targetId') != self.main_target and info.get('openerId') not in self.owned_pages:
                self.cdp.notify('Target.closeTarget', {'targetId': info.get('targetId')})
                return
            self.child_sessions[info.get('targetId')] = child
            self.child_target_types[info.get('targetId')] = kind
            self.cdp.notify('Fetch.enable', {'patterns': [{'urlPattern': '*', 'requestStage': 'Request'}]}, child)
            self.cdp.notify('Network.enable', {}, child)
            self.cdp.notify('Network.setBypassServiceWorker', {'bypass': True}, child)
            self.cdp.notify('Network.setCacheDisabled', {'cacheDisabled': True}, child)
            if kind == 'iframe':
                self.cdp.notify('Page.enable', {}, child)
            if kind == 'page':
                self.cdp.notify('Page.enable', {}, child)
                self.cdp.notify('Target.setAutoAttach', {'autoAttach': True,
                    'waitForDebuggerOnStart': True, 'flatten': True}, child)
                if hasattr(self, 'session'):
                    self.owned_pages.add(info['targetId'])
                    self.session = child
                    self.main_target = info['targetId']
                    self._invalidate()
            self.cdp.notify('Runtime.runIfWaitingForDebugger', {}, child)

        def _created(self, params, session):
            info = params.get('targetInfo', {})
            if info.get('type') == 'page' and self.main_target and info.get('targetId') != self.main_target:
                if info.get('openerId') not in self.owned_pages:
                    self.cdp.notify('Target.closeTarget', {'targetId': info.get('targetId')})
                    return
                self.channel.emit({'event': 'selected_popup', 'origin': origin(info.get('url')),
                                   'url_sha256': hashlib.sha256(str(info.get('url', '')).encode()).hexdigest(),
                                   **self.identity()})

        def _world(self, expression, context=None, await_promise=False, timeout=10, user_gesture=False):
            frame = (context or {}).get('frame_id') or self._frame()
            session = (context or {}).get('session') or self.session
            ident = self.cdp.call('Page.createIsolatedWorld', {'frameId': frame,
                'worldName': 'pp-selected-browser-v1'}, session)['executionContextId']
            result = self.cdp.call('Runtime.evaluate', {'expression': expression,
                'returnByValue': True, 'awaitPromise': await_promise, 'contextId': ident,
                'userGesture': user_gesture}, session, timeout)
            if result.get('exceptionDetails'):
                raise refused('BROWSER_SCRIPT_FAILED')
            return result.get('result', {}).get('value')

        def _target_world(self, ref, expression, **kwargs):
            context = self.frame_contexts.get(ref)
            if context is None:
                raise refused('ELEMENT_STALE')
            return self._world(expression, context, **kwargs)

        def _add_candidate(self, op, label):
            if op['kind'] not in self.config['permissions']['actions'] or len(self.candidates) >= MAX_CANDIDATES:
                return
            validate_operation(op, refused)
            ident = str(uuid.uuid4())
            body = {'snapshot_ref': self.snapshot['snapshot_ref'], 'operation': op,
                    'effect': 'external_change' if op['kind'] in EFFECTS else 'read',
                    'label': clean_text(label)}
            ref = {'id': ident, 'sha256': digest({**self.identity(), **body})}
            self.candidates[ident] = {'candidate_ref': ref, **body}
            return self.candidates[ident]

        def _form_digest(self, ref):
            private = self._target_world(ref, FORM_VALUES % json.dumps(ref))
            if private is None:
                return None
            result = digest(private)
            del private
            return result

        def observe_selected(self):
            self._check(capture=True)
            for key in list(self.temporary_destinations):
                self._destination(key)
            nonce = secrets.token_urlsafe(18)
            frame_tree = self.cdp.call('Page.getFrameTree', {}, self.session)['frameTree']
            frames = []
            def collect(tree):
                if len(frames) >= 8:
                    return
                frames.append({'frame_id': tree['frame']['id'], 'session': self.session})
                for child in tree.get('childFrames', []):
                    collect(child)
            collect(frame_tree)
            for target, session in list(self.child_sessions.items()):
                if self.child_target_types.get(target) != 'iframe' or len(frames) >= 8:
                    continue
                try:
                    child_tree = self.cdp.call('Page.getFrameTree', {}, session)['frameTree']
                    context = {'frame_id': child_tree['frame']['id'], 'session': session}
                    # OOPIF contexts are reachable through their own flattened
                    # session, not through a parent page's isolated world.
                    frames = [f for f in frames if f['frame_id'] != context['frame_id']]
                    frames.append(context)
                except refused:
                    continue
            self.frame_contexts = {}
            raw = None
            for index, context in enumerate(frames):
                try:
                    part = self._world(SNAPSHOT % (json.dumps(nonce + '_' + str(index)), MAX_ELEMENTS), context)
                except refused:
                    if index == 0:
                        raise
                    continue  # Detached/OOPIF frames are not silently guessed.
                if not isinstance(part, dict):
                    continue
                if (part.get('url') not in ('about:blank', 'about:srcdoc') and
                        origin(part.get('url')) not in self.ticketed_documents):
                    raise refused('OBSERVATION_DESTINATION_UNAUTHORIZED')
                for item in part['nodes'] + part['forms'] + part['resources']:
                    self.frame_contexts[item['ref']] = context
                self.frame_contexts[part['selection_ref']] = context
                if raw is None:
                    raw = part
                else:
                    raw['nodes'].extend(part['nodes'])
                    raw['forms'].extend(part['forms'])
                    raw['resources'].extend(part['resources'])
                    raw['text'] += '\n[Untrusted frame content]\n' + part['text']
            if not isinstance(raw, dict):
                raise refused('OBSERVATION_UNAVAILABLE')
            observation = {'untrusted': True, 'url': safe_url(raw.get('url', '')),
                           'title': clean_text(raw.get('title', '')),
                           'text': clean_text(raw.get('text', ''), min(MAX_TEXT_BYTES, self.config['model']['max_prompt_bytes'])),
                           'elements': [{'element_ref': n['ref'], 'kind': n['kind'], 'label': clean_text(n['label'])}
                                        for n in raw['nodes']],
                           'selection_ref': raw['selection_ref'], 'manual_auth': False}
            snap_body = {**self.identity(), 'observation': observation, 'nonce': nonce}
            self.snapshot = {'snapshot_ref': {'id': str(uuid.uuid4()), 'sha256': digest(snap_body)},
                             'observation': observation, 'raw': raw, 'created': time.monotonic()}
            self.candidates = {}
            self.input_targets = {}
            self.resources = {r['ref']: r for r in raw['resources']}
            self._add_candidate({'kind': 'read', 'scope': 'visible_page', 'selection_ref': None}, 'Read visible page')
            self._add_candidate({'kind': 'read', 'scope': 'selection', 'selection_ref': raw['selection_ref']}, 'Read visible text')
            self._add_candidate({'kind': 'copy', 'selection_ref': raw['selection_ref']}, 'Copy visible text to private clipboard')
            self._add_candidate({'kind': 'screenshot', 'area': 'viewport', 'selection_ref': None}, 'Capture private viewport')
            self._add_candidate({'kind': 'scroll', 'dx': 0, 'dy': 600}, 'Scroll down')
            self._add_candidate({'kind': 'scroll', 'dx': 0, 'dy': -600}, 'Scroll up')
            self._add_candidate({'kind': 'wait', 'max_ms': 250}, 'Wait briefly')
            for url in (self.config['destinations']['entry_urls'] +
                        ([self.proposed_navigation] if self.proposed_navigation else []) +
                        [n['href'] for n in raw['nodes'] if n['href']]):
                dest = self._destination(url)
                if dest and 'navigation' in dest['roles']:
                    self._add_candidate({'kind': 'navigate', 'destination_id': dest['id'], 'url': url}, 'Open ' + safe_url(url))
                elif dest is None and origin(url):
                    # This is a proposed visit, never a grant. Fetch pauses it
                    # for the host's exact destination/purpose escalation before
                    # target DNS/contact. A temporary grant leaves the base list.
                    ident = 'offlist-' + hashlib.sha256(origin(url).encode()).hexdigest()[:16]
                    self._add_candidate({'kind': 'navigate', 'destination_id': ident, 'url': url}, 'Request destination approval for ' + safe_url(url))
            for n in raw['nodes']:
                if n['kind'] == 'click' and n['tag'] != 'a':
                    self._add_candidate({'kind': 'click', 'element_ref': n['ref']}, 'Click ' + n['label'])
                if n['kind'] == 'input':
                    for kind in ('type', 'paste'):
                        if kind not in self.config['permissions']['actions'] or len(self.input_targets) >= 20:
                            continue
                        target = {'element_ref': n['ref'], 'kind': kind, 'label': clean_text(n['label'])}
                        ident = str(uuid.uuid4())
                        target['target_ref'] = {'id': ident, 'sha256': digest({**self.identity(),
                            'snapshot_ref': self.snapshot['snapshot_ref'], **target})}
                        self.input_targets[ident] = target
                    for binding in self.stage_bindings.values():
                        if binding['kind'] in ('input', 'clipboard'):
                            key = 'input_ref' if binding['kind'] == 'input' else 'clipboard_ref'
                            self._add_candidate({'kind': 'type' if key == 'input_ref' else 'paste',
                                                'element_ref': n['ref'], key: binding['ref']},
                                                'Enter approved private input into ' + n['label'])
                if n['kind'] == 'file':
                    for binding in self.stage_bindings.values():
                        if binding['kind'] == 'upload':
                            self._add_candidate({'kind': 'upload', 'element_ref': n['ref'], 'asset_ref': binding['ref']},
                                                'Attach approved asset to ' + n['label'])
            for r in raw['resources']:
                self._add_candidate({'kind': 'download', 'resource_ref': r['ref']}, 'Download private resource ' + r['label'])
            for f in raw['forms']:
                field_hash = self._form_digest(f['ref'])
                if field_hash:
                    self._add_candidate({'kind': 'submit', 'form_ref': f['ref'], 'field_set_sha256': field_hash}, 'Submit reviewed form')
            # A bounded, diverse slate prevents a large page from monopolizing
            # the model prompt with links. At least one candidate of every
            # currently possible primitive is kept; further variants round-robin.
            groups = {k: [c for c in self.candidates.values() if c['operation']['kind'] == k] for k in OP_KEYS}
            exposed = []
            while len(exposed) < 20 and any(groups.values()):
                for group in groups.values():
                    if group and len(exposed) < 20:
                        c = group.pop(0)
                        exposed.append({k: v for k, v in c.items() if k != 'snapshot_ref'})
            bounded = {**observation, 'text': clean_text(observation['text'], 4000), 'elements': observation['elements'][:12], 'truncated': len(observation['text'].encode()) > 4000 or len(observation['elements']) > 12}
            while len(canonical(bounded).encode()) > 6000 and bounded['elements']:
                bounded['elements'].pop()
                bounded['truncated'] = True
            # The full operation is for the trusted coordinator. A model adapter
            # receives only ref/kind/effect/label, never staged bytes or URLs.
            return {'snapshot_ref': self.snapshot['snapshot_ref'], 'observation': canonical(bounded),
                    'candidates': exposed, 'source_refs': [], 'input_targets': list(self.input_targets.values()),
                    'page': {'origin': origin(raw['url']), 'url_sha256': hashlib.sha256(raw['url'].encode()).hexdigest()}
                    if origin(raw['url']) else None}

        def offer_input(self, value):
            """Bind human-reviewed staged bytes to one current opaque DOM target.

            A model draft does not enter the browser via this method. The host
            first reviews/approves it, stages exact private bytes through F1,
            then calls here. This method cannot select a DOM node or invent data.
            """
            self._check(capture=True, allow_paused=True)
            if (not isinstance(value, dict) or set(value) != {'snapshot_ref', 'target_ref', 'input_ref'} or
                    any(not pinned_ref(value[k]) for k in value)):
                raise refused('INVALID_INPUT_OFFER')
            if not self.snapshot or self.snapshot['snapshot_ref'] != value['snapshot_ref']:
                raise refused('SNAPSHOT_STALE')
            target = self.input_targets.get(value['target_ref']['id'])
            if not target or target['target_ref'] != value['target_ref']:
                raise refused('INPUT_TARGET_STALE')
            check = self._element_expression(target['element_ref'], 'return true;')
            if self._target_world(target['element_ref'], check) is not True:
                raise refused('ELEMENT_STALE')
            kind = target['kind']
            binding = self._binding(value['input_ref'], 'input' if kind == 'type' else 'clipboard')
            binding['single_use'] = True
            candidate = self._add_candidate({'kind': kind, 'element_ref': target['element_ref'],
                'input_ref' if kind == 'type' else 'clipboard_ref': value['input_ref']},
                'Enter approved private text into ' + target['label'])
            if candidate is None:
                raise refused('CANDIDATE_LIMIT')
            self.input_targets.pop(value['target_ref']['id'])
            return {k: v for k, v in candidate.items() if k != 'snapshot_ref'}

        def discard_stage(self, ref):
            if not pinned_ref(ref) and not pinned_ref(ref, True):
                raise refused('INVALID_STAGE_REFERENCE')
            value = self.stage_bindings.get(ref['id'])
            if not value or value['ref'] != ref:
                return {'discarded': False}
            value['data'][:] = b'\0' * len(value['data'])
            self.stage_bindings.pop(ref['id'])
            self._invalidate()
            return {'discarded': True}

        def stage(self, value):
            self._check(capture=True, allow_paused=True)
            if not isinstance(value, dict) or set(value) != {'kind', 'ref', 'mime_type', 'bytes_base64'}:
                raise refused('INVALID_STAGE')
            kind, ref = value['kind'], value['ref']
            if kind not in ('input', 'clipboard', 'upload') or not pinned_ref(ref, kind == 'upload'):
                raise refused('INVALID_STAGE')
            maximum = self.config['artifacts']['upload_max_bytes'] if kind == 'upload' else self.config['artifacts']['clipboard']['max_bytes']
            if not isinstance(value['bytes_base64'], str) or len(value['bytes_base64']) > maximum * 4 // 3 + 8:
                raise refused('STAGE_LIMIT')
            try:
                data = base64.b64decode(value['bytes_base64'], validate=True)
            except (ValueError, TypeError) as error:
                raise refused('INVALID_STAGE') from error
            if not data or len(data) > maximum or hashlib.sha256(data).hexdigest() != ref['sha256']:
                raise refused('STAGE_HASH_MISMATCH')
            if kind == 'upload':
                if ref not in self.config['artifacts']['upload_asset_refs'] or len(data) != ref['byte_count'] or value['mime_type'] != ref['mime_type']:
                    raise refused('ASSET_NOT_PINNED')
            else:
                if value['mime_type'] != 'text/plain':
                    raise refused('INVALID_STAGE')
                try:
                    data.decode('utf-8')
                except UnicodeError as error:
                    raise refused('INVALID_STAGE') from error
            if ref['id'] in self.stage_bindings and self.stage_bindings[ref['id']]['ref'] != ref:
                raise refused('STAGE_PIN_CONFLICT')
            if sum(len(v['data']) for k, v in self.stage_bindings.items() if k != ref['id']) + len(data) > self.config['budgets']['max_artifact_bytes']:
                raise refused('STAGE_LIMIT')
            old = self.stage_bindings.get(ref['id'])
            if old:
                old['data'][:] = b'\0' * len(old['data'])
            self.stage_bindings[ref['id']] = {'kind': kind, 'ref': ref.copy(), 'data': bytearray(data), 'mime_type': value['mime_type']}
            return {'staged': True, 'ref': ref.copy()}

        def _binding(self, ref, kind):
            value = self.stage_bindings.get(ref['id'])
            if not value or value['ref'] != ref or value['kind'] != kind or hashlib.sha256(value['data']).hexdigest() != ref['sha256']:
                raise refused('STAGE_REFERENCE_STALE')
            return value

        def _artifact(self, kind, data, mime):
            self._check(capture=True)
            maximum = (self.config['artifacts']['clipboard']['max_bytes'] if kind == 'clipboard' else
                       self.config['artifacts']['download_max_bytes'])
            if len(data) > maximum or self.artifact_bytes + len(data) > self.config['budgets']['max_artifact_bytes']:
                raise refused('ARTIFACT_LIMIT')
            self.artifact_bytes += len(data)
            return {'artifact': {'kind': kind, 'mime_type': mime, 'byte_count': len(data),
                                 'sha256': hashlib.sha256(data).hexdigest(),
                                 'bytes_base64': base64.b64encode(data).decode('ascii')}}

        def execute_selected(self, envelope):
            self._check(capture=True)
            if validate_action is not None:
                try:
                    validate_action(envelope)
                except Exception as error:
                    raise refused('INVALID_SELECTED_ENVELOPE') from error
            if (not isinstance(envelope, dict) or set(envelope) != ENVELOPE_KEYS or
                    envelope.get('schema') != 'proxypilot.browser-action.proposal.v1' or
                    any(envelope.get(k) != v for k, v in self.identity().items()) or
                    type(envelope.get('ordinal')) is not int or envelope['ordinal'] != self.next_ordinal or
                    not pinned_ref(envelope.get('snapshot_ref')) or not pinned_ref(envelope.get('candidate_ref')) or
                    (envelope.get('approval_ref') is not None and not pinned_ref(envelope['approval_ref']))):
                raise refused('INVALID_SELECTED_ENVELOPE')
            if not self.snapshot or self.snapshot['snapshot_ref'] != envelope['snapshot_ref']:
                raise refused('SNAPSHOT_STALE')
            if time.monotonic() - self.snapshot['created'] > 60:
                raise refused('SNAPSHOT_STALE')
            candidate = self.candidates.get(envelope['candidate_ref']['id'])
            if not candidate or candidate['candidate_ref'] != envelope['candidate_ref'] or candidate['operation'] != envelope['operation']:
                raise refused('CANDIDATE_STALE')
            op = validate_operation(envelope['operation'], refused)
            if op['kind'] not in self.config['permissions']['actions']:
                raise refused('ACTION_NOT_CONFIGURED')
            if op['kind'] in EFFECTS and envelope['approval_ref'] is None:
                raise refused('APPROVAL_REQUIRED')
            if envelope['ordinal'] > self.config['budgets']['max_actions']:
                raise refused('ACTION_LIMIT')
            # Page changes invalidate DOM targets. Even read/scroll cannot reuse
            # a candidate from a previous action or a different page document.
            if self._world('globalThis.__ppSelected?.href === location.href') is not True:
                raise refused('SNAPSHOT_STALE')
            self.current_action = {'ordinal': envelope['ordinal'], 'snapshot_ref': envelope['snapshot_ref'],
                                   'candidate_ref': envelope['candidate_ref'], 'approval_ref': envelope['approval_ref']}
            self.next_ordinal += 1  # No replay, including a timed-out/uncertain effect.
            try:
                result = self._perform(op)
                self._check(capture=True)
                return {'kind': op['kind'], 'status': 'done', 'untrusted': True, **result}
            finally:
                self.current_action = None
                self._invalidate()

        def _element_expression(self, ref, body):
            return "(() => {const ref=%s,s=globalThis.__ppSelected,e=s?.registry.get(ref);if(!e||!e.isConnected||s.href!==location.href||s.fingerprints.get(ref)!==s.fingerprint(e))return false;%s})()" % (json.dumps(ref), body)

        def _perform(self, op):
            kind = op['kind']
            raw = self.snapshot['raw']
            if kind == 'navigate':
                dest = self._destination(op['url'])
                offlist_id = 'offlist-' + hashlib.sha256(origin(op['url']).encode()).hexdigest()[:16]
                if (dest and (dest['id'] != op['destination_id'] or 'navigation' not in dest['roles']) or
                        dest is None and op['destination_id'] != offlist_id):
                    raise refused('DESTINATION_NOT_SELECTED')
                loaded = threading.Event()
                self.proposed_navigation = op['url']
                self.navigation_load = (self.session, loaded)
                try:
                    # Human payload/destination approval is bounded by the
                    # attempt deadline, not the demo's ten-second CDP timeout.
                    # Host pause fails held requests before queueing its command;
                    # host cancellation independently revokes/kills this guest.
                    result = self.cdp.call('Page.navigate', {'url': op['url']}, self.session,
                                           timeout=self._remaining_seconds())
                    if result.get('errorText'):
                        raise refused('BROWSER_NAVIGATION_FAILED')
                    while not loaded.wait(min(0.1, self._remaining_seconds())):
                        self._check()
                    self._check()
                    self.proposed_navigation = None
                    return {'page_url': safe_url(self.isolated('location.href'))}
                finally:
                    self.navigation_load = None
            if kind == 'read':
                if op['selection_ref'] not in (None, raw['selection_ref']):
                    raise refused('SELECTION_STALE')
                return {'text': self.snapshot['observation']['text'], 'page_url': self.snapshot['observation']['url']}
            if kind == 'scroll':
                self.isolated('window.scrollBy(%d,%d);true' % (op['dx'], op['dy']))
                return {}
            if kind == 'wait':
                deadline = time.monotonic() + op['max_ms'] / 1000
                while time.monotonic() < deadline:
                    self._check(capture=True)
                    time.sleep(max(0, min(0.05, deadline - time.monotonic())))
                return {}
            if kind == 'copy':
                if op['selection_ref'] != raw['selection_ref']:
                    raise refused('SELECTION_STALE')
                return self._artifact('clipboard', self.snapshot['observation']['text'].encode(), 'text/plain')
            if kind == 'screenshot':
                params = {'format': 'png', 'captureBeyondViewport': False}
                if op['area'] == 'selection':
                    if op['selection_ref'] != raw['selection_ref']:
                        raise refused('SELECTION_STALE')
                    raise refused('SELECTION_SCREENSHOT_UNAVAILABLE')
                data = base64.b64decode(self.cdp.call('Page.captureScreenshot', params, self.session)['data'], validate=True)
                return self._artifact('screenshot', data, 'image/png')
            if kind == 'download':
                resource = self.resources.get(op['resource_ref'])
                if not resource:
                    raise refused('RESOURCE_STALE')
                max_bytes = self.config['artifacts']['download_max_bytes']
                # Typed fetch remains subject to every Fetch/gateway request gate.
                expression = '''(async()=>{const r=await fetch(%s,{credentials:'same-origin',redirect:'follow',cache:'no-store',signal:AbortSignal.timeout(10000)});
                  if(!r.ok||!r.body)return {ok:false};const reader=r.body.getReader();let count=0,chunks=[];
                  for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;
                    if(count>%d){await reader.cancel();return {too_large:true};}chunks.push(value);}
                  const bytes=new Uint8Array(count);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
                  let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
                  return {ok:true,mime:(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase(),data:btoa(text)};})()''' % (json.dumps(resource['url']), max_bytes)
                value = self._target_world(op['resource_ref'], expression, await_promise=True, timeout=12)
                if value.get('too_large'):
                    raise refused('ARTIFACT_LIMIT')
                if not value.get('ok') or value.get('mime') not in self.config['artifacts']['download_mime_types']:
                    raise refused('DOWNLOAD_NOT_PERMITTED')
                return self._artifact('download', base64.b64decode(value['data'], validate=True), value['mime'])
            if kind == 'submit':
                if self._form_digest(op['form_ref']) != op['field_set_sha256']:
                    raise refused('FORM_CHANGED')
                expression = self._element_expression(op['form_ref'], "if(e.tagName!=='FORM')return false;e.requestSubmit();return true;")
            elif kind == 'click':
                expression = self._element_expression(op['element_ref'], "e.click();return true;")
            elif kind in ('type', 'paste'):
                key = 'input_ref' if kind == 'type' else 'clipboard_ref'
                binding = self._binding(op[key], 'input' if kind == 'type' else 'clipboard')
                text = bytes(binding['data']).decode('utf-8')
                if binding.get('single_use'):
                    binding['data'][:] = b'\0' * len(binding['data'])
                    self.stage_bindings.pop(op[key]['id'])
                expression = self._element_expression(op['element_ref'], '''
                    if(/password|passwd|secret|token|otp|one.time|verification.code|credit.card|cvv|cvc|ssn/i.test([e.type,e.name,e.id,e.autocomplete].join(' ')))return false;
                    const text=%s;e.focus();
                    if(e.isContentEditable)e.textContent=text;
                    else if(e.tagName==='SELECT') {
                      const options=[...e.options].filter(o=>o.value===text||o.text===text);if(options.length!==1)return false;
                      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,options[0].value);
                    }
                    else {const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
                      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(!setter)return false;setter.call(e,text);}
                    e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;
                    ''' % json.dumps(text))
                del text
            elif kind == 'upload':
                binding = self._binding(op['asset_ref'], 'upload')
                extension = {'text/plain': '.txt', 'text/csv': '.csv', 'application/pdf': '.pdf',
                             'image/png': '.png', 'image/jpeg': '.jpg'}.get(binding['mime_type'], '.bin')
                expression = self._element_expression(op['element_ref'], '''
                    if(e.tagName!=='INPUT'||e.type!=='file')return false;
                    const binary=atob(%s),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
                    const file=new File([bytes],%s,{type:%s}),dt=new DataTransfer();dt.items.add(file);e.files=dt.files;
                    e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;
                    ''' % (json.dumps(base64.b64encode(binding['data']).decode()),
                           json.dumps('approved-' + op['asset_ref']['id'] + extension), json.dumps(binding['mime_type'])))
            else:
                raise refused('INVALID_SELECTED_ACTION')
            target = op.get('form_ref') or op.get('element_ref')
            if kind != 'submit':
                if self._target_world(target, expression, user_gesture=True) is not True:
                    raise refused('ELEMENT_STALE')
                return {'effect': 'unverified_until_gateway_and_site_readback'}
            loaded = threading.Event()
            network = {'observed': threading.Event(), 'document': False}
            self.submission_network = network
            self.navigation_load = (self.session, loaded)
            try:
                if self._target_world(target, expression, user_gesture=True) is not True:
                    raise refused('ELEMENT_STALE')
                # requestSubmit returns before Chromium emits Fetch. Keep this
                # action's refs live through review and native page load; a DOM
                # return alone cannot settle a submission or permit a replay.
                trigger_deadline = time.monotonic()+min(3, self._remaining_seconds())
                while not network['observed'].wait(.02):
                    self._check()
                    if time.monotonic() >= trigger_deadline:
                        raise refused('SUBMISSION_NETWORK_NOT_OBSERVED')
                while True:
                    self._check()
                    with self.request_lock:
                        pending = bool(self.requests)
                    if not pending and (not network['document'] or loaded.is_set()):
                        break
                    loaded.wait(min(.02,self._remaining_seconds()))
                return {'effect': 'unverified_until_gateway_and_site_readback'}
            finally:
                self.submission_network = None
                self.navigation_load = None

        def auth(self, active):
            if type(active) is not bool:
                raise refused('INVALID_AUTH_STATE')
            self.manual_auth = active
            self._invalidate()
            return {'manual_auth': active, 'observations_enabled': not active, 'model_enabled': not active}

        def rebind(self, value):
            keys = {'run_id', 'attempt_id', 'old_fence', 'new_fence', 'policy_sha256'}
            if (not isinstance(value, dict) or set(value) != keys or
                    any(value.get(k) != self.selected[k] for k in ('run_id', 'attempt_id', 'policy_sha256')) or
                    type(value['old_fence']) is not int or value['old_fence'] != self.selected['fence'] or
                    type(value['new_fence']) is not int or not value['old_fence'] < value['new_fence'] <= 2147483647):
                raise refused('STALE_FENCE')
            # Only host-verified custody changes may call this. Outstanding old
            # requests, references and private input bytes do not cross a fence.
            self.pause_selected()
            for binding in self.stage_bindings.values():
                binding['data'][:] = b'\0' * len(binding['data'])
            self.stage_bindings.clear()
            self.current_action = None
            self.selected = {**self.selected, 'fence': value['new_fence']}
            return {**self.identity(), 'paused': True, 'fresh_observation_required': True}

        def pause_selected(self):
            self.paused = True
            self._invalidate()
            # A refused initial navigation may have no active renderer yet.
            # The paused request gate is effective immediately; stopLoading is
            # best effort, while signed cleanup remains the host's responsibility.
            self.cdp.notify('Page.stopLoading', {}, self.session)
            with self.request_lock:
                pending = list(self.requests)
            for ref in pending:
                self.request_decision({'request_ref': ref, 'decision': 'block', 'code': 'SELECTED_PAUSED'})
            # The supervisor persists these tombstones before any resume so a
            # queued pre-pause event cannot mint authority for a failed Fetch.
            return {'paused': True, 'discarded_request_refs': pending}

        def resume_selected(self):
            self.paused = False
            self.frozen = False
            self._invalidate()
            self._check(capture=False)
            try:
                url = self._world('location.href')
                reset = url != 'about:blank' and origin(url) not in self.ticketed_documents
            except refused as error:
                if error.code != 'BROWSER_PROTOCOL':
                    raise
                reset = True  # Refused first navigation can lack an active page.
            if reset:
                # Restore only an internal blank document. Retained URL becomes
                # a fresh proposal; no external request is retried on resume.
                result = self.cdp.call('Page.navigate', {'url': 'about:blank'}, self.session)
                if result.get('errorText'):
                    raise refused('BROWSER_NAVIGATION_FAILED')
            return {'resumed': True, 'fresh_observation_required': True}

        def view(self):
            self._check(capture=True, allow_paused=True)
            url = self.isolated('location.href')
            if url != 'about:blank' and origin(url) not in self.ticketed_documents:
                raise refused('OBSERVATION_DESTINATION_UNAUTHORIZED')
            value = super().view()
            value['untrusted_page_url'] = safe_url(value['untrusted_page_url']) if value['untrusted_page_url'] else None
            return value

        def diagnostics(self, *args):
            # Arbitrary websites can log private text to Chromium stderr. That
            # tail must never become a receipt, dashboard error or model input.
            return 'Selected browser diagnostic details withheld'

        def human_input(self, value):
            self._check(allow_paused=True)
            self._invalidate()
            # The host owns controller custody and approves consequential
            # requests even while the user directly controls the page.
            return super().human_input(value)

        def close(self):
            self.request_watchdog_stop.set()
            with self.request_lock:
                self.requests.clear()
            for binding in self.stage_bindings.values():
                binding['data'][:] = b'\0' * len(binding['data'])
            self.stage_bindings.clear()
            self.temporary_destinations.clear()
            return super().close()

    return SelectedBrowser
