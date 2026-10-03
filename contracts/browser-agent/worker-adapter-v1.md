# Selected browser guest adapter v1

`scripts/selected_browser_worker.py` is a standard-library adapter over the
installed A3 guest `Browser`, private CDP pipe, and existing live desktop. The
host bundles fixed reviewed modules into the guest launch input. It never
starts a backend-local browser or chooses a caller-supplied module or schema.
The legacy demo branch remains separate.

The factory is `selected_browser_class(Browser, Refused,
validate_configuration=..., validate_action=...)`; its resulting constructor is
`SelectedBrowser(selected, spki, channel, live=None)`. `selected` has exactly
`run_id`, `attempt_id`, `fence`, `policy_sha256`, and `configuration`. Production
supplies the fixed packaged contract validators.

## Trusted guest commands

Every command contains integer `id` and fixed `op`. No command accepts selectors,
JavaScript, host filesystem paths, cookies, credentials, or caller schemas.

| Operation | Additional fields | Result |
| --- | --- | --- |
| `selected_observe` | none | bounded observation and current references |
| `selected_action` | `envelope` matching action-v1 | primitive outcome; remote writes require host readback |
| `selected_auth` | boolean `active` | manual auth and capture/model availability |
| `selected_pause` | none | paused; opaque `discarded_request_refs` for host tombstones |
| `selected_resume` | none | fresh observation required; no failed request replay |
| `selected_control` | bounded typed `input` | existing A3 human input result |
| `selected_stage` | `kind`, pinned `ref`, `mime_type`, `bytes_base64` | private staging confirmation |
| `selected_offer_input` | `snapshot_ref`, `target_ref`, `input_ref` | minted type/paste candidate |
| `selected_discard_stage` | pinned `ref` | private bytes wiped, references invalidated |
| `selected_grant_destination` | exact `destination`, UTC ISO-Z `expires_at` | temporary hint, base allowlist unchanged |
| `selected_rebind` | `run_id`, `attempt_id`, `old_fence`, `new_fence`, `policy_sha256` | paused identity, private refs purged |
| `selected_request_decision` | opaque `request_ref`, `decision` and `ticket` or `code` | one-shot held request decision |

Existing `view`, `live_open`, `live_send`, `live_close`, `live_give`,
`live_release`, `ping`, and `stop` are retained. The host verifies controller
custody and closes spectators before enabling manual auth. Capture/observation,
model actions, and private staging are disabled during manual auth; the
controller's authorized live desktop is the authentication surface.

## Observation and action references

Observation has exactly `snapshot_ref`, `observation`, `candidates`,
`source_refs`, `input_targets`, and `page`. `page` is null on the blank page or
`{origin,url_sha256}`. The observation string is bounded to 6000 UTF-8 bytes and
explicitly marks page text untrusted and truncation. Form values are excluded;
known password/token/OTP/card fields are excluded. Arbitrary text and pixels
still require private disclosure controls.

Each candidate is `{candidate_ref:{id,sha256},operation,effect,label}`.
Operations implement navigate/read/click/scroll/type/wait/download/copy/paste/
screenshot/upload/submit. Candidate and snapshot hashes bind attempt identity,
the observation and typed operation. Element references resolve only inside a
fixed isolated-world registry with current-document and semantic fingerprint
checks. Ordinals are consumed before effects; failures cannot replay an action.

Input targets are `{target_ref:{id,sha256},element_ref,kind,label}`. The target
hash binds identity, current snapshot, opaque element, kind and redacted label.
They are drafting targets, not executable actions. After explicit review of
private draft text, the host stages pinned bytes and requests `offer_input`.
The adapter revalidates the DOM and returns an executable candidate. Those
bytes are single-use and wiped on use, stale snapshot, rejection/discard,
custody rebind or cleanup.

## All-request authority

Every page/frame/popup request pauses at CDP Fetch before HTTP transmission.
Service/shared workers are closed; inherited Chromium policy and the network
fence remain required for bypass transports. The guest emits `selected_request`
with an opaque reference and metadata binding identity, URL, HTTP method,
materialized body SHA/length, resource type, authoritative navigation/resource/
manual-auth role, and current action references. It emits no raw request body,
headers or cookies. Unmaterialized binary request bodies fail closed.

The gateway independently checks every request against reviewed read rules or
exact effect approval, recomputes the wire body hash, and strips the one-shot
`X-ProxyPilot-Request-Token` before upstream transmission. Chromium may make a
CONNECT preconnection to its local proxy before Fetch pauses. The proxy must
refuse an off-list CONNECT before target DNS/contact; CDP alone is insufficient
for that guarantee.

At most 64 pending requests are held, bounded by the attempt deadline and
cumulative request limit. Selected navigation/load waits use the remaining
attempt deadline, retaining human approval across the legacy demo's ten-second
CDP timeout. Host polling surfaces request approval before the action completes.
Pause revokes network authority and fails held references through the reader
relay before its queued pause command. Cancellation revokes/kills independently
of that queue. The guest also returns the actual failed references, including
requests whose events are still queued; the host persists tombstones before
resume. Resume never replays failed requests.

Native form submission retains its action refs while the first authoritative
Fetch event and page load resolve. A submission with no network event within a
bounded three-second trigger window is refused as unobserved; an intercepted
request can remain held until the finite attempt deadline. DOM completion does
not prove a site accepted or persisted a change.

A destination grant is an exact attempt-only hint with typed roles, header
policy and finite expiry. It does not edit configuration or authorize traffic.
Every fresh request still needs the independent gateway ticket, and expiry
invalidates affected observation authority. Blocked requests stay failed.

Artifact outcomes contain private kind/MIME/length/hash/base64 bytes. The host
stages them through F1 and emits receipts using opaque references. Raw artifacts
are never automatically released to the model or included in reports.

## Evidence and remaining acceptance

Run `python3 -m unittest discover -s scripts/tests -p
'test_selected_browser_worker.py' -v`. These tests use actual `/usr/bin/chromium`,
the private pipe, disposable local TLS sites, and a local-only CONNECT fixture;
they cover all twelve primitives, actual multipart payload hash verification,
same/cross-origin frames, popup, stale references, manual-auth capture blocking,
private draft staging, exact held requests, off-list before-target-contact,
temporary destination expiry, and custody fencing. The cloud fixture uses a
disposable sandbox workaround because this container cannot launch the installed
Chromium namespace sandbox. Production launch flags remain unchanged.

These local proofs do not attest installed Incus identity/isolation, nft rules,
compatible selected-site managed Chromium policy, real gateway TLS and network
ownership, Neko/controller-only media, or signed cleanup receipts. Production
must remain unavailable until the installed supervisor acceptance marker proves
those boundaries for the reviewed sources and configuration. A DOM/HTTP outcome
also does not prove a website persisted a business change; host readback is
required before a receipt may claim successful external effects.

The composed fixture in `scripts/tests/test_selected_browser_composition.py`
runs the actual bundled guest, supervisor request pump, gateway TLS interception,
wire body hash checks, and Chromium against pinned local HTTPS fixtures. It
covers an off-list grant followed by a fresh action, a wire approval held beyond
ten seconds, refusal to grant/replay after a POST was sent, signed agent and
manual-mode Deny outcomes, and explicit website session cookies through auth
pause. Its Incus/readback/signing and human transport boundaries are fixtures;
it does not prove installed Neko custody or production acceptance.

Selected startup uses fixed browser-service settings: disable
`NetworkTimeServiceQuerying` and `AimEnabled`; disable browser signin; set the
browser-owned GCM check-in URL and GaiaConfig ListAccounts URL to `about:blank`.
These settings accept no caller argv, URL, JSON, or path and confer no gateway
permission. They leave explicit website URLs untouched. The ordinary unique
attempt profile and legacy managed policy remain in use; no Incognito, Guest,
or separate CDP context is retained. Exact source and local proof details are in
`docs/plans/evidence/selected-browser-20261002/worker-composition.md`.
