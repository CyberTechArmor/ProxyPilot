"""Host-owned exact destination policy for selected_browser_v1.

This module does no I/O. A saved proposal is not a network plan. Only the
installed supervisor may supply a freshly reviewed, exact-address route plan;
neither the guest nor a proposal's network_policy_ref is authority.
"""
import copy
import hashlib
import ipaddress
import json
import re
import time
from urllib.parse import parse_qsl, unquote, urlsplit

HEX = re.compile(r'[0-9a-f]{64}\Z')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
RESOURCE_TYPES = frozenset(('document', 'stylesheet', 'script', 'image', 'font',
                            'media', 'xhr', 'fetch', 'other'))
METHODS = frozenset(('GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'))
PROTECTED_NAMES = re.compile(r'(?:^|[.-])(?:metadata|openbao|vaultwarden|infisical|proxypilot|vault)(?:[.-]|$)', re.I)
PROTECTED_PATHS = re.compile(r'^/(?:v1/(?:sys|auth|secret|kv)|api/(?:security|lxc|self|setup|mcp|terminal|operations-settings))(?:/|$)', re.I)
INTERNAL_V4 = tuple(ipaddress.ip_network(v) for v in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'))


class Denied(ValueError):
    """Errors contain a fixed code, never page values, body bytes or credentials."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def strict_json(text):
    def object_pairs(pairs):
        result = {}
        for k, v in pairs:
            if k in result:
                raise Denied('DUPLICATE_JSON_KEY')
            result[k] = v
        return result
    try:
        return json.loads(text, object_pairs_hook=object_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(Denied('INVALID_JSON')))
    except (ValueError, TypeError) as e:
        raise Denied('INVALID_JSON') from e


def exact(value, names):
    return isinstance(value, dict) and set(value) == set(names)


def safe_int(value, low, high):
    return type(value) is int and low <= value <= high


def url_parts(value, origin_only=False):
    # Refuse ambiguous forms rather than resolve them differently from Chromium.
    if (not isinstance(value, str) or not 8 <= len(value) <= 2048 or
            re.search(r'[\s\\\x00-\x1f\x7f]', value) or re.search(r'%(?![0-9a-fA-F]{2})', value)):
        raise Denied('URL_INVALID')
    try:
        p = urlsplit(value)
        if (p.scheme not in ('http', 'https') or not value.startswith(p.scheme + '://') or not p.hostname
                or p.username is not None or p.password is not None):
            raise Denied('URL_INVALID')
        host, port = p.hostname, p.port or (443 if p.scheme == 'https' else 80)
        if (p.netloc != p.netloc.lower() or host.endswith('.') or '@' in p.netloc or '%' in p.netloc
                or not 1 <= port <= 65535):
            raise Denied('URL_INVALID')
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None:
            if str(address) != host:
                raise Denied('URL_INVALID')
            host_wire = '[' + host + ']' if address.version == 6 else host
        else:
            if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*', host):
                raise Denied('URL_INVALID')
            # IPv4 shorthand and legacy octal/hex can become another address in Chrome.
            if re.search(r'(?:^|\.)(?:[0-9]+|0x[0-9a-f]+)$', host):
                raise Denied('URL_INVALID')
            host_wire = host
        authority = host_wire + (':' + str(port) if port != (443 if p.scheme == 'https' else 80) else '')
        origin = p.scheme + '://' + authority
        if p.netloc != authority or (origin_only and value != origin):
            raise Denied('URL_INVALID')
        path = p.path or '/'
        # Encoded path separators and nested escapes make prefix policy ambiguous.
        decoded = unquote(path, errors='strict')
        if (not path.startswith('/') or path.startswith('//') or '\\' in decoded or
                re.search(r'%(?:2f|5c|25|00)', path, re.I) or
                any(c in ('.', '..') for c in decoded.split('/')) or
                re.search(r'[\x00-\x1f\x7f]', decoded)):
            raise Denied('URL_PATH_INVALID')
        # The fragment is never sent to the origin.
        target = path + ('?' + p.query if p.query else '')
        target.encode('ascii')  # Browser wire URLs must be percent encoded.
        return dict(origin=origin, host=host, port=port, scheme=p.scheme,
                    path=decoded, query=p.query, target=target, url=origin + target)
    except (ValueError, UnicodeError) as e:
        if isinstance(e, Denied):
            raise
        raise Denied('URL_INVALID') from e


def address_scope(value):
    try:
        a = ipaddress.ip_address(value)
    except ValueError as e:
        raise Denied('ADDRESS_INVALID') from e
    if str(a) != value:
        raise Denied('ADDRESS_INVALID')
    # Loopback, metadata/link-local, IPv4 mapping and transition mechanisms can
    # never be enabled by an internal target plan or temporary exception.
    if (a.is_loopback or a.is_link_local or a.is_unspecified or a.is_multicast or a.is_reserved or
            (a.version == 6 and (a.ipv4_mapped or a.sixtofour or a.teredo or a in ipaddress.ip_network('64:ff9b::/96')))):
        raise Denied('PROTECTED_ADDRESS')
    if a.version == 4 and any(a in n for n in INTERNAL_V4):
        return 'internal'
    if a.version == 6 and a in ipaddress.ip_network('fc00::/7'):
        return 'internal'
    if not a.is_global:
        raise Denied('PROTECTED_ADDRESS')
    return 'public'


def build_public_target(origin, answers, route_sha256, protected_hosts, protected_addresses):
    """Pure helper AFTER explicit run/destination approval and host DNS/route readback.

    No network access is performed here. A public host does not need a manually
    enrolled network_policy_ref: the installed host can derive this exact plan
    from screened DNS plus its fresh route observation. Internal addresses are
    refused by this helper and need their separate exact reviewed route policy.
    """
    parts = url_parts(origin, origin_only=True)
    host = parts['host']
    if (not protected_hosts or not protected_addresses or PROTECTED_NAMES.search(host) or
            host == 'localhost' or host.endswith('.localhost') or
            any(host == h or host.endswith('.' + h) for h in protected_hosts)):
        raise Denied('PROTECTED_DESTINATION')
    if not isinstance(route_sha256, str) or not HEX.fullmatch(route_sha256):
        raise Denied('NETWORK_ROUTE_UNVERIFIED')
    if not isinstance(answers, list) or not 1 <= len(answers) <= 32:
        raise Denied('NETWORK_TARGET_UNVERIFIED')
    clean = []
    for address in answers:
        if address_scope(address) != 'public' or address in protected_addresses:
            raise Denied('NETWORK_ADDRESS_DENIED')
        if address not in clean:
            clean.append(address)
    if len(clean) > 16:
        raise Denied('NETWORK_TARGET_UNVERIFIED')
    try:
        literal = str(ipaddress.ip_address(host))
    except ValueError:
        literal = None
    if literal is not None and clean != [literal]:
        raise Denied('NETWORK_LITERAL_MISMATCH')
    return dict(origin=origin, scope='public', addresses=clean, port=parts['port'],
                route_sha256=route_sha256, reviewed=True)


class GatewayPolicy:
    def __init__(self, configuration, network_plan, identity, configuration_json=None, clock=time.time):
        self.clock = clock
        if not exact(identity, ('project_id', 'run_id', 'attempt_id', 'fence', 'policy_sha256')):
            raise Denied('IDENTITY_INVALID')
        if (any(not isinstance(identity[k], str) or not UUID.fullmatch(identity[k])
                for k in ('project_id', 'run_id', 'attempt_id')) or
                not safe_int(identity['fence'], 1, 2147483647) or
                not isinstance(identity['policy_sha256'], str) or not HEX.fullmatch(identity['policy_sha256'])):
            raise Denied('IDENTITY_INVALID')
        # Use the server's exact canonical bytes; Python need not reinterpret JS
        # floating-point serialization or Unicode key order to verify the pin.
        text = canonical(configuration) if configuration_json is None else configuration_json
        if (not isinstance(text, str) or len(text.encode()) > 200000 or
                strict_json(text) != configuration or digest(text) != identity['policy_sha256']):
            raise Denied('POLICY_HASH_MISMATCH')
        self.public_navigation=configuration.get('mode')=='public_navigation'
        self._configuration = copy.deepcopy(configuration)
        self.identity = copy.deepcopy(identity)
        self.configuration_json = text
        if configuration.get('workflow') != 'selected_browser_v1':
            raise Denied('WORKFLOW_INVALID')
        d = configuration.get('destinations', {})
        if (d.get('network_scope') != 'explicit_destinations' or d.get('off_list') != 'pause_and_escalate_before_send'
                or d.get('off_list_approval') != dict(scope='exact_destination_and_purpose', lifetime='attempt',
                                                     persist_to_allowlist=False, wildcards=False)
                or d.get('subresources') != 'explicit_origins_only' or d.get('redirects') != 'same_policy'
                or d.get('popups') != 'same_policy' or d.get('unclassified_requests') != 'pause_and_escalate_before_send'
                or d.get('websockets') != 'blocked_pending_selected_site_transport_review'
                or configuration.get('permissions', {}).get('external_change_approval') != 'per_action'
                or configuration.get('permissions', {}).get('preauthorization_refs') != []):
            raise Denied('POLICY_UNSAFE')
        if not exact(network_plan, ('schema', 'expires_at', 'targets', 'protected_hosts', 'protected_addresses')):
            raise Denied('NETWORK_PLAN_INVALID')
        if (network_plan['schema'] != 'proxypilot.selected-browser.network-plan.v1' or
                not safe_int(network_plan['expires_at'], 1, 2**53 - 1) or network_plan['expires_at'] <= clock()):
            raise Denied('NETWORK_PLAN_EXPIRED')
        self.expires_at = network_plan['expires_at']
        self.network_plan_sha256 = digest(canonical(network_plan))
        self.protected_hosts = tuple(network_plan['protected_hosts'])
        self.protected_addresses = frozenset(network_plan['protected_addresses'])
        if (not self.protected_hosts or not self.protected_addresses or
                any(not isinstance(h, str) or not h or h != h.lower() or h.endswith('.') or '*' in h
                    for h in self.protected_hosts)):
            raise Denied('PROTECTED_INVENTORY_REQUIRED')
        for a in self.protected_addresses:
            if not isinstance(a, str) or str(ipaddress.ip_address(a)) != a:
                raise Denied('PROTECTED_INVENTORY_INVALID')
        self.origins = {}
        for entry in d.get('allowed_origins', []):
            item = self.validate_destination(entry)
            if item['origin'] in self.origins or any(x['id'] == item['id'] for x in self.origins.values()):
                raise Denied('DESTINATION_DUPLICATE')
            self.origins[item['origin']] = item
        if not 1 <= len(self.origins) <= 64:
            raise Denied('DESTINATION_INVALID')
        self.targets = {}
        for target in network_plan['targets']:
            item = self.validate_target(target)
            if item['origin'] in self.targets:
                raise Denied('NETWORK_TARGET_DUPLICATE')
            self.targets[item['origin']] = item
        if set(self.targets) != set(self.origins):
            raise Denied('NETWORK_TARGET_MISMATCH')
        self.rules = tuple(copy.deepcopy(d.get('request_rules', [])))
        self._validate_rules(self.rules)

    @property
    def configuration(self):
        return copy.deepcopy(self._configuration)

    def check_fresh(self):
        if self.clock() >= self.expires_at:
            raise Denied('NETWORK_PLAN_EXPIRED')

    def protected_url(self, parts):
        host = parts['host']
        if (host == 'localhost' or host.endswith('.localhost') or PROTECTED_NAMES.search(host) or
                any(host == h or host.endswith('.' + h) for h in self.protected_hosts) or
                PROTECTED_PATHS.search(parts['path'])):
            raise Denied('PROTECTED_DESTINATION')
        try:
            a = ipaddress.ip_address(host)
        except ValueError:
            return
        address_scope(str(a))
        if str(a) in self.protected_addresses:
            raise Denied('PROTECTED_ADDRESS')

    def validate_destination(self, entry):
        if (not exact(entry, ('id', 'origin', 'roles', 'session_headers')) or
                not isinstance(entry['id'], str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', entry['id'])):
            raise Denied('DESTINATION_INVALID')
        p = url_parts(entry['origin'], origin_only=True)
        self.protected_url(p)
        if (not isinstance(entry['roles'], list) or not 1 <= len(entry['roles']) <= 3 or
                len(set(entry['roles'])) != len(entry['roles']) or
                set(entry['roles']) - {'navigation', 'resource', 'authentication'} or
                entry['session_headers'] not in ('omit', 'this_origin_session') or
                (entry['roles'] == ['resource'] and entry['session_headers'] != 'omit') or
                (p['scheme'] == 'http' and (entry['session_headers'] != 'omit' or 'authentication' in entry['roles']))):
            raise Denied('DESTINATION_INVALID')
        return copy.deepcopy(entry)

    def validate_target(self, target):
        if (not exact(target, ('origin', 'scope', 'addresses', 'port', 'route_sha256', 'reviewed')) or
                target['scope'] not in ('public', 'internal') or target['reviewed'] is not True or
                not isinstance(target['route_sha256'], str) or not HEX.fullmatch(target['route_sha256']) or
                not isinstance(target['addresses'], list) or not 1 <= len(target['addresses']) <= 16 or
                len(set(target['addresses'])) != len(target['addresses'])):
            raise Denied('NETWORK_TARGET_UNVERIFIED')
        p = url_parts(target['origin'], origin_only=True)
        self.protected_url(p)
        if type(target['port']) is not int or p['port'] != target['port']:
            raise Denied('NETWORK_PORT_MISMATCH')
        for address in target['addresses']:
            if address_scope(address) != target['scope'] or address in self.protected_addresses:
                raise Denied('NETWORK_ADDRESS_DENIED')
        try:
            literal = str(ipaddress.ip_address(p['host']))
        except ValueError:
            literal = None
        if literal is not None and target['addresses'] != [literal]:
            raise Denied('NETWORK_LITERAL_MISMATCH')
        return copy.deepcopy(target)

    def _validate_rules(self, rules):
        ids = set()
        dest_ids = {o['id'] for o in self.origins.values()}
        if len(rules) > 128:
            raise Denied('REQUEST_RULE_INVALID')
        for r in rules:
            if (not exact(r, ('id', 'destination_id', 'path_prefix', 'methods', 'query_keys', 'resource_types',
                             'effect', 'max_request_bytes')) or r['id'] in ids or
                    r['destination_id'] not in dest_ids or r['effect'] not in ('read', 'external_change', 'unclassified') or
                    not safe_int(r['max_request_bytes'], 0, 67108864) or not r['methods'] or
                    set(r['methods']) - METHODS or not r['resource_types'] or set(r['resource_types']) - RESOURCE_TYPES or
                    (r['effect'] == 'read' and set(r['methods']) - {'GET', 'HEAD', 'OPTIONS'})):
                raise Denied('REQUEST_RULE_INVALID')
            p = url_parts('https://rule.example' + r['path_prefix'])
            if p['target'] != r['path_prefix'] or p['path'] != r['path_prefix']:
                raise Denied('REQUEST_RULE_INVALID')
            if (not isinstance(r['query_keys'], list) or len(r['query_keys']) > 32 or
                    any(not isinstance(k, str) or not 1 <= len(k) <= 100 for k in r['query_keys'])):
                raise Denied('REQUEST_RULE_INVALID')
            ids.add(r['id'])

    def destination(self, parts, role, additions=None):
        self.check_fresh()
        self.protected_url(parts)
        if self.public_navigation:
            if role not in ('navigation','resource') or parts['port'] not in (80,443):raise Denied('PUBLIC_DESTINATION_DENIED')
            return dict(id='public-'+digest(parts['origin'])[:32],origin=parts['origin'],roles=['navigation','resource'],session_headers='omit')
        base = self.origins.get(parts['origin'])
        temporary = (additions or {}).get(parts['origin'])
        if temporary is not None and 'roles' not in temporary:
            temporary = temporary.get(role)
        if base is None and temporary is None:
            raise Denied('OFF_LIST_DESTINATION')
        item = base if base is not None and role in base['roles'] else temporary
        if item is None or role not in item['roles']:
            raise Denied('DESTINATION_ROLE_DENIED')
        return copy.deepcopy(item)

    def classify(self, parts, destination, method, resource_type, body_bytes):
        if self.public_navigation:
            if method not in ('GET','HEAD','OPTIONS') or body_bytes!=0:raise Denied('PUBLIC_WRITE_DISABLED')
            return 'read'
        # All overlaps count. A narrow read rule cannot shadow a wider write rule.
        keys = {k for k, _ in parse_qsl(parts['query'], keep_blank_values=True, strict_parsing=False)}
        matches = [r for r in self.rules if r['destination_id'] == destination['id'] and
                   parts['path'].startswith(r['path_prefix']) and method in r['methods'] and
                   resource_type in r['resource_types'] and keys <= set(r['query_keys']) and
                   body_bytes <= r['max_request_bytes']]
        if not matches or any(r['effect'] == 'unclassified' for r in matches):
            return 'unclassified'
        if any(r['effect'] == 'external_change' for r in matches):
            return 'external_change'
        return 'read'

    def screen_answers(self, parts, answers, target=None):
        self.check_fresh()
        target = target or self.targets.get(parts['origin'])
        if target is None or not answers:
            raise Denied('NETWORK_TARGET_UNVERIFIED')
        clean = []
        for value in answers:
            if (address_scope(value) != target['scope'] or value in self.protected_addresses or
                    value not in target['addresses']):
                raise Denied('DNS_ADDRESS_CHANGED')
            if value not in clean:
                clean.append(value)
        return clean
