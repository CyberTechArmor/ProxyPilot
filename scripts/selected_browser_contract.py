#!/usr/bin/env python3
"""Strict static v1 contract validation shared by selected host and guest.

The host bundles these reviewed schemas into the isolated guest module. No
caller schema, code, path, regex, permission or installed capability is accepted.
Validation grants no network, action, model or credential authority.
"""
import hashlib
import ipaddress
import json
import math
import re
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

if 'SCHEMAS' not in globals():
    SCHEMAS = json.loads(Path(__file__).with_name('selected-browser-schemas.json').read_text())


class ContractRefused(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def refuse(code='BROWSER_DRAFT_INVALID'):
    raise ContractRefused(code)


def canonical_json(value):
    """V1 canonical JSON: sorted object keys, UTF-8, ECMAScript number layout."""
    if value is None:
        return 'null'
    if type(value) is bool:
        return 'true' if value else 'false'
    if type(value) in (int, float):
        if not math.isfinite(value):
            refuse()
        if value == 0:
            return '0'
        if type(value) is int:
            return str(value)
        short = repr(value).lower()
        if 1e-6 <= abs(value) < 1e21:
            fixed = format(Decimal(short), 'f')
            return fixed.rstrip('0').rstrip('.') if '.' in fixed else fixed
        mantissa, exponent = short.split('e') if 'e' in short else (short, '0')
        mantissa = mantissa.removesuffix('.0')
        n = int(exponent)
        return mantissa + 'e' + ('+' if n >= 0 else '-') + str(abs(n))
    if type(value) is str:
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if type(value) is list:
        return '[' + ','.join(canonical_json(v) for v in value) + ']'
    if type(value) is dict and all(type(k) is str for k in value):
        return '{' + ','.join(canonical_json(k) + ':' + canonical_json(value[k]) for k in sorted(value)) + '}'
    refuse()


def digest(value):
    return hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()


def validate(schema, value):
    if 'const' in schema:
        if type(value) is not type(schema['const']) or value != schema['const']:
            refuse()
    elif 'enum' in schema:
        if not any(type(v) is type(value) and v == value for v in schema['enum']):
            refuse()
    elif 'oneOf' in schema:
        matches = 0
        for option in schema['oneOf']:
            try:
                validate(option, value)
                matches += 1
            except ContractRefused:
                pass
        if matches != 1:
            refuse()
    elif 'anyOf' in schema:
        for option in schema['anyOf']:
            try:
                validate(option, value)
                return
            except ContractRefused:
                pass
        refuse()
    elif schema['type'] == 'null':
        if value is not None:
            refuse()
    elif schema['type'] == 'object':
        if type(value) is not dict or set(value) != set(schema['required']):
            refuse()
        for key, rule in schema['properties'].items():
            validate(rule, value[key])
    elif schema['type'] == 'array':
        if type(value) is not list or not schema['minItems'] <= len(value) <= schema['maxItems']:
            refuse()
        if schema.get('uniqueItems') and len({canonical_json(v) for v in value}) != len(value):
            refuse()
        for item in value:
            validate(schema['items'], item)
    elif schema['type'] == 'string':
        if type(value) is not str or not schema['minLength'] <= len(value) <= schema['maxLength']:
            refuse()
        if 'pattern' in schema and re.search(schema['pattern'], value) is None:
            refuse()
        try:
            value.encode('utf-8')
        except UnicodeError:
            refuse()
    elif schema['type'] in ('number', 'integer'):
        if type(value) not in (int, float) or not math.isfinite(value):
            refuse()
        if schema['type'] == 'integer' and (int(value) != value or abs(value) > 2**53 - 1):
            refuse()
        if ('minimum' in schema and value < schema['minimum'] or
                'maximum' in schema and value > schema['maximum'] or
                'exclusiveMinimum' in schema and value <= schema['exclusiveMinimum']):
            refuse()
    else:
        refuse()


def canonical_origin(value):
    try:
        if not isinstance(value, str) or re.search(r'[\s\\\x00-\x1f]', value):
            refuse('BROWSER_DESTINATION_INVALID')
        u = urlsplit(value)
        if u.scheme not in ('http', 'https') or not u.hostname or '@' in u.netloc or '%' in u.netloc or u.hostname.endswith('.'):
            refuse('BROWSER_DESTINATION_INVALID')
        host = u.hostname.lower()
        if ':' in host:
            host = '[' + ipaddress.IPv6Address(host).compressed + ']'
        elif re.fullmatch(r'[0-9.]+', host):
            host = str(ipaddress.IPv4Address(host))
        port = u.port
        default = 443 if u.scheme == 'https' else 80
        return u.scheme + '://' + host + (':' + str(port) if port not in (None, default) else '')
    except (ValueError, TypeError):
        refuse('BROWSER_DESTINATION_INVALID')


def validate_configuration(c):
    validate(SCHEMAS['public_configuration'] if c.get('mode') == 'public_navigation' else SCHEMAS['configuration'], c)
    if c.get('mode') == 'public_navigation' and any(d['session_headers'] != 'omit' or 'authentication' in d['roles'] for d in c['destinations']['allowed_origins']):
        refuse('PUBLIC_CREDENTIALS_DISABLED')
    if len(canonical_json(c).encode('utf-8')) > 200000 or len(c['work']['instructions'].encode('utf-8')) > 100000:
        refuse('BROWSER_DRAFT_TOO_LARGE')
    if not c['name'].strip() or not c['work']['instructions'].strip() or any(not v.strip() for v in c['work']['success_criteria']):
        refuse()
    sites = c['destinations']['allowed_origins']
    if len({s['id'] for s in sites}) != len(sites) or len({s['origin'] for s in sites}) != len(sites):
        refuse('BROWSER_DESTINATION_DUPLICATE')
    for site in sites:
        if canonical_origin(site['origin']) != site['origin']:
            refuse('BROWSER_DESTINATION_INVALID')
        if site['origin'].startswith('http:') and (site['session_headers'] != 'omit' or 'authentication' in site['roles']):
            refuse('BROWSER_INSECURE_SESSION_DESTINATION')
        if site['roles'] == ['resource'] and site['session_headers'] != 'omit':
            refuse('BROWSER_RESOURCE_SESSION_HEADERS_DENIED')
    for value in c['destinations']['entry_urls']:
        origin = canonical_origin(value)
        if not any(s['origin'] == origin and 'navigation' in s['roles'] for s in sites):
            refuse('BROWSER_ENTRY_OUTSIDE_ALLOWLIST')
    rules = c['destinations']['request_rules']
    if len({r['id'] for r in rules}) != len(rules):
        refuse('BROWSER_REQUEST_RULE_DUPLICATE')
    for rule in rules:
        if not any(s['id'] == rule['destination_id'] for s in sites):
            refuse('BROWSER_REQUEST_DESTINATION_UNKNOWN')
        if rule['effect'] == 'read' and set(rule['methods']) - {'GET', 'HEAD', 'OPTIONS'}:
            refuse('BROWSER_READ_METHOD_REVIEW_REQUIRED')
    assets = {}
    for ref in c['work']['source_inputs'] + c['artifacts']['upload_asset_refs']:
        if ref['id'] in assets and assets[ref['id']] != ref:
            refuse('BROWSER_ASSET_PIN_CONFLICT')
        assets[ref['id']] = ref
    a = c['artifacts']
    if max(a['download_max_bytes'], a['upload_max_bytes']) > c['budgets']['max_artifact_bytes'] or any(ref['byte_count'] > a['upload_max_bytes'] for ref in a['upload_asset_refs']):
        refuse('BROWSER_ARTIFACT_BUDGET_CONFLICT')
    return c


def validate_action(envelope):
    validate(SCHEMAS['action'], envelope)
    return envelope
