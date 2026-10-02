"""Build browser-agent draft schemas, the packaged runtime copy and a fixture.

Generation only: no database, browser, network, credential, deployment or
approval authority. Draft imports are validated by the separate backend module.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def obj(properties):
    return {"type": "object", "additionalProperties": False,
            "required": list(properties), "properties": properties}


def array(items, maximum=32, minimum=0, unique=False):
    out = {"type": "array", "items": items, "minItems": minimum, "maxItems": maximum}
    if unique:
        out["uniqueItems"] = True
    return out


def text(maximum, minimum=0, pattern=None):
    out = {"type": "string", "minLength": minimum, "maxLength": maximum}
    if pattern:
        out["pattern"] = pattern
    return out


def integer(minimum, maximum):
    return {"type": "integer", "minimum": minimum, "maximum": maximum}


def const(value):
    return {"const": value}


def nullable(schema):
    return {"anyOf": [{"type": "null"}, schema]}


def enum(values):
    return {"enum": values}


IDENTIFIER = text(64, 1, r"^[a-z][a-z0-9_-]*$")
UUID = text(36, 36, r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
HASH = text(64, 64, r"^[0-9a-f]{64}$")
# Explicit canonical origins, including internal names and non-default ports.
# Definitions grant no reachability, ranges, infrastructure access or credentials.
ORIGIN = text(300, 8, r"^https?://(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[a-f0-9:]+\])(?::[1-9][0-9]{0,4})?$")
URL = text(2048, 8, r"^https?://[^\s\\]+$")
PIN = obj({"id": UUID, "sha256": HASH})
ASSET = obj({"id": UUID, "sha256": HASH, "mime_type": text(100, 1),
             "byte_count": integer(1, 64 * 1024 * 1024)})
ACTION_NAMES = ["navigate", "read", "click", "scroll", "type", "wait", "download",
                "copy", "paste", "screenshot", "upload", "submit"]

DESTINATION = obj({
    "id": IDENTIFIER, "origin": ORIGIN,
    "roles": array(enum(["navigation", "resource", "authentication"]), 3, 1, True),
    "session_headers": enum(["omit", "this_origin_session"]),
})
REQUEST_RULE = obj({
    "id": IDENTIFIER, "destination_id": IDENTIFIER,
    "path_prefix": text(2048, 1, r"^/(?!/)[^\s\\?#]*$"),
    "methods": array(enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]), 7, 1, True),
    "query_keys": array(text(100, 1), 32, 0, True),
    "resource_types": array(enum(["document", "stylesheet", "script", "image", "font",
                                  "media", "xhr", "fetch", "other"]), 9, 1, True),
    "effect": enum(["read", "external_change", "unclassified"]),
    "max_request_bytes": integer(0, 64 * 1024 * 1024),
})
PREAUTH_REF = obj({"id": UUID, "revision": integer(1, 2147483647), "sha256": HASH})

AGENT = obj({
    "schema": const("proxypilot.browser-agent.proposal.v1"),
    "workflow": const("selected_browser_v1"), "name": text(200, 1),
    "work": obj({"instructions": text(100000, 1),
                 "success_criteria": array(text(2000, 1), 16, 1),
                 "guide_ref": nullable(PIN), "source_inputs": array(ASSET)}),
    "destinations": obj({
        "network_scope": const("explicit_destinations"),
        "network_policy_ref": nullable(PIN),
        "allowed_origins": array(DESTINATION, 32, 1),
        "entry_urls": array(URL, 32, 1, True),
        "off_list": const("pause_and_escalate_before_send"),
        "off_list_approval": obj({"scope": const("exact_destination_and_purpose"),
                                   "lifetime": const("attempt"), "persist_to_allowlist": const(False),
                                   "wildcards": const(False)}),
        "subresources": const("explicit_origins_only"),
        "redirects": const("same_policy"), "popups": const("same_policy"),
        "request_rules": array(REQUEST_RULE, 128),
        "unclassified_requests": const("pause_and_escalate_before_send"),
        "websockets": const("blocked_pending_selected_site_transport_review"),
    }),
    "permissions": obj({
        "actions": array(enum(ACTION_NAMES), len(ACTION_NAMES), 1, True),
        "external_change_approval": const("per_action"),
        "preauthorization_refs": array(PREAUTH_REF, 0),
        "start": const("explicit_current_revision"),
    }),
    "authentication": obj({"mode": const("manual_takeover"),
                           "session_lifetime": const("attempt"), "persist_session": const(False)}),
    "model": obj({"provider_route": const("existing_a4"), "name": const("gpt-6-luna"),
                  "decisions": const("bounded_candidate_selection"),
                  "disclosure": const("approved_guide_and_bounded_page_content"),
                  "max_prompt_bytes": integer(1024, 16000),
                  "max_decision_output_tokens": integer(16, 256),
                  "max_report_output_tokens": integer(128, 2000)}),
    "budgets": obj({"max_seconds": integer(1, 3600), "max_actions": integer(1, 200),
                    "max_model_calls": integer(1, 100), "max_tokens": integer(1, 200000),
                    "max_usd": {"type": "number", "exclusiveMinimum": 0, "maximum": 20},
                    "max_requests": integer(1, 2000),
                    "max_response_bytes": integer(1, 256 * 1024 * 1024),
                    "max_artifact_bytes": integer(1, 64 * 1024 * 1024),
                    "cpu": integer(1, 8), "memory_mib": integer(1024, 8192),
                    "temporary_disk_mib": integer(64, 2048)}),
    "artifacts": obj({
        "visibility": const("run_authorized_users"), "record_video": const(False),
        "retention_days": integer(1, 90), "capture_during_manual_auth": const(False),
        "download_max_bytes": integer(1, 64 * 1024 * 1024),
        "upload_max_bytes": integer(1, 64 * 1024 * 1024),
        "download_mime_types": array(text(100, 1), 32, 1, True),
        "upload_asset_refs": array(ASSET),
        "clipboard": obj({"scope": const("attempt_private"),
                          "human_exchange": const("explicit_import_export"),
                          "max_bytes": integer(1, 65536)}),
    }),
    "supervision": obj({"live_view": const(True), "pause": const(True),
                        "stop": const(True), "takeover": const(True),
                        "escalation": const("project_inbox"), "report": const("project_activity")}),
})

TARGET_REF = text(128, 1, r"^[A-Za-z0-9_-]+$")
OPERATIONS = {
    "navigate": {"destination_id": IDENTIFIER, "url": URL},
    "read": {"scope": enum(["visible_page", "selection"]), "selection_ref": nullable(TARGET_REF)},
    "click": {"element_ref": TARGET_REF},
    "scroll": {"dx": integer(-2000, 2000), "dy": integer(-2000, 2000)},
    "type": {"element_ref": TARGET_REF, "input_ref": PIN},
    "wait": {"max_ms": integer(1, 10000)},
    "download": {"resource_ref": TARGET_REF},
    "copy": {"selection_ref": TARGET_REF},
    "paste": {"element_ref": TARGET_REF, "clipboard_ref": PIN},
    "screenshot": {"area": enum(["viewport", "selection"]), "selection_ref": nullable(TARGET_REF)},
    "upload": {"element_ref": TARGET_REF, "asset_ref": ASSET},
    "submit": {"form_ref": TARGET_REF, "field_set_sha256": HASH},
}
ACTION = obj({
    "schema": const("proxypilot.browser-action.proposal.v1"),
    "run_id": UUID, "attempt_id": UUID, "fence": integer(1, 2147483647),
    "ordinal": integer(1, 2147483647), "policy_sha256": HASH,
    "snapshot_ref": PIN, "candidate_ref": PIN, "approval_ref": nullable(PIN),
    "operation": {"oneOf": [obj({"kind": const(kind), **fields}) for kind, fields in OPERATIONS.items()]},
})


def schema(value, name):
    return {"$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": f"urn:proxypilot:{name}:proposal:v1",
            "description": "Draft configuration contract. Import/save does not authorize execution or approve effects.",
            **value}


DRAFT = {
    "schema": "proxypilot.browser-agent.proposal.v1", "workflow": "selected_browser_v1",
    "name": "Selected-site browser agent",
    "work": {"instructions": "Replace with Thomas's plain-language task. Do not include credentials.",
             "success_criteria": ["Replace with a checkable requested result."],
             "guide_ref": None, "source_inputs": []},
    "destinations": {
        "network_scope": "explicit_destinations",
        "network_policy_ref": None,
        "allowed_origins": [
            {"id": "site-1", "origin": "https://example.com", "roles": ["navigation", "resource"], "session_headers": "this_origin_session"},
            {"id": "assets-1", "origin": "https://assets.example.com", "roles": ["resource"], "session_headers": "omit"},
        ],
        "entry_urls": ["https://example.com/"], "off_list": "pause_and_escalate_before_send",
        "off_list_approval": {"scope": "exact_destination_and_purpose", "lifetime": "attempt",
                              "persist_to_allowlist": False, "wildcards": False},
        "subresources": "explicit_origins_only", "redirects": "same_policy", "popups": "same_policy",
        "request_rules": [], "unclassified_requests": "pause_and_escalate_before_send",
        "websockets": "blocked_pending_selected_site_transport_review",
    },
    "permissions": {"actions": ACTION_NAMES, "external_change_approval": "per_action",
                    "preauthorization_refs": [], "start": "explicit_current_revision"},
    "authentication": {"mode": "manual_takeover", "session_lifetime": "attempt", "persist_session": False},
    "model": {"provider_route": "existing_a4", "name": "gpt-6-luna", "decisions": "bounded_candidate_selection",
              "disclosure": "approved_guide_and_bounded_page_content", "max_prompt_bytes": 16000,
              "max_decision_output_tokens": 128, "max_report_output_tokens": 1500},
    "budgets": {"max_seconds": 900, "max_actions": 60, "max_model_calls": 20, "max_tokens": 50000,
                "max_usd": 1, "max_requests": 500, "max_response_bytes": 50 * 1024 * 1024,
                "max_artifact_bytes": 32 * 1024 * 1024, "cpu": 1, "memory_mib": 1024, "temporary_disk_mib": 512},
    "artifacts": {"visibility": "run_authorized_users", "record_video": False, "retention_days": 14,
                  "capture_during_manual_auth": False, "download_max_bytes": 16 * 1024 * 1024,
                  "upload_max_bytes": 16 * 1024 * 1024,
                  "download_mime_types": ["application/pdf", "text/plain", "text/csv", "image/png", "image/jpeg"],
                  "upload_asset_refs": [],
                  "clipboard": {"scope": "attempt_private", "human_exchange": "explicit_import_export", "max_bytes": 65536}},
    "supervision": {"live_view": True, "pause": True, "stop": True, "takeover": True,
                    "escalation": "project_inbox", "report": "project_activity"},
}


def main():
    for name, value in [("proposal-v1.schema.json", schema(AGENT, "browser-agent")),
                        ("action-v1.schema.json", schema(ACTION, "browser-action")),
                        ("fixtures/general-agent.draft.json", DRAFT)]:
        (ROOT / name).write_text(json.dumps(value, indent=2) + "\n")
    # Runtime packaging copies backend/src, not repository-root contracts.
    # Keep this generated copy byte-identical; contract tests verify it.
    runtime = ROOT.parent.parent / "admin/backend/src/lib/operational-browser-agent-proposal.schema.json"
    runtime.write_text(json.dumps(schema(AGENT, "browser-agent"), indent=2) + "\n")
    # Host/guest use the same trusted static schemas with a stdlib validator.
    host = ROOT.parent.parent / "scripts/selected-browser-schemas.json"
    host.write_text(json.dumps({"configuration": schema(AGENT, "browser-agent"),
                                "action": schema(ACTION, "browser-action")}, indent=2) + "\n")


if __name__ == "__main__":
    main()
