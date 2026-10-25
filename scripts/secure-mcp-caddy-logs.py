#!/usr/bin/env python3
"""Retrofit standard installer Caddy logs. Refuse custom formats for local review.

Called by install/update before exposing the new backend. Does not print config
or requests. Existing file metadata is retained; validation/reload failure rolls
back both files. Callers must stop the upgrade on failure.
"""
import pathlib
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
    if changed == originals:
        return
    try:
        for p, data in zip(paths, changed):
            p.write_text(data)
        # Never send configuration (which may contain unrelated secrets) to logs.
        for command in (['adapt'] if '--no-reload' in sys.argv else ['validate', 'reload']):
            subprocess.run(['caddy', command, '--config', str(paths[0])], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except BaseException:
        for p, data in zip(paths, originals):
            p.write_text(data)
        raise

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('MCP log hardening failed; configuration restored. Review Caddy logging locally before continuing.', file=sys.stderr)
        sys.exit(1)
