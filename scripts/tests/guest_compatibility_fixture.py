"""Reconstruct the exact PR #710 worker without depending on Git history.

Only the four changes in 39ada2b are reversed from the frozen PR #724 fixture,
independently of current worker development. The resulting full-source hash
must match the historical blob; no production worker source is changed.
"""
import hashlib
from pathlib import Path

LEGACY_GUEST_SHA = 'd0724e5fb5573a18095a8e906cd9bb9c2542c17c494184ca15cbc65d345331f9'
CURRENT_GUEST_SHA = '57cb87a7b4e54c5bbadae6d92f1c163075b2769a3bebca523e791b1ebc345a78'
BASELINE_GUEST_SHA = '54302e5ee880470480d9b4de3d30616b263c7213d9eb08712b1ef3f50c5c0d21'


def legacy_guest_source():
    source = Path(__file__).resolve().parent.joinpath('fixtures/a3-worker-guest-pr724.py.txt').read_text()
    if hashlib.sha256(source.encode()).hexdigest() != BASELINE_GUEST_SHA:
        raise AssertionError('Frozen PR #724 baseline must keep its exact reviewed hash')
    replacements = (
        ("        self.sign_out_attempted = False\n        self.sign_out_confirmed = False\n", ''),
        ("        # A prior UI sign-out already sent (or may have sent) this write.\n"
         "        # Teardown must report its confirmation, never repeat the request.\n"
         "        if self.sign_out_attempted:\n"
         "            return 'done' if self.sign_out_confirmed else 'failed'\n", ''),
        ("            expected_email = self.bound_email or 'demo@fractionate.ai'\n", ''),
        ("data.get('authenticated') is True and data.get('email') == expected_email}",
         "data.get('authenticated') is True and data.get('email') == 'demo@fractionate.ai'}"),
    )
    for current, previous in replacements:
        if source.count(current) != 1:
            raise AssertionError('Historical guest fixture no longer matches its reviewed delta')
        source = source.replace(current, previous)
    start = source.index("        if name == 'sign_out':\n")
    end = source.index("        raise Refused('INVALID_BROWSER_ACTION')\n", start)
    source = source[:start] + (
        "        if name == 'sign_out':\n"
        "            if not self.button('Sign out', True):\n"
        "                raise Refused('BROWSER_ELEMENT_MISSING')\n"
        "            data = self.fixed_json('/api/session')\n"
        "            return {'untrusted_page_claim_signed_out': isinstance(data, dict) and\n"
        "                    data.get('authenticated') is False}\n"
    ) + source[end:]
    data = source.encode()
    if hashlib.sha256(data).hexdigest() != LEGACY_GUEST_SHA:
        raise AssertionError('Historical guest fixture must reproduce the exact PR #710 source')
    return data
