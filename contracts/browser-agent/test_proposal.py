"""Offline contract fixtures, not an application or execution-policy module.

These fixtures establish shape and proposed outcomes only. They make no network
requests and do not prove Chromium interception, proxy isolation or host fencing.
Run: python3 -m unittest discover -s contracts/browser-agent -p 'test_*.py' -v
"""
import copy
import ipaddress
import json
import unittest
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent
AGENT_SCHEMA = json.loads((ROOT / "proposal-v1.schema.json").read_text())
ACTION_SCHEMA = json.loads((ROOT / "action-v1.schema.json").read_text())
AGENT = Draft202012Validator(AGENT_SCHEMA)
ACTION = Draft202012Validator(ACTION_SCHEMA)
BASE = json.loads((ROOT / "fixtures/general-agent.draft.json").read_text())
UUID = "64efc535-6fa0-4946-b724-6fb9309df752"
PIN = {"id": UUID, "sha256": "a" * 64}
ASSET = {**PIN, "mime_type": "text/plain", "byte_count": 20}


def origin(url):
    """Fixture canonicalizer. Production needs Chromium/proxy parity proofs."""
    if not isinstance(url, str) or any(c.isspace() or ord(c) < 32 for c in url) or "\\" in url:
        raise ValueError("URL_UNSUPPORTED")
    u = urlsplit(url)
    if u.scheme not in ("http", "https") or u.username is not None or u.password is not None:
        raise ValueError("URL_UNSUPPORTED")
    if not u.hostname or u.hostname.endswith(".") or "%" in u.netloc:
        raise ValueError("URL_UNSUPPORTED")
    default = 443 if u.scheme == "https" else 80
    host = "[" + u.hostname + "]" if ":" in u.hostname else u.hostname
    return u.scheme + "://" + host + (":" + str(u.port) if u.port not in (None, default) else "")


def semantic_issues(draft):
    """Cross-field proposal checks. No grant, run or network is created."""
    AGENT.validate(draft)
    issues = []
    sites = draft["destinations"]["allowed_origins"]
    if len({s["id"] for s in sites}) != len(sites):
        issues.append("DUPLICATE_DESTINATION_ID")
    if len({s["origin"] for s in sites}) != len(sites):
        issues.append("DUPLICATE_DESTINATION_ORIGIN")
    navigation = {s["origin"] for s in sites if "navigation" in s["roles"]}
    for url in draft["destinations"]["entry_urls"]:
        try:
            if origin(url) not in navigation:
                issues.append("ENTRY_OUTSIDE_NAVIGATION_ALLOWLIST")
        except ValueError:
            issues.append("ENTRY_URL_UNSUPPORTED")
    for site in sites:
        try:
            if origin(site["origin"]) != site["origin"]:
                issues.append("NONCANONICAL_DESTINATION")
        except ValueError:
            issues.append("DESTINATION_UNSUPPORTED")
        if site["roles"] == ["resource"] and site["session_headers"] != "omit":
            issues.append("RESOURCE_SESSION_HEADERS_DENIED")
    for site in sites:
        if site["origin"].startswith("http:") and (site["session_headers"] != "omit" or "authentication" in site["roles"]):
            issues.append("INSECURE_SESSION_DESTINATION")
    if len({r["id"] for r in draft["destinations"]["request_rules"]}) != len(draft["destinations"]["request_rules"]):
        issues.append("DUPLICATE_REQUEST_RULE_ID")
    for rule in draft["destinations"]["request_rules"]:
        if rule["destination_id"] not in {s["id"] for s in sites}:
            issues.append("REQUEST_RULE_DESTINATION_UNKNOWN")
        if rule["effect"] == "read" and set(rule["methods"]) - {"GET", "HEAD", "OPTIONS"}:
            issues.append("READ_RULE_METHOD_REVIEW_REQUIRED")
    assets = draft["artifacts"]
    for name in ["download_max_bytes", "upload_max_bytes"]:
        if assets[name] > draft["budgets"]["max_artifact_bytes"]:
            issues.append("ARTIFACT_BUDGET_CONFLICT")
    if any(a["byte_count"] > assets["upload_max_bytes"] for a in assets["upload_asset_refs"]):
        issues.append("UPLOAD_ASSET_OVER_LIMIT")
    return issues


def fixture_readiness(draft):
    """Demonstrate required gates; always disabled without runtime integration."""
    issues = semantic_issues(draft)
    issues.extend(["RUNNER_REACHABILITY_UNVERIFIED", "EXACT_TARGET_NETWORK_POLICY_UNVERIFIED"])
    if draft["work"]["guide_ref"] is None:
        issues.append("APPROVED_GUIDE_REQUIRED")
    if not draft["destinations"]["request_rules"]:
        issues.append("SELECTED_SITE_REQUEST_RULES_REQUIRED")
    # Imported JSON cannot grant any of these authoritative permissions.
    issues.extend(["OWNER_MODEL_CONSENT_REQUIRED", "CURRENT_RUN_AUTHORIZATION_REQUIRED", "RUNTIME_INTEGRATION_ABSENT"])
    return {"can_start": False, "issues": issues}


def fixture_request(draft, url, purpose="resource", method="GET", resource_type="script",
                    addresses=("93.184.216.34",), protected_hosts=()):
    """Unverified public-target oracle. Internal/IPv6 targets require a proven
    exact-target policy; this fixture grants none. No DNS/socket/gateway call.
    """
    try:
        target = origin(url)
    except ValueError:
        return "URL_DENIED_BEFORE_SEND"
    host = urlsplit(url).hostname
    if any(host == h or host.endswith("." + h) for h in protected_hosts):
        return "PROTECTED_DESTINATION_DENIED_BEFORE_SEND"
    if not addresses:
        return "ADDRESS_DENIED_BEFORE_SEND"
    for address in addresses:
        a = ipaddress.ip_address(address)
        if a.version != 4 or not a.is_global:
            return "ADDRESS_DENIED_BEFORE_SEND"
    wanted = "authentication" if purpose == "authentication" else "navigation" if purpose in ("navigation", "redirect", "popup") else "resource"
    site = next((s for s in draft["destinations"]["allowed_origins"] if s["origin"] == target), None)
    if site is None or wanted not in site["roles"]:
        return "OFF_LIST_PAUSE_AND_ESCALATE_BEFORE_SEND"
    if purpose == "websocket":
        return "TRANSPORT_REVIEW_REQUIRED_BEFORE_SEND"
    u = urlsplit(url)
    query_keys = {k for k, _ in parse_qsl(u.query, keep_blank_values=True)}
    rules = [r for r in draft["destinations"]["request_rules"]
             if r["destination_id"] == site["id"] and u.path.startswith(r["path_prefix"])
             and method in r["methods"] and resource_type in r["resource_types"]
             and query_keys.issubset(set(r["query_keys"]))]
    if not rules:
        return "UNCLASSIFIED_REQUEST_PAUSE_BEFORE_SEND"
    effects = {r["effect"] for r in rules}
    # An overlapping stricter rule must never be weakened by a broad read rule.
    if "unclassified" in effects:
        return "UNCLASSIFIED_REQUEST_PAUSE_BEFORE_SEND"
    if "external_change" in effects:
        return "EXACT_EFFECT_APPROVAL_CHECK_REQUIRED_BEFORE_SEND"
    return "MATCHES_REVIEWED_READ_RULE_FIXTURE"


def read_rule(destination="site-1"):
    return {"id": "read-" + destination, "destination_id": destination, "path_prefix": "/",
            "methods": ["GET", "HEAD"], "query_keys": ["q"],
            "resource_types": ["document", "stylesheet", "script", "image", "font", "xhr", "fetch"],
            "effect": "read", "max_request_bytes": 0}


class ProposalTests(unittest.TestCase):
    def draft(self):
        return copy.deepcopy(BASE)

    def test_schemas_are_valid_and_fixture_is_valid_but_not_executable(self):
        Draft202012Validator.check_schema(AGENT_SCHEMA)
        Draft202012Validator.check_schema(ACTION_SCHEMA)
        self.assertEqual(semantic_issues(BASE), [])
        r = fixture_readiness(BASE)
        self.assertFalse(r["can_start"])
        self.assertIn("RUNNER_REACHABILITY_UNVERIFIED", r["issues"])
        self.assertIn("EXACT_TARGET_NETWORK_POLICY_UNVERIFIED", r["issues"])

    def test_raw_credential_and_authority_fields_are_rejected(self):
        for field, value in [("password", "canary"), ("cookie", "canary"), ("token", "canary"),
                             ("execution_enabled", True), ("approved", True)]:
            with self.subTest(field=field):
                d = self.draft(); d[field] = value
                self.assertFalse(AGENT.is_valid(d))

    def test_origin_wildcards_userinfo_ports_paths_and_noncanonical_names_rejected(self):
        for url in ["https://*.example.com", "https://user:pass@example.com",
                    "https://example.com/path", "https://example.com.", "https://Example.com"]:
            with self.subTest(url=url):
                d = self.draft(); d["destinations"]["allowed_origins"][0]["origin"] = url
                self.assertFalse(AGENT.is_valid(d))

    def test_cross_field_destination_and_entry_constraints(self):
        d = self.draft(); d["destinations"]["allowed_origins"][1]["origin"] = "https://example.com"
        self.assertIn("DUPLICATE_DESTINATION_ORIGIN", semantic_issues(d))
        d = self.draft(); d["destinations"]["entry_urls"] = ["https://assets.example.com/"]
        self.assertIn("ENTRY_OUTSIDE_NAVIGATION_ALLOWLIST", semantic_issues(d))
        d = self.draft(); d["destinations"]["allowed_origins"][1]["session_headers"] = "this_origin_session"
        self.assertIn("RESOURCE_SESSION_HEADERS_DENIED", semantic_issues(d))

    def test_network_references_are_not_grants_and_named_preauthorization_is_not_selected(self):
        d = self.draft()
        d["destinations"]["network_policy_ref"] = PIN
        self.assertIn("EXACT_TARGET_NETWORK_POLICY_UNVERIFIED", fixture_readiness(d)["issues"])
        d = self.draft(); d["permissions"]["external_change_approval"] = "named_preauthorizations"
        self.assertFalse(AGENT.is_valid(d))

    def test_all_off_list_request_classes_escalate_before_send(self):
        d = self.draft(); d["destinations"]["request_rules"] = [read_rule(), read_rule("assets-1")]
        for kind in ["navigation", "redirect", "popup", "resource", "authentication", "xhr", "websocket"]:
            with self.subTest(kind=kind):
                self.assertEqual(fixture_request(d, "https://other.example.com/", kind), "OFF_LIST_PAUSE_AND_ESCALATE_BEFORE_SEND")
        self.assertEqual(fixture_request(d, "https://assets.example.com/x.js"), "MATCHES_REVIEWED_READ_RULE_FIXTURE")
        self.assertEqual(fixture_request(d, "https://assets.example.com/", "navigation"), "OFF_LIST_PAUSE_AND_ESCALATE_BEFORE_SEND")
        self.assertEqual(fixture_request(d, "https://example.com/", "authentication"), "OFF_LIST_PAUSE_AND_ESCALATE_BEFORE_SEND")

    def test_without_verified_target_policy_private_mixed_ipv6_and_managed_hosts_are_refused(self):
        d = self.draft(); d["destinations"]["request_rules"] = [read_rule()]
        for answers in [(), ("127.0.0.1",), ("169.254.169.254",), ("10.0.0.1",),
                        ("93.184.216.34", "192.168.1.10"), ("2001:4860:4860::8888",)]:
            with self.subTest(answers=answers):
                self.assertEqual(fixture_request(d, "https://example.com/", addresses=answers), "ADDRESS_DENIED_BEFORE_SEND")
        self.assertEqual(fixture_request(d, "https://example.com/", protected_hosts=["example.com"]), "PROTECTED_DESTINATION_DENIED_BEFORE_SEND")

    def test_query_and_write_effect_rules_cannot_silently_expand_permission(self):
        d = self.draft(); d["destinations"]["request_rules"] = [read_rule()]
        self.assertEqual(fixture_request(d, "https://example.com/?token=canary"), "UNCLASSIFIED_REQUEST_PAUSE_BEFORE_SEND")
        self.assertEqual(fixture_request(d, "https://example.com/autosave", method="POST", resource_type="fetch"), "UNCLASSIFIED_REQUEST_PAUSE_BEFORE_SEND")
        write = {**read_rule(), "id": "autosave", "path_prefix": "/autosave", "methods": ["POST"],
                 "effect": "external_change", "max_request_bytes": 1024}
        d["destinations"]["request_rules"].append(write)
        self.assertEqual(fixture_request(d, "https://example.com/autosave", method="POST", resource_type="fetch"), "EXACT_EFFECT_APPROVAL_CHECK_REQUIRED_BEFORE_SEND")
        write.update(methods=["GET"], effect="unclassified")
        self.assertEqual(fixture_request(d, "https://example.com/autosave", resource_type="fetch"), "UNCLASSIFIED_REQUEST_PAUSE_BEFORE_SEND")

    def test_all_requested_action_shapes_and_prohibited_escapes(self):
        operations = [
            {"kind": "navigate", "destination_id": "site-1", "url": "https://example.com/#section"},
            {"kind": "read", "scope": "visible_page", "selection_ref": None},
            {"kind": "click", "element_ref": "element-1"},
            {"kind": "scroll", "dx": 0, "dy": 600},
            {"kind": "type", "element_ref": "element-1", "input_ref": PIN},
            {"kind": "wait", "max_ms": 1000},
            {"kind": "download", "resource_ref": "resource-1"},
            {"kind": "copy", "selection_ref": "selection-1"},
            {"kind": "paste", "element_ref": "element-1", "clipboard_ref": PIN},
            {"kind": "screenshot", "area": "viewport", "selection_ref": None},
            {"kind": "upload", "element_ref": "element-1", "asset_ref": ASSET},
            {"kind": "submit", "form_ref": "form-1", "field_set_sha256": "b" * 64},
        ]
        for operation in operations:
            intent = {"schema": "proxypilot.browser-action.proposal.v1", "run_id": UUID, "attempt_id": UUID,
                      "fence": 1, "ordinal": 1, "policy_sha256": "a" * 64,
                      "snapshot_ref": PIN, "candidate_ref": PIN, "approval_ref": None, "operation": operation}
            with self.subTest(action=operation["kind"]):
                ACTION.validate(intent)
                for field in ["selector", "code", "file_path", "password", "headers"]:
                    invalid = copy.deepcopy(intent); invalid["operation"][field] = "canary"
                    self.assertFalse(ACTION.is_valid(invalid))

    def test_limits_and_asset_pins_are_bounded(self):
        d = self.draft(); d["budgets"]["max_seconds"] = 0
        self.assertFalse(AGENT.is_valid(d))
        d = self.draft(); d["artifacts"]["download_max_bytes"] = d["budgets"]["max_artifact_bytes"] + 1
        self.assertIn("ARTIFACT_BUDGET_CONFLICT", semantic_issues(d))
        d = self.draft(); d["artifacts"]["upload_asset_refs"] = [{**ASSET, "sha256": "not-a-hash"}]
        self.assertFalse(AGENT.is_valid(d))


if __name__ == "__main__":
    unittest.main()
