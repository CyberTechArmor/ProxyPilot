# NEXT SESSION PROMPT — Finish Firewall + VPN dashboard panels

## Context

You are picking up the ProxyPilot Firewall + VPN + SSH dashboard
work. Most of the original scope is shipped on
`claude/proxypilot-firewall-vpn-ssh-dx29t` (PR not yet opened).
This prompt covers the remaining pieces.

### Already shipped on this branch

1. CLI `proxypilot vpn status --json` (server config + live wg0 state).
2. Backend `admin/backend/src/routes/firewall.js` — full surface.
3. Backend `admin/backend/src/routes/vpn.js` — full surface, with
   lockout-gate handshake mirroring `ssh-access.js` for
   `LAST_ENABLED_PEER` / `LAST_FULL_ADMIN_DEMOTE` / `RECENTLY_ACTIVE`.
4. Frontend `admin/frontend/src/lib/api.js` — firewall + vpn
   helpers, plus password-auth helpers.
5. Frontend `admin/frontend/src/pages/Firewall.jsx` — **core** only:
   status card, rules tabs (Base / Discovered / Manual), enable /
   disable toggle, set-scope dropdown, Reconcile + Scan buttons.
6. SSH UX bonus work the operator requested mid-session:
   - Add-device modal widened to 95vw (was clipping on >=sm
     viewports because `DialogContent`'s base class includes
     `sm:max-w-lg`).
   - Bootstrap paste-back textarea + Submit under the script.
   - PowerShell bootstrap variant
     (`proxypilot ssh access bootstrap-script <id> --shell powershell`)
     with `cmd.exe /c` workaround for empty-string args to
     ssh-keygen, OpenSSH-Client capability prereq probe.
   - Per-row "Connect" button on the SSH Access table that opens
     a copy-friendly dialog with bash + PowerShell forms of
     `ssh -i ~/.ssh/proxypilot_<id>_ed25519 <user>@<host>`.
   - Operator-driven `proxypilot ssh password-auth` CLI + backend
     route + dashboard Switch with typed-phrase gate. Supersedes
     the spec's "no automatic flip" line — the explicit
     operator-driven toggle is now the supported path.

### Hard constraints (unchanged)

- Backend NEVER imports from `cli/`. Shell out via `execOnHost`
  + `nsenter` only. The CLI source tree is on the host at
  `$INSTALL_DIR/cli/`, not inside the admin Docker container.
  Importing it crashes the container at startup.
- POSIX single-quote escape on every operator-supplied argv
  token. `JSON.stringify` would re-introduce `$()`/backtick
  command substitution. Read `shellSingleQuote` in
  `admin/backend/src/routes/ssh-access.js` and copy it; the
  firewall and vpn routes already use this exact helper.
- Private keys never round-trip the dashboard. The
  `vpn peer add` response carries the private key once; the
  frontend renders the QR + textarea once, the backend NEVER
  persists it, the audit row references the public key only.
- Never lock the operator out. Every destructive action goes
  through the same typed-phrase modal pattern the SSH access
  panel uses (revoke + password-auth-disable).

### Branch policy

Stay on `claude/proxypilot-firewall-vpn-ssh-dx29t`. Do not merge
to main, do not rebase, do not push to any other branch. Push
after every commit.

---

## Scope of this session

### 1. Firewall.jsx — finish the page (3 small commits)

**1a. Add-manual rule modal.** A "+ Add manual rule" button in
the card header opens a dialog with fields:
  - `port_start` (required, integer 1–65535)
  - `port_end` (optional integer; if set, rendered as range)
  - `proto` (`tcp` | `udp`)
  - `scope` (`public` | `lan-only` | `vpn-only` | `localhost-only`)
  - `service` (text, only when scope=vpn-only)
  - `source_cidrs` (comma-separated text, parsed to array)
  - `reason` (required text)
Submit calls `api.addFirewallManualRule(body)` then refreshes.
Backend already implements `POST /api/firewall/manual` with the
matching schema; mirror exactly.

**1b. Egress tab.** A 4th tab next to Base / Discovered / Manual.
Calls `api.listFirewallEgress()` (returns
`{ ok, services: NAMED_SERVICES_map, entries: [{container, allow, reason, container_ip}] }`).
Render entries as a table with columns `container | service(s) | reason | container ip | actions`.
"+ Add egress" modal: container, service (`<select>` populated from
`status.services`), reason, optional container_ip.
Per-row "Deny" button calls `api.denyFirewallEgress({ container, service })`.

**1c. Panic-close / panic-open + public-internet enable confirm.**
Two buttons in the card header (or a small dropdown menu): "Panic
close" (destructive variant) and "Panic open". Panic close goes
through a typed-phrase Dialog using `'close everything to
recovery state'` as the phrase. Panic open is a simple
confirmation. Calls `api.panicCloseFirewall()` /
`api.panicOpenFirewall()`. Status card already surfaces
`panic_close` so render that flag prominently when set
(amber alert box at top of card).

Also: the rule enable path for `scope === 'public'` should trip a
short typed-phrase confirm modal (`'open this port to the public
internet'`) before calling `api.enableFirewallRule`. Backend
always passes `--yes` to the CLI; the dashboard is the only place
the operator confirms.

### 2. Vpn.jsx — entire page (2–3 small commits)

**2a. Page skeleton + status card + peer table (no mutations
yet).** Route `/vpn`, sidebar entry behind `Cable` icon (admin
only). Server-status card from `api.listVpn()` showing endpoint,
listen port, server public key, base-wireguard rule state, live
peer count. Empty-state if VPN not enabled (button to open the
"Enable VPN" modal). Peer table: name, ip, scope (chip,
optionally with services list), enabled, online, last handshake
(relative), rx/tx (formatted bytes).

**2b. Add-peer modal — the QR / private-key reveal.** Button
"+ Add peer" in card header. Form: name, scope dropdown
(`full` / `admin` / `services`), services chip input (only when
scope=services). On submit, `api.addVpnPeer(body)` returns
`{ ok, name, ip, scope, services, public_key, config, private_key, ... }`.
The dialog flips to a "save now — server cannot reprint" view
with:
  - Red banner warning the private key is shown once
  - Textarea with the full `[Interface]` / `[Peer]` config (copy
    button)
  - QR code rendering of the config (use `qrcode.react` or hit
    `/api/vpn/peers/<name>/qr` if you add a CLI surface for it;
    simplest path: render client-side with a small QR library —
    `qrcode.react` is already a common pick).
  - "I've saved it" button that closes the dialog. The state on
    the dashboard is wiped from React on close; nothing
    round-trips back to the server.

**2c. Per-peer actions: rotate / enable / disable / remove /
set-scope.** Each row gets an actions dropdown. Rotate also
renders the same QR + textarea reveal as add (the response
shape is identical). Disable / remove with the lockout-gate
typed phrases:
  - `'I understand this locks everyone out'` for
    `LAST_ENABLED_PEER` (disable + remove)
  - `'remove this active peer'` for `RECENTLY_ACTIVE` (remove)
  - `'demote the last admin peer'` for `LAST_FULL_ADMIN_DEMOTE`
    (set-scope)

The backend already 409s with `requires_force: true` and the
`code` field; the frontend just needs to read `e.code` off the
`ApiError` and pick the right phrase.

**2d. Enable VPN modal.** Triggered when status is "not
enabled". Form: endpoint (`host:port`), listen_port (default
51820), dns (default 10.100.0.1). Calls `api.enableVpn(body)`.
After success, refresh the page state and the server-status
card lights up.

### 3. Audit pass (1 commit)

Re-read each of the firewall + vpn route files commit by commit
against the constraints. Probe the backend with adversarial
values to confirm the shell escape holds end-to-end:
  - peer name `$(id)` — should reject at the schema layer
    (regex), but verify the second-line defense at
    `shellSingleQuote` works too
  - reason text containing `'; rm -rf / #` — should land literally
    in the audit row
  - service tag with backticks — same
  - source_cidr with `; nft list ruleset` injected — schema
    rejects via the cidr regex
  - peer name with embedded newline — schema rejects

Spot-check that no path uses `JSON.stringify` to interpolate
operator input into a shell command. Spot-check that no path
imports from `cli/`. Spot-check that the vpn add-peer response
pathway doesn't ever call `logAudit` with `private_key` in the
details object.

If anything fails, fix it in a separate commit at the end of
this session. Don't amend.

---

## Stretch goals (if time permits, in this order)

1. **SSH last-seen TZ fix.** `cli/src/core/ssh-access/last-seen.js`
   parses `last` output and writes `last_seen_at` in SQLite. The
   dashboard's `fmtRelative` shows ~6h offset on Linux servers
   in non-UTC zones. Likely a `new Date(...)` parsing assumption.
   Fix in the touch script and re-run the touch job to recompute.

2. **SSH active-sessions column.** Add
   `proxypilot ssh access who --json` returning
   `{ ok, sessions: [{unix_user, fingerprint?, login_at, from_host, from_ip}] }`.
   Parse `who -u` or `loginctl list-sessions --output=json`.
   Match sessions to ssh-access rows by `unix_user` (best effort —
   sshd doesn't surface which authorized_keys line authenticated
   the session unless `LogLevel VERBOSE` and parsing
   `/var/log/auth.log` or `/var/log/secure`). Ship a "Connected"
   column on the SSH Access table that lights up green when a
   session for the row's unix_user is currently active. Make it
   clear in the column header that this is per-unix-user, not
   per-key, unless we add the auth.log parsing path.

---

## Hard segmentation rules (non-negotiable)

- Reads ≤ 200 lines. Grep first, then Read with offset + limit.
- Edits are targeted.
- TodoWrite checkpoints between segments.
- One checklist item = one commit. Push after every commit.
- The operator on this project explicitly prefers smaller
  sections so responses don't time out — keep tool-call batches
  modest.

---

## What NOT to do

- Do not implement the SSH CA chain (build-sequence steps 8–12
  / 15) — still shelved indefinitely per the original prompt.
- Do not modify the SSH access manager's existing reconcile,
  add, revoke, or remove paths — those are frozen at d4f9e3f
  except for the additions explicitly listed above (paste-back,
  PowerShell variant, Connect modal, password-auth toggle).
- Do not push to main, the firewall branch, or any step
  5 / 6 / 7 / SSH-access branch.
- Do not import from `cli/` in any `admin/backend` file.
- Do not use `JSON.stringify` for shell quoting.
- Do not flip `PasswordAuthentication no` automatically. The
  manual toggle is the supported path.

---

## Begin

After reading the existing route files (`firewall.js`, `vpn.js`)
and the existing Firewall.jsx + SshAccess.jsx for pattern
reference, post a one-paragraph plan covering:
  1. Firewall.jsx finish (which of 1a / 1b / 1c first, why).
  2. Vpn.jsx structure (which subsection ships first, what
     gates land in which commit).
  3. Audit-pass cadence (separate commit at the end vs inline).

Wait for go.
