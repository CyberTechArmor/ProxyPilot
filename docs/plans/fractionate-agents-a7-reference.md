# A7 reference: current state for any conversation

Snapshot: 2026-09-29, after the A7 implementation and its local proofs, before
any host step. Nothing is merged, deployed or promoted.

This file is the orientation page. The dated
[A7 evidence](fractionate-agents-a7-evidence.md) is the record; if the two
disagree, the evidence wins. Recheck every mutable value (SHAs, services, VM
boot, receipt key) before acting.

**Status in one line:** A7 is **implemented and proven locally; the user
asked for it to be merged and deployed (2026-09-29); the host run (H0–H7
below) has not run.** The user decided every A7 question on 2026-09-29 (the
evidence's decisions table). The TURN name is **`streamview.fractionate.ai`**:
the zone's wildcard record already points it at the host's public address
(96.88.158.118), there is no Cloudflare on this instance, and Caddy obtains
its certificate. The listen address is this host's default-route address,
found by the installer. **The relay uses 3479 UDP/TCP and TLS 5350**, not
3478/5349: the MEET container's coturn already owns those on this host
(2026-09-29 finding; `install-turn` now refuses a port anything else listens
on). The one thing left outside the code is the router: **3479/UDP, 3479/TCP
and 5350/TCP forwarded to 192.168.88.161**.

## Read first

1. This page, then the [A7 evidence](fractionate-agents-a7-evidence.md).
2. The [A6 reference](fractionate-agents-a6-reference.md) and the
   [A5 reference](fractionate-agents-a5-reference.md): A7 keeps every A3–A6
   rule and drives the same coordinator.
3. The [A7 prompt](fractionate-agents-a7-prompt.md), the
   [Neko research](fractionate-agents-a7-neko-research.md) and the A7 row of
   [the plan](fractionate-agents-a1-a8.md).
4. `admin/frontend/MOBILE_FIRST.md` before touching the pages.

## Decisions (user, 2026-09-29)

| # | Decision |
|---|---|
| 1, 1a | Neko, inside the per-attempt worker unit (Xvfb, Neko on a Unix socket, the runner's own Chromium in kiosk mode) |
| 1b | TURN with a TLS fallback: coturn on the host (3479 UDP/TCP and 5350 TLS on this host, where MEET's coturn owns 3478/5349), relaying only to the VM's Neko UDP port |
| 1c | Our own React client in the run deck's Browser pane |
| 2 | Resume = a new linked run with the same pins, a new attempt and fence, its own approval |
| 3 | An uncertain write gates the profile until a person decides; anyone with run access (the starter too) after the session's verification |
| 4 | Practice = a flag on the run; the demo fixture mode is chosen in the dashboard (audited write into the demo guest) |
| 5 | Critique = rule-based and a model summary, written automatically for consenting profiles |
| 6 | Out-of-set reply → `blocked/model_choice_invalid`, unknown usage → `failed/usage_unknown` (host proof: broker proof switches); submit `timeout` → a help request that gates (host proof: demo mode `slow`) |
| — | Takeover and reconciliation need the session's own verification (password + TOTP or a passkey, once per session), never sudo |

## Exact revisions

| Where | Revision | Notes |
|---|---|---|
| Base | `main` `23f138ea4bc0854bd17af14e1b15944a3d616a56` | after `24cfadbd` (#705) and #706 |
| Branch | `claude/intelligent-heisenberg-bwnuiv` | no PR |
| Decisions | `b99ed01f` | the evidence's gate and decisions |
| Backend core | `c12b26bb` | migration 1112, practice, resume, reconciliation, timeout help, critique, control grant |
| Host scripts | `b9271b94` | runner with Neko, supervisor takeover/relay, broker switches and summary, demo `slow` |
| Fence, TURN, installer | `3ed44fa6` | live-relay fence line, TURN credentials, `a7-install-live.py` |
| Backend plumbing | `9776478e` | live WebSocket, takeover routes, automatic summary, practice fixtures |
| UI | `d5fe6d0e` | Browser pane live view and takeover, reconcile, practice, resume, Review tab |
| Proofs | `f6491871` | the Go live probe, the live end-to-end tests, the host harness |
| Kill cases | `91a25b62` | kill cases, account/key loss, `WORKER_EXITED`, `a7-host-summary.py` |
| Listen address | `805f4565a1bd397970660f1684caea528de03ae6` | the TURN listen address found from the default route; the last code commit |
| **What is deployed** | **the merge commit of the A7 PR into `main`** | staged in the candidate by the pinned stager (D1), checked and promoted (D2); the host steps use that candidate |
| Live checkout / candidate before the deploy | `776045d741e2126ae8a38bba83a620551f2b34c9` | rollback point for the deploy |

**File digests** (sha256 at `805f4565`; the installers copy byte-exact):

| File | Installed now (A6 host run 2) | A7 |
|---|---|---|
| `a3-worker-supervisor.py` | `73a89f61…` (installed by H1, 2026-09-29) | **`44904081f46a700f…`** after the port move (the installer's TURN ports); `73a89f61…` at `9e1d66a5` |
| `a3-worker-guest.py` (runner) | `a631ad9d…` | **`7185ee26675721269…`** (live desktop, give/release, cleared password fields) |
| `a3-network-fence.py` | A3 bytes | **`e7208d606aec742f…`** (the live-relay line only when live; identical render when not) |
| `a3-install-fence.py` | A3 bytes | **`bb396c84f85448cd…`** (`live_relay`) |
| `a4-credential-broker.py` | `790a1957…` | **`10aa2a731f4de9e5…`** (`summary_call`, two proof switches) |
| `admin/frontend/demo/server.mjs` | `496846cd…` | **`d469366811e70784…`** (mode `slow`) |
| `a3-origin-proxy.py`, `a3-install-proxy.py`, `a3-install-supervisor.py`, `a4-install-broker.py` | — | unchanged |
| `a3-probe-worker.py` | `b770a4a9…` | **`d1bdda8a95595ceb…`** (backend `takeover` expectations) |
| `a4-fixture-account.py` | — | `f5551b96fdd583f6…` (mode `slow`) |
| `a4-canary-scan.py` | — | `95b03fc40248ad04…` (`--a7-dir`) |
| `a7-install-live.py` | — | **`2a8ee479d320d615…`** with the VM package fix (one tar stream read back by sha256, apt without lists); `de0f9301…` after the port move; `69dda3db…` at `9e1d66a5` |
| `a7-neko-unix-socket.patch` | — | `a4fedb0f77048c4c…` (pinned in the installer) |
| `a7-probe.mjs` | — | `2dd2b259e180d75e…` (a comment); `b1a33ea6…` at `9e1d66a5` |
| `a7-host-summary.py` | — | `63a1c630bdbf2ad3…` |
| `cmd/a7-live-probe/main.go` / `go.sum` | — | `c40a04c67ff610f0…` (the port from the URL) / `e8ad1e077c107dc2…` |

**Neko:** `github.com/m1k1o/neko` at `3f4f94087a1fd40b2aaddd5aad00a2e5f4959270`
plus the reviewed Unix-socket patch, built in `golang:1.25-trixie`.

**Host state carried from A6** (recheck in H0): receipt key `f68c8aaf…`, proxy
SPKI `V7Qx86Hf…`, proof VM boot `c70bdf71…`, A4 proof binding `87151b55…`.

## Component map

| File | Role |
|---|---|
| `scripts/a3-worker-guest.py` | Runner: `LiveDesktop` (Xvfb, `xinput` counter, Neko on a Unix socket), the kiosk Chromium under `live_policy_bytes()`, `live_open/live_give/live_release`, relay framing; `give` refuses `LIVE_FIELDS_NOT_CLEAR` while a password field holds text and reports `uncontrolled_inputs` |
| `scripts/a3-worker-supervisor.py` | Backend `live` (stream), `takeover` (dashboard), `release`, `summarize`; TURN REST credentials from `/etc/proxypilot-a7/turn-secret` and `live.json`; `_refuse_if_exited` → `WORKER_EXITED` |
| `scripts/a3-network-fence.py`, `a3-install-fence.py` | The fence's one live line: UDP from the VM's `18091` to the gateway's `49160–49200` |
| `scripts/a4-credential-broker.py` | `summary_call` (typed facts in, bounded text out, pinned budget); `model_call` proof switches `reply_outside_set`, `usage_missing` (operator socket only; no key read, no provider call) |
| `scripts/a7-install-live.py` | `build-neko`, `build-probe`, `provision-vm`, `install-turn [--caddy-site]`, `cert-sync` (daily timer), `enable`, `disable`, `status` |
| `admin/frontend/demo/server.mjs` | Mode `slow` (the sign-in held 12 s, past the proxy's 8 s; never counted in the shared limit) |
| `admin/backend/src/lib/operational-recovery*.js` | Migration 1112, reconciliation state, the profile gate, the rule critique, summary facts |
| `admin/backend/src/lib/operational-run-coordinator.js` | Resume pins (`RESUME_STALE`), `RECONCILIATION_REQUIRED`, takeover hand-off, `WORKER_EXITED → failed/attempt_lost` |
| `admin/backend/src/lib/operational-agent-runs.js` | Practice, resume, reconcile, takeover/end, `openLive/sendLive/closeLive/assertLive`, automatic summary |
| `admin/backend/src/lib/operational-live-relay.js` | The relay filter (Neko signalling events only, size and rate bounds) |
| `admin/backend/src/lib/operational-demo-fixtures.js` | The one write into the demo guest (constant argv, read-back) |
| `admin/backend/src/lib/operational-control-grants.js`, `routes/agent-control-auth.js` | The session's agent-control verification |
| `admin/backend/src/routes/agent-live-ws.js` | The live WebSocket route |
| `admin/frontend/src/components/operational-projects/{LiveBrowser.jsx,live-client.js,live-input.js}` | The Browser pane's WebRTC client (relay-only; early candidates buffered) and Neko's input encoding |
| `admin/frontend/src/components/operational-projects/{RunDeck.jsx,AgentRuns.jsx,Agents.jsx,agent-run-text.js}` | Take over / Give back, reconcile panel, practice dialog, resume, Review tab, summary consent |
| `admin/frontend/src/components/AgentControlModal.jsx`, `lib/agent-control.js`, `lib/api.js`, `lib/passkey.js` | "Confirm it is you" (not sudo), retry after `control_verification_required` |
| `cmd/a7-live-probe/` | The host proof's WebRTC viewer (pion; UDP media; `-relay-check` over udp/tcp/tls) |
| `scripts/a7-probe.mjs` | The A7 host proof (18 cases) |
| `scripts/a7-host-summary.py` | Read-only: every verdict of the host run |
| Tests | `scripts/tests/test_a7_{host,live,install_live,live_e2e,probe_harness,host_summary}.py`, `a7_live_browser_e2e.mjs`; backend `operational-agent-live*.test.js`, `operational-agent-recovery.test.js`, `agent-live-client.test.js`, `agent-run-text.test.js`; journeys `admin/frontend/tests/agent-runs-a7.browser.mjs` |

## Interfaces

**Activation:** unchanged. The three Operations toggles (on since A6) and the
supervisor configuration. With no supervisor configured every execution
control, the live view and takeover answer `EXECUTION_UNAVAILABLE`. **A7
adds no environment variable.** The TURN settings live on the host
(`/etc/proxypilot-a3-proof/live.json`, written by `a7-install-live.py
enable`), and the backend receives the ICE servers from the supervisor per
viewer.

**Routes added** (under `/api/operational-projects`, all behind the Agent
runs toggle, run access, CSRF):

| Route | Access | Notes |
|---|---|---|
| `POST /:id/agent-runs` | run | also `{practice:{fixture_mode}}` (`normal`, `expired`, `locked`, `challenge`, `redirect`, `slow`); `PRACTICE_BUSY`, `PRACTICE_ACTIVE`, `FIXTURE_UNAVAILABLE`, `FIXTURE_FAILED`, `FIXTURE_NOT_RESET`; any start: `RECONCILIATION_REQUIRED` |
| `POST /:id/agent-runs/:runId/resume` | run | empty body; `RESUME_UNKNOWN`, `RESUME_NOT_ALLOWED`, `RESUME_ALREADY_STARTED`, `RESUME_STALE` (`stale_reason`) |
| `POST /:id/agent-runs/:runId/reconcile` | run + control grant | `{subject: step:<n>|call:<id>|run, decision: happened|did_not_happen|unknown|acknowledged}`; `RECONCILE_SUBJECT_UNKNOWN`, `RECONCILE_DECISION_INVALID`; audited |
| `POST /:id/agent-runs/:runId/takeover` | run + control grant | `{viewer}` (the caller's own open live view); `TAKEOVER_NOT_RUNNING`, `TAKEOVER_HELD`, `TAKEOVER_STARTING`, `TAKEOVER_VIEWER_UNKNOWN`, `TAKEOVER_FAILED`; audited with `uncontrolled_inputs` and `password_fields_empty` |
| `POST /:id/agent-runs/:runId/takeover/end` | the holder | `TAKEOVER_NOT_YOURS`, `TAKEOVER_NONE`; ends the run `taken_over` with a verified receipt |
| `GET /agent-control` | any eligible | `{verified}` for this session |
| `PUT /:id/agent-profiles/:profileId/model-summary-consent` | owner, `If-Match` | enabling needs `reviewed_statement` |
| `WS /:id/agent-runs/:runId/live` | run | exact Origin, session cookie; checked again every 10 s; ≤ 3 views per user; `ready {viewer, ice_servers, ice_transport_policy:'relay', ttl_seconds}`, `neko`, `dropped`, `closed`, `unavailable` |
| `POST /api/auth/agent-control`, `…/passkey/begin`, `…/passkey/verify` | session | password + TOTP, or a passkey; records the grant for this session (not sudo) |

A refusal without the grant is 401 `control_verification_required`; the
dashboard opens "Confirm it is you" and retries once.

**Supervisor backend socket** (A7 widening): `live` (stream; `{run_id,
attempt_id, fence}` → `{conn, ice_servers, ttl_seconds}`, then `{recv}`,
`{dropped}`, `{closed}` lines), `takeover` (`{…, conn}`), `release`,
`summarize` (`{run_id, call_id, facts}`). Codes: `LIVE_UNAVAILABLE`,
`LIVE_BUSY`, `LIVE_CONN_UNKNOWN`, `LIVE_PROTOCOL`, `LIVE_FIELDS_NOT_CLEAR`,
`NOT_TAKEN_OVER`, `SUMMARY_EXISTS`, `RUN_ACTIVE`, and for every action
`WORKER_EXITED` (never sent; certain) versus `CHANNEL_CLOSED` (in flight;
uncertain).

**TURN:** `turn:streamview.fractionate.ai:3479?transport=udp`, `…?transport=tcp`,
`turns:streamview.fractionate.ai:5350?transport=tcp` (the supervisor and the
backend accept the three forms with the installer's ports). REST credentials `<expiry>:<viewer>`
(HMAC-SHA1, one hour). coturn: `listening-ip=` the host's default-route
address (or `--listen-ip`),
`relay-ip=10.185.17.1`, relay ports 49160–49200,
`allowed-peer-ip=10.185.17.179` with every other peer denied,
`no-tcp-relay`, `no-dtls`, TLS 1.2+, `max-bps=1250000` (10 Mbit/s per
session), `user-quota=6`, `total-quota=24`.

## Deploy (user request, 2026-09-29: "commit, merge, deploy")

The dashboard deploy follows the A6 path:
1. **PR and merge.** Open the A7 PR into `main` (no template). Merge it as a
   merge commit once CI on its head is green.
2. **D1 (user, root paste): stage the merge commit** in the candidate with
   the pinned stager, exactly as for `24cfadbd`:
   `sudo sh -c 'set -e; C=<merge sha>; cd /var/lib/proxypilot/self/candidate; git fetch -q https://github.com/CyberTechArmor/ProxyPilot.git main; git merge-base --is-ancestor $C FETCH_HEAD; git show $C:scripts/a3-stage-candidate.sh | sh -s -- . $C; git rev-parse HEAD'`.
   Expected: `staged <sha> (was 776045d7…) from <merge sha>; N paths match
   exactly`.
3. **D2 (session, MCP):**
   - `run_self_checks` (`backend-tests`, `backend-syntax`) on the staged head;
   - `backup_proxypilot_db`;
   - `promote_self`: show the preview, then confirm;
   - `get_proxypilot_update_status` until `success`.

   Migration 1112 applies on start.

What the deploy changes on the live dashboard:
- the A7 UI and routes appear behind the Agent runs toggle (on);
- execution stays **unavailable**, because no supervisor is configured in the
  container (A8): Start, the live view, takeover and practice say so;
- the host daemons (supervisor, broker, demo, TURN, Neko) change only through
  H1–H4. The deploy does not install host daemons: they are root-owned and
  outside the backend by design (S6).

## Host commands (the A7 host run; not run yet)

Every step runs as root on the proof host, as one paste, in a terminal where
you can type. Review each output before the next. No step prints a secret.
**All steps H0–H7 are required** (H6 prints every verdict); the external TLS
check after H3 is recommended. **The deploy comes first** (the A7 PR merged,
its merge commit staged in the candidate, checked and promoted), so the
candidate already carries the A7 scripts and H1 stages nothing.

**Router (the user; needed for viewers outside the network, not for H1–H6):**
forward **3479/UDP, 3479/TCP and 5350/TCP** to `192.168.88.161`, the same
machine 80/443 already reach. Leave MEET's 3478/5349 forwards as they are. DNS needs
nothing: `*.fractionate.ai` already resolves `streamview.fractionate.ai` to
96.88.158.118. Caddy obtains the certificate over the existing 80/443. The
video relay is not HTTP, so Caddy cannot carry it: these three forwards are the
one step the code cannot do.

**Step H0 (read-only).**

```
sudo sh -c 'N=streamview.fractionate.ai; cd /var/lib/proxypilot/self/candidate; git rev-parse HEAD; cd scripts; python3 a3-install-supervisor.py status | grep -E "a3-worker-(supervisor|guest)|accepting_launch|key_id"; python3 a4-install-broker.py status | grep -E "a4-credential-broker|approle_login"; python3 a3-worker-operator.py status | grep -E "\"active\":"; incus exec pp-fractionate-demo -- sha256sum /opt/app/demo/server.mjs; nft list chain inet proxypilot input_hook | grep -E "iifname \"[a-z0-9*-]+\""; incus network get incusbr0 ipv4.address; ip -4 -br addr show scope global; ip -4 route get 1.1.1.1; getent ahostsv4 "$N" >/dev/null && getent ahostsv4 "$N" | head -1 || echo turn_name_unresolved; dpkg-query -W -f="\${Status}\n" coturn 2>/dev/null || echo coturn_absent; docker version --format "docker {{.Server.Version}}"; df -h --output=avail /var/lib | tail -1; grep -n "custom" /etc/caddy/Caddyfile; ls -d /etc/proxypilot-a7 /var/lib/proxypilot-a7 2>&1'
```

Expected output:
- `9341dd93267de145b4abd636645c3b187b8847e8` (the deployed staging of the
  merge `9e1d66a5`; live and candidate the same);
- supervisor `9d195ea2…`, runner `a631ad9d…`, `"accepting_launch": true`,
  key `f68c8aaf…`; broker `790a1957…`, `"approle_login": "ok"`;
  `"active": null`; demo `496846cd…`;
- the input hook's `iifname` lines (`"pp-br0"` or `"incusbr0"`, `"m2br*"`,
  `"br-*"`): whether `incusbr0` is admitted decides one line of H2;
- `10.185.17.1/24`; the host's addresses and the default route's `src`
  (the address coturn will listen on, and the router's forwards must reach);
- `96.88.158.118` for `streamview.fractionate.ai`;
- `coturn_absent`; a Docker version; at least ~6 GiB free; the Caddyfile's
  `import` of `custom`; both A7 directories absent.

A different value is a question, not a failure: paste it.

**Step H1 (reinstall the supervisor and the broker from the deployed
candidate, deploy the demo server, proxy proof).** Live stays off here.

```
sudo sh -c 'set -e; cd /var/lib/proxypilot/self/candidate; git rev-parse HEAD; cd scripts; sha256sum a3-worker-supervisor.py a3-worker-guest.py a4-credential-broker.py a3-probe-worker.py a7-install-live.py a7-probe.mjs a7-host-summary.py ../admin/frontend/demo/server.mjs; python3 a3-install-supervisor.py reinstall || { echo supervisor_reinstall_failed; journalctl -u proxypilot-a3-supervisor.service --since -10min -o cat --no-pager | tail -40; exit 1; }; python3 a4-install-broker.py reinstall || { echo broker_reinstall_failed; journalctl -u proxypilot-a4-broker.service --since -10min -o cat --no-pager | tail -40; exit 1; }; python3 a4-fixture-account.py deploy-server || { echo demo_deploy_failed; incus exec pp-fractionate-demo -- journalctl -u fractionate-demo.service --since -10min -o cat --no-pager | tail -40; exit 1; }; python3 a3-probe-proxy.py'
```

Expected output, in order:
1. `9341dd93267de145b4abd636645c3b187b8847e8`.
2. `73a89f61…`, `7185ee26…`, `10aa2a73…`, `d1bdda8a…`, `69dda3db…`,
   `b1a33ea6…`, `63a1c630…`, `d4693668…`.
3. The supervisor JSON: `"accepting_launch": true`, `"blockers": []`, a new
   `key_id` (`f68c8aaf…` archived), supervisor **`73a89f61…`**, runner
   **`7185ee26…`**, fence `e7208d60…`, fence installer `bb396c84…`, proxy
   `6c86bc36…` (unchanged).
4. The broker JSON: file **`10aa2a73…`**, `"approle_login": "ok"`,
   `previous_removed.approle_config_removed: false`.
5. The demo JSON: `previous_sha256` `496846cd…`, `server_sha256`
   **`d4693668…`**, `"service": "active"`.
6. `"proxy_checks": "passed"` with 21 codes.

If it fails: "A worker attempt is live": `python3 a3-worker-operator.py
status`, then `stop` it. `*_failed`: the journal lines after it name the cause.

**Step H2 (coturn, the host firewall, the Caddy site for the certificate).**

```
sudo sh -c 'set -e; N=streamview.fractionate.ai; F=/var/lib/proxypilot/firewall.json; apt-get update -qq; apt-get install -s --no-install-recommends coturn | grep -E "^(Inst|Remv)" | cut -c1-100; if apt-get install -s --no-install-recommends coturn | grep -qiE "^(Inst|Remv) [^ ]*incus"; then echo apt_would_touch_incus; exit 1; fi; systemctl mask coturn.service; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends coturn >/dev/null; echo "coturn $(dpkg-query -W -f="\${Version}" coturn) $(systemctl is-active coturn.service || true) $(systemctl is-enabled coturn.service || true)"; for r in 3479:udp 3479:tcp 5350:tcp; do p=${r%:*}; t=${r#*:}; grep -q "\"manual-host-operator-$p-$t\"" $F || proxypilot firewall add-manual --port $p --proto $t --scope public --reason "A7 TURN relay for the live agent view"; done; if nft list chain inet proxypilot input_hook | grep -q "iifname \"incusbr0\" accept"; then echo relay_ports_admitted_by_bridge_rule; else grep -q "\"manual-host-operator-49160-49200-udp\"" $F || proxypilot firewall add-manual --port 49160 --port-end 49200 --proto udp --scope lan-only --source-cidr 10.185.17.179/32 --reason "A7 TURN relay ports, from the proof VM only"; fi; nft list ruleset | grep -E "dport (3479|5350|49160-49200)"; cd /var/lib/proxypilot/self/candidate/scripts; python3 a7-install-live.py install-turn --hostname "$N" --caddy-site'
```

Expected output:
1. The simulated `Inst` lines: `coturn` and its libraries only, no `Remv`,
   nothing Incus (else `apt_would_touch_incus` and nothing is installed).
2. `coturn <version> inactive masked` (the distribution unit never runs).
3. The firewall's own output for each new rule; `relay_ports_admitted_by_bridge_rule`
   **or** the relay-port rule for `10.185.17.179/32` only.
4. The rendered rules: `udp dport 3479 accept`, `tcp dport 3479 accept`,
   `tcp dport 5350 accept` (and the relay-port rule when added); MEET's own
   `service-l4-…` rules for 3478/udp and 5349/tcp are listed too and stay.
5. `{"caddy_site": "/etc/caddy/custom/pp-a7-turn.caddy", "next": "Wait for
   Caddy to obtain the certificate, …"}`.

Wait a minute or two, then check that Caddy has the certificate:
`sudo ls /var/lib/caddy/.local/share/caddy/certificates/*/streamview.fractionate.ai/`
shows `streamview.fractionate.ai.crt` and `.key`. If not, Caddy's log says why
(`journalctl -u caddy --since -10min | grep -i streamview`).

**Step H2b (this host only: H2 ran here with the old ports on 2026-09-29).**
After the port move is deployed (the candidate carries it), reinstall the
supervisor (it accepts the installer's ports now), move the three firewall rules
from 3478/5349 to 3479/5350 (MEET's own `service-l4-…` rules are not touched),
and confirm the Caddy site and its certificate.

```
sudo sh -c 'set -e; N=streamview.fractionate.ai; F=/var/lib/proxypilot/firewall.json; cd /var/lib/proxypilot/self/candidate/scripts; git -C .. rev-parse HEAD; sha256sum a3-worker-supervisor.py a7-install-live.py; python3 a3-install-supervisor.py reinstall || { echo supervisor_reinstall_failed; journalctl -u proxypilot-a3-supervisor.service --since -10min -o cat --no-pager | tail -40; exit 1; }; for id in manual-host-operator-3478-udp manual-host-operator-3478-tcp manual-host-operator-5349-tcp; do if grep -q "\"$id\"" $F; then proxypilot firewall remove-manual $id; fi; done; for r in 3479:udp 3479:tcp 5350:tcp; do p=${r%:*}; t=${r#*:}; if ! grep -q "\"manual-host-operator-$p-$t\"" $F; then proxypilot firewall add-manual --port $p --proto $t --scope public --reason "A7 TURN relay for the live agent view"; fi; done; nft list ruleset | grep -E "dport (3478|3479|5349|5350)"; python3 a7-install-live.py install-turn --hostname "$N" --caddy-site; ls /var/lib/caddy/.local/share/caddy/certificates/*/streamview.fractionate.ai/ 2>&1 || true'
```

Expected output, in order:
1. The deployed candidate HEAD; the new supervisor and installer digests.
2. The supervisor JSON: `"accepting_launch": true`, `"blockers": []`, a new
   `key_id` (`60e70fc9…` archived), runner `7185ee26…` unchanged.
3. Three `remove-manual … → reconciled` lines, then three `add-manual
   manual-host-operator-3479-udp / -3479-tcp / -5350-tcp → reconciled`.
4. The rendered rules: ours on `3479` udp/tcp and `5350` tcp, and MEET's
   `service-l4-…` on `3478` udp and `5349` tcp, unchanged.
5. `{"caddy_site": "/etc/caddy/custom/pp-a7-turn.caddy", "next": …}`. The
   installer refuses first if anything listens on 3479 or 5350
   (`Something else already listens on the relay ports …`).
6. The certificate files, or `No such file or directory` if Caddy has not
   obtained it yet: check again after a minute (Caddy's log:
   `journalctl -u caddy --since -10min | grep -i streamview`).

**Step H3 (TURN, Neko, the probe, the VM, enable; detached, ~15–25 min).**
It snapshots the proof VM first (`pp-a7-pre-live-<stamp>`; the pre-network
snapshot is not touched) and pushes the packages; the VM never reaches the
network.

```
sudo mkdir -p -m 700 /var/lib/proxypilot-a7-proof; setsid nohup sudo sh -c 'trap "echo h3_end" EXIT; set -e; N=streamview.fractionate.ai; cd /var/lib/proxypilot/self/candidate/scripts; python3 a7-install-live.py install-turn --hostname "$N" || { echo turn_install_failed; journalctl -u proxypilot-a7-turn.service --since -10min -o cat --no-pager | tail -30; exit 1; }; python3 a7-install-live.py build-neko || { echo neko_build_failed; exit 1; }; python3 a7-install-live.py build-probe || { echo probe_build_failed; exit 1; }; python3 a7-install-live.py provision-vm || { echo provision_failed; exit 1; }; python3 a7-install-live.py enable || { echo enable_failed; exit 1; }; python3 a3-install-supervisor.py status | grep -E "accepting_launch|blockers"' > /var/lib/proxypilot-a7-proof/h3.log 2>&1 < /dev/null &
```

Read it (repeat until `h3_end`):

```
sudo grep -E '"(sha256|active|ports|certificate|cert_timer|live_marker|fence_live_relay|missing_libraries|snapshot|accepting_launch)"|_failed|refused|h3_end' /var/lib/proxypilot-a7-proof/h3.log
```

Expected: the TURN status (`"active": "active"`, ports `3479` and `5350`
`true`, `"certificate": true`, `"cert_timer": "active"`); Neko's `sha256`
(record it); the probe's `sha256`; the VM files with the snapshot name,
`"missing_libraries": []` and the Neko/policy digests; after `enable`,
`"fence_live_relay": true`, `"live_marker": true`; `"accepting_launch": true`,
`"blockers": []`; then `h3_end` with no `_failed` line.

**Step H3b (this host only: H3 stopped at `provision-vm` on 2026-09-29).**
The relay, Neko and the probe are already built (their journal entries and
binaries stay), so only the VM step and the enable run again, from the
candidate carrying the package fix. It takes a new `pp-a7-pre-live-…` snapshot
first, like H3.

```
setsid nohup sudo sh -c 'trap "echo h3b_end" EXIT; set -e; cd /var/lib/proxypilot/self/candidate/scripts; git -C .. rev-parse HEAD; sha256sum a7-install-live.py; python3 a7-install-live.py provision-vm || { echo provision_failed; exit 1; }; python3 a7-install-live.py enable || { echo enable_failed; exit 1; }; python3 a3-install-supervisor.py status | grep -E "accepting_launch|blockers"' > /var/lib/proxypilot-a7-proof/h3b.log 2>&1 < /dev/null &
```

Read it (repeat until `h3b_end`):

```
sudo grep -E '"(snapshot|debs|neko_sha256|policy_sha256|missing_libraries|live_marker|fence_live_relay|accepting_launch)"|_failed|refused|h3b_end' /var/lib/proxypilot-a7-proof/h3b.log
```

Expected: the candidate HEAD and the installer's digest; `"snapshot":
"pp-a7-pre-live-…"`, the package list, the Neko and policy digests,
`"missing_libraries": []`; after `enable`, `"fence_live_relay": true` and
`"live_marker": true`; `"accepting_launch": true`, `"blockers": []`; then
`h3b_end`. If the VM lacks a package, the refusal now names it
(`… Depends: <package> … but it is not installable`): paste
`sudo tail -40 /var/lib/proxypilot-a7-proof/h3b.log`.

**Recommended, from a machine outside your network** (a phone hotspot is
enough):
`openssl s_client -connect streamview.fractionate.ai:5350 -servername streamview.fractionate.ai -brief </dev/null 2>&1 | head -4`
→ `Verification: OK` (the router forward and the certificate as a viewer sees
them).

**Step H4 (the proofs, detached, ~30–40 min): a new A4 binding, the A3 proof
in live mode, the A4 proof, the A7 proof, two canaries.** About 20 real
provider calls; reboots the proof VM's guest once (`guest_crash`).

```
setsid nohup sudo sh -c 'trap "echo h4_end" EXIT; set -e; OK=openai-api-key; FK=a4-fixture-password; cd /var/lib/proxypilot/self/candidate/scripts; OLD=$(cat /var/lib/proxypilot-a4/proof-binding); python3 a4-broker-operator.py revoke --binding "$OLD" || true; mv /var/lib/proxypilot-a4/proof-binding /var/lib/proxypilot-a4/proof-binding.$OLD; python3 a4-broker-operator.py provider --vault-key "$OK"; B=$(cat /proc/sys/kernel/random/uuid); P=$(cat /proc/sys/kernel/random/uuid); Q=$(cat /proc/sys/kernel/random/uuid); python3 a4-broker-operator.py bind --binding $B --project $P --profile $Q --username a4-fixture@demo.fractionate.ai --vault-key "$FK"; umask 077; echo "$B" > /var/lib/proxypilot-a4/proof-binding; echo "binding=$B"; python3 a4-fixture-account.py provision --binding $B; set +e; python3 a3-probe-worker.py; echo "a3_exit=$?"; python3 a4-probe.py --binding "$B"; echo "a4_exit=$?"; python3 a4-canary-scan.py --binding "$B" > /var/lib/proxypilot-a7-proof/canary-a4.json; echo "canary_a4_exit=$?"; node --no-warnings a7-probe.mjs; echo "a7_exit=$?"; D=$(ls -td /var/lib/proxypilot-a7-proof/*/ | head -1); B7=$(cat "$D/last-binding"); python3 a4-canary-scan.py --binding "$B7" --a7-dir "$D" > /var/lib/proxypilot-a7-proof/canary-a7.json; echo "canary_a7_exit=$?"' > /var/lib/proxypilot-a7-proof/h4.log 2>&1 < /dev/null &
```

Read it (repeat until `h4_end`; the shell's `[1]+ Done` right after the start
is `setsid` handing over):

```
sudo sh -c 'L=/var/lib/proxypilot-a7-proof/h4.log; grep -E "^binding=|\"(worker_proof|a4_proof|a7_proof|provisioned)\"|_exit=|h4_end|Traceback" $L; echo "case_lines=$(grep -cE "^\{\"case\"" $L)"; grep -E "^\{\"case\".*\"passed\": ?false" $L | cut -c1-700; grep -h "\"canary_scan\"" /var/lib/proxypilot-a7-proof/canary-a*.json'
```

Expected (`case_lines=44` at the end: 20 A3, 6 A4, 18 A7; no failed-case
line):
1. `binding=…`, `"provisioned": true`.
2. `"worker_proof": "passed"` with **20** cases (`backend_refusals` now
   carries `takeover: INVALID_REQUEST` and `takeover_unknown_viewer:
   LIVE_CONN_UNKNOWN`), then `a3_exit=0`.
3. `"a4_proof": "passed"` with six cases, `a4_exit=0`; `canary_a4_exit=0`.
4. **18** A7 cases, each passed, in this order (the report lists them): `live_view`,
   `live_refusals`, `dashboard_takeover`, `resume_new_run`,
   `takeover_during_submit`, `grant_loss_while_holding`,
   `coordinator_killed_while_holding`, `timeout_is_a_decision`,
   `model_proof_switches`, `model_summary`, `account_loss_while_holding`,
   `key_loss_while_holding`, `worker_killed_mid_read`,
   `worker_killed_mid_approval`, `coordinator_killed_mid_read`,
   `coordinator_killed_mid_approval`, `coordinator_killed_mid_write`,
   `worker_killed_mid_write`; then `"a7_proof": "passed"`, `a7_exit=0`.
5. `canary_a7_exit=0`; both `"canary_scan": "passed"`; then `h4_end`.

If an A7 case fails, its line carries `error.code` and a typed `detail`; the
report is `/var/lib/proxypilot-a7-proof/<stamp>/a7-proof-<stamp>.json`. Paste
the line. The two `_mid_write` cases rely on the submit taking longer than
300 ms at the host; a submit that finished first shows as `the submit in
flight is uncertain` and is tuned with `A7_PROBE_SUBMIT_IN_FLIGHT_MS`.

**Step H5 (the A5 proof in live mode, one human approval; the A5 canary).**
In a terminal where you can type. At the prompt, check the fields and type at
least the first 12 characters of the approval digest.

```
sudo sh -c 'cd /var/lib/proxypilot/self/candidate/scripts; node --no-warnings a5-probe.mjs; echo "a5_exit=$?"; D=$(ls -td /var/lib/proxypilot-a5-proof/*/ | head -1); B=$(cat "$D/last-binding"); python3 a4-canary-scan.py --binding "$B" --a5-dir "$D" --a5-marker > /var/lib/proxypilot-a7-proof/canary-a5.json; echo "canary_exit=$?"; grep -E "\"canary_scan\"" /var/lib/proxypilot-a7-proof/canary-a5.json'
```

Expected: 17 case lines, each `"passed": true`; `"a5_proof": "passed"`;
`a5_exit=0`; `canary_exit=0` and `"canary_scan": "passed"`.

**Step H6 (read-only summary; required).**

```
sudo sh -c 'python3 /var/lib/proxypilot/self/candidate/scripts/a7-host-summary.py; echo "summary_exit=$?"'
```

Expected: one JSON document with `a3` passed 20/20 and
`"after_live_enabled": true`, `a4` 6/6, `a5` 17/17, `a7` 18/18 with
`"live": true`, `"all_cases": true` and the live view's `fps` (at least 10)
and relay pair, `live_install` (Neko, probe, VM files, TURN name and LAN
address, `enabled`, `"marker_present": true`), three canaries passed with
`unclean_sinks: []`, `"all_passed": true`, then `summary_exit=0`. Paste the
whole document.

**Step H7 (from the session, read-only):** `run_self_checks`
(`backend-tests`, `backend-syntax`) on the candidate head;
`get_host_services proxypilot-a`; `inspect_a3_vm` (the boot changes in H4).

**Not part of this run:** the reboot test (`a6-reboot-check.py`) runs only
when the user chooses. The dashboard's own live view over the internet needs
the deploy and the supervisor mount (A8); A7 proves the same client in
Chromium over UDP, TCP and TLS TURN locally, and the host's TURN listeners,
certificate and scope on the host.

**Local checks** (from a repository checkout's root; the live tests need a Neko
build and the probe, `A7_TEST_NEKO`, `A7_TEST_PROBE`):

```
python3 -m unittest discover -s scripts/tests -p 'test_a[34567]*py'
(cd admin/backend && node --test src/__tests__/agent-*.test.js src/__tests__/operational-*.test.js src/__tests__/operations-toggles.test.js)
python3 scripts/host-boundary-inventory.py
(cd admin/frontend && npm run build && node tests/agent-runs.browser.mjs && node tests/agent-runs-a7.browser.mjs)
```

## Rollback order

1. `python3 a7-install-live.py disable` (live marker removed first, then the
   fence line, then the relay stopped). From the next launch attempts are
   headless again.
2. `systemctl disable --now proxypilot-a7-turn-cert.timer`;
   `rm /etc/caddy/custom/pp-a7-turn.caddy && systemctl reload caddy`;
   `proxypilot firewall remove-manual manual-host-operator-3479-udp` (and
   `-3479-tcp`, `-5350-tcp`, and the relay-port rule if H2 added it; never
   MEET's `service-l4-…` rules). coturn may
   stay installed with its distribution unit masked.
3. The VM: `incus snapshot restore pp-agents-a3-debian13-proof-20260927 pp-a7-pre-live-<stamp>`
   (removes Neko and the packages; never the pre-network snapshot).
4. The host daemons: in the candidate, `git checkout 776045d7 --
   scripts/a3-worker-supervisor.py scripts/a3-worker-guest.py
   scripts/a3-install-fence.py scripts/a3-network-fence.py
   scripts/a4-credential-broker.py admin/frontend/demo/server.mjs`, commit,
   then `a3-install-supervisor.py reinstall` (`9d195ea2…`, new key),
   `a4-install-broker.py reinstall` (`790a1957…`) and
   `a4-fixture-account.py rollback-server --to previous` (`496846cd…`).
5. Nothing was deployed or promoted, so the live dashboard and its database
   need no rollback. Migration 1112 reaches the live database only with a
   future deploy.

## Rules for every conversation

- Everything in the A3–A6 references still applies (never touch `pp-nodus`
  or `nodus.fractionate.ai`; never `--upgrade-incus` or an Incus archive;
  never bypass managed-LXC refusals; never weaken a test or a proof; host root
  runs as one reviewed paste; daemons run from installed copies; no secret in
  the conversation, a command line, the repository, a log or MCP; never trip
  the demo's shared sign-in limit; keep `scripts/tests/a3-vm-probe.zip` and
  the pre-network snapshot).
- Human-only: no MCP tool, catalog entry or policy allowlist starts,
  approves, stops, reconciles, takes over, resumes or watches a run, or
  changes a toggle (ratchets in `operational-agent-runs.test.js` and
  `operational-agent-live.test.js`).
- Takeover and reconciliation need the session's own verification, never
  sudo; approval still needs sudo and the typed digest.
- Video and frames are never stored; typed text is never recorded (counts by
  kind only); the TURN credential is per viewer and never logged.
- An uncertain write is decided by a person; nothing is re-sent on their
  behalf. `WORKER_EXITED` is certain; `CHANNEL_CLOSED` and
  `COORDINATOR_RESTART` are not.
- Nothing merges, deploys or promotes until the user says so. The reboot test
  runs only when the user chooses.
