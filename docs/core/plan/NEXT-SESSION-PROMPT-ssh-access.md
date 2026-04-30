# Next session — SSH Access Manager (per-device authorized_keys)

You are picking up the ProxyPilot Firewall + VPN + SSH upgrade.
Five things are already shipped — do **not** re-implement any of
them:

* Firewall manager (steps 1–4) — see
  `docs/core/plan/phase-08b-firewall-manager.md`.
* VPN server (step 5) — see `docs/core/plan/phase-12a-vpn-server.md`.
* VPN peer lifecycle (step 6) — six commits ending at `c5bef94`
  on `claude/setup-vpn-step6-prompt-OqCEZ`.
* Per-peer scope at L4 + L7 (step 7a/7b) — fourteen commits ending
  at `986a74c` on `claude/proxypilot-firewall-vpn-ssh-WT5n1`.

## Spec deviation — read this first

The SSH Certificate Authority chain (build sequence steps 8 → 12
plus step 15) is **shelved indefinitely**. The deviation note is
at the top of `## SSH Certificate Authority` in
`proxypilot-firewall-vpn-ssh-prompt.md` and the replacement spec
is the section immediately after it:
`## SSH Access Management (per-device authorized_keys)`.

Read that section end-to-end before writing code. It defines the
SQLite table, the JSON state file, the reconcile loop, the seven
CLI subcommands, the bootstrap script the operator copies to a
new device, and the dashboard panel.

The sections elsewhere in the spec that still apply unchanged:

* `## Design Principles (specific to this upgrade)` — state-driven,
  default deny, **never lock the operator out**, atomic file
  writes, determinism.
* `## Implementation Constraints` — atomic file writes, no private
  keys in SQLite or audit logs, lockout safety on every relevant
  command.
* The composition note at the bottom of the new section: SSH
  scope-to-VPN is `vpn peer add` + `firewall set-scope base-ssh
  vpn-only`. No new code for that path; it's already shipped.

## Branch

The harness will assign a branch. Stay on it. Branch off
`claude/proxypilot-firewall-vpn-ssh-WT5n1` (head `986a74c`) so
step 7's per-peer scope is present. Do **not** push to main, the
firewall branch, or any step 5 / 6 / 7 branch.

## Scope of this session — SSH access manager (full)

Backend + CLI + bootstrap script + dashboard panel for the
per-device `authorized_keys` access manager defined in the new
spec section. Single session. The dashboard panel for firewall +
VPN (the larger step-14 work) is the session **after** this one
and lands separately.

## What "done" looks like

### Schema + state

* `cli/src/db/schema.js` — additive `CREATE TABLE IF NOT EXISTS
  ssh_access` with the columns in the spec
  (`id PRIMARY KEY`, `unix_user`, `public_key`, `fingerprint
  UNIQUE`, `device_label`, `added_at`, `added_by`, `revoked_at`,
  `revoked_by`, `revoked_reason`, `last_seen_at`). Same
  PRAGMA-guarded pattern as steps 7a/7b — append, no migration
  framework.

* `cli/src/core/ssh-access/state.js` — read / write
  `/var/lib/proxypilot/ssh-access.json` (mode 0600 — pubkeys
  aren't secret, but the file lives next to firewall.json which
  IS sensitive, and the consistent perms make audit easier).
  `.tmp` + rename via the shared `atomicWrite` helper from
  `cli/src/core/vpn/server.js`. Mirror to SQLite on every write
  via the same `mirrorToSqlite()` pattern firewall state.js uses.

### Core mutations

* `cli/src/core/ssh-access/index.js` exposes:
  * `addEntry({ id, unixUser, pubkey, label, actor })` — validates
    the pubkey by piping through `ssh-keygen -l -f -` (rejects
    parse failures), rejects duplicate `id` or `fingerprint`
    (active or revoked — the operator should pick a new id rather
    than re-use a known-revoked fingerprint). Inserts the row,
    writes JSON, calls `reconcile`. Audit `ssh-access.add`.
  * `revokeEntry({ id, reason, actor })` — sets `revoked_at` /
    `revoked_by` / `revoked_reason`, writes JSON, reconciles.
    Audit `ssh-access.revoke`.
  * `removeEntry({ id, actor })` — hard-deletes the SQLite row
    AND writes the audit row (with the deleted fingerprint
    captured in `before_json` so the trail is recoverable).
    Reconciles. Audit `ssh-access.remove`.
  * `listEntries({ filter })` — filter ∈ `'all' | 'active' |
    'revoked'`. Returns rows sorted by `unix_user` then `id`.
  * `showEntry(id)` — returns one row including the
    last-handshake parse (best-effort `lastlog` / `last`).

* `cli/src/core/ssh-access/reconcile.js` exposes
  `reconcile({ dryRun, actor })`:
  * For each distinct `unix_user` with at least one active row
    (or one row that *was* active and got revoked since the last
    reconcile — see "preserve operator-added lines" below),
    rewrites `~<unix_user>/.ssh/authorized_keys`.
  * Strategy: read the existing file, split on lines, **preserve
    every line that does not end with `# proxypilot:<id>`**, then
    append one `pubkey # proxypilot:<id>` line per active row in
    `id`-sorted order. Operator-added keys (no trailing marker)
    survive untouched.
  * Atomic-write the new file (`.tmp` + chmod 0600 + rename) and
    `chown`s to the target user's uid:gid (resolved via
    `os.userInfo()` or a `getent passwd` shell-out for users
    that don't match the current process).
  * Returns `{ applied: bool, users: [{ user, before_count,
    after_count }], warnings: [] }` so the CLI can render the
    diff. Audit one `ssh-access.reconcile` row per affected user
    with the before/after counts.
  * `dryRun: true` returns the planned rewrites without touching
    disk. Used by `proxypilot ssh access reconcile --dry-run`.

* Reconcile is triggered automatically after every mutation
  (`addEntry` / `revokeEntry` / `removeEntry`). Mirrors the
  step-7 pattern: durable mutation first, reconcile second, both
  return value sub-objects so the CLI can surface warnings.

### CLI

`cli/src/commands/ssh-access/` — one file per subcommand, plus
`index.js` re-exports. Commands:

```
proxypilot ssh access add <id> --user <u> --pubkey <path|->
                                [--label <text>]
proxypilot ssh access revoke <id> [--reason <text>]
proxypilot ssh access remove <id>
proxypilot ssh access list [--all|--active|--revoked]
proxypilot ssh access show <id>
proxypilot ssh access reconcile [--dry-run]
proxypilot ssh access bootstrap-script <id>
                       [--user <u>] [--server <host>]
```

* `--pubkey -` reads from stdin (so the bootstrap-script's
  heredoc form works directly).
* Wire into `cli/bin/proxypilot.js` as a top-level
  `ssh access` command group. Mirror the existing `firewall` /
  `vpn peer` group structure exactly.

### Bootstrap script

* `bootstrap-script <id>` emits the shell snippet from the spec
  (see `## SSH Access Management → ### CLI Surface →
  bootstrap-script` for the exact body). The output is plain
  text to stdout — **no** server-side write happens; the
  operator copies the snippet to the new device, runs it, and
  pastes the resulting `proxypilot ssh access add` heredoc back
  into a server shell.
* `--server <host>` substitutes the operator's hostname into the
  printed `ssh -i ... <user>@<server>` line. `--user` likewise.
  Both are placeholders if absent.
* The script never sends anything to the server. Same trust
  model as `ssh-copy-id`, no privileged channel required.

### Dashboard panel

* New page `admin/frontend/src/pages/SshAccess.jsx`:
  * Table of active devices with columns: id, unix_user, label,
    fingerprint (short), added_at (relative), added_by, last_seen
    (relative if present, "—" otherwise).
  * "Add device" button → modal with two tabs:
    1. **Bootstrap script**: a `<pre>` block showing the script
       output, with a copy-to-clipboard button. The operator
       runs it on their device.
    2. **Paste public key**: a form with id / unix_user / label /
       pubkey-textarea fields that POSTs to the backend.
  * Per-row "Revoke" button with confirmation modal and optional
    reason field.
  * Tabs: "Active" (default) / "Revoked" / "All".
  * Filter inputs for unix_user and label.
* Backend route file `admin/backend/src/routes/ssh-access.js`
  exposes:
  ```
  GET    /api/ssh-access?filter=active|revoked|all
  GET    /api/ssh-access/:id
  POST   /api/ssh-access            { id, unix_user, public_key, label }
  POST   /api/ssh-access/:id/revoke { reason }
  DELETE /api/ssh-access/:id
  POST   /api/ssh-access/reconcile  { dry_run }
  GET    /api/ssh-access/:id/bootstrap-script?user=&server=
  ```
* Backend wraps the CLI core functions directly (same import
  path the CLI commands use). Auth + sudo gate per the existing
  `auth.js` / `SudoModal.jsx` pattern. **Do not** reach into
  `authorized_keys` from the backend — go through the core's
  `reconcile`, which is the only mutation point.
* Add a "SSH Access" entry to the sidebar in
  `admin/frontend/src/components/Layout.jsx`.

### Last-seen tracking

* `last_seen_at` is best-effort: a one-shot scanner runs `last
  -F -i -n 200` on the host, parses the output for the IP +
  timestamp, and matches by reverse-lookup of the SSH session's
  source against the most-recent `from` field. If the operator
  hasn't enabled `LogLevel VERBOSE` in sshd, this can't match
  pubkey-to-session reliably; fall back to "—" and document the
  limitation in the panel's tooltip.
* The scanner runs on a `proxypilot-ssh-access-touch.timer`
  (every 5 minutes) and on dashboard load. Idempotent.

### Smoke check (operator confirms by hand)

1. `proxypilot ssh access bootstrap-script alice-laptop --user
   root --server my.host.tld` prints a self-contained shell
   snippet. Copying it to a fresh laptop and running it generates
   `~/.ssh/proxypilot_alice-laptop_ed25519` and prints both the
   pubkey and the matching `proxypilot ssh access add` heredoc.
2. Pasting the heredoc into a server shell adds the row +
   reconciles. `cat /root/.ssh/authorized_keys` shows the new
   line ending in `# proxypilot:alice-laptop`. `ssh -i
   ~/.ssh/proxypilot_alice-laptop_ed25519 root@my.host.tld`
   succeeds without password prompt.
3. Pre-existing `authorized_keys` lines without the
   `# proxypilot:` marker are untouched after reconcile. Verify
   by adding a manual line then running `proxypilot ssh access
   reconcile`.
4. `proxypilot ssh access revoke alice-laptop --reason "lost
   device"` removes the line from `authorized_keys` within one
   reconcile cycle (sub-second). Existing SSH session stays
   alive (sshd checks `authorized_keys` only at connect time);
   new connections from the revoked key get rejected.
5. Dashboard panel shows the device under Active before revoke,
   under Revoked after. The revoke modal's reason field is
   captured in the audit row.
6. `proxypilot ssh access add alice-laptop ...` with a re-used
   fingerprint (same key, same id) is rejected with a clear
   error pointing the operator at the existing row.
7. After `proxypilot vpn peer add alice-laptop --scope admin`
   then `proxypilot firewall set-scope base-ssh vpn-only`, port
   22 is only reachable from inside the VPN subnet. The access
   manager continues working unchanged because it operates on
   `authorized_keys`, which is consulted by sshd regardless of
   the source IP.

## Hard constraints (re-read every commit)

1. **No edits to `/etc/ssh/sshd_config`.** This module touches
   `~<user>/.ssh/authorized_keys` only. The
   `PasswordAuthentication no` flip is a manual operator step
   and stays out of this code.
2. **No `iptables` shell-outs anywhere.** No `nft` calls outside
   the firewall manager.
3. **No private keys anywhere.** The bootstrap script generates
   keys *on the operator's device* — the server never sees the
   private half. SQLite + JSON + audit log all hold pubkey +
   fingerprint only. The bootstrap-script command's output is
   shell text, not key material.
4. **Atomic file writes.** `ssh-access.json` and every
   `authorized_keys` rewrite go through the shared `atomicWrite`
   helper from `cli/src/core/vpn/server.js` — `.tmp.<pid>.<ts>` +
   chmod + rename, `flag: 'wx'`. The file is then chowned to the
   target user's uid:gid.
5. **Preserve operator-added lines.** Reconcile MUST leave any
   `authorized_keys` line that doesn't end with the
   `# proxypilot:<id>` marker untouched. This is the contract
   that lets operators keep a manual fallback key (e.g. the
   recovery key in a sealed envelope).
6. **Lockout safety.** Revoking the only ProxyPilot-managed key
   for a unix user emits a warning that lists any
   non-ProxyPilot lines that survive reconcile. If there are
   none, the warning is upgraded to a refusal unless `--force`
   + a typed phrase. Suggested phrase distinct from the four in
   use: `i have another way into this account`. JSON mode
   refuses past the gate (no TTY).
7. **Determinism.** Identical `ssh_access` rows → byte-identical
   `authorized_keys` rewrite. Sort by `id`. Reconcile is a pure
   function of state.
8. **Reconcile is the single mutation point** for
   `authorized_keys`. The CLI / dashboard / timer all funnel
   through `reconcile({ actor })`. No backend route writes to
   the file directly.
9. **Audit completeness.** New actions: `ssh-access.add`,
   `ssh-access.revoke`, `ssh-access.remove`,
   `ssh-access.reconcile`. Reuse the existing `audit_log` table.
10. **`fingerprint` is the dedup key.** Re-adding the same pubkey
    under a different `id` fails with a clear message pointing
    at the existing row. This prevents two `id`s pointing at
    the same physical key, which would make revocation
    confusing.

## Composition with what's already shipped

You build a wholly new module (`cli/src/core/ssh-access/`); do
not modify existing surfaces beyond:

* `cli/src/db/schema.js` — append the `ssh_access` table.
* `cli/src/core/vpn/server.js` — re-use the exported
  `atomicWrite()` helper as-is. Do not re-implement.
* `cli/bin/proxypilot.js` — add the `ssh access` command group.
* `admin/backend/src/routes/` — add `ssh-access.js` route file
  and register it in the route loader (mirror the
  `services.js` registration).
* `admin/frontend/src/pages/` — add `SshAccess.jsx` and a route
  in `App.jsx`.
* `admin/frontend/src/components/Layout.jsx` — add the sidebar
  entry.

Do **not** touch the firewall, VPN, or Caddy modules. Do **not**
write code in `cli/src/core/ssh/` (that path is reserved for the
shelved CA work, currently empty).

## File layout

```
cli/src/db/schema.js               # +ssh_access table

cli/src/core/ssh-access/
  state.js                         # NEW — read/write JSON + sqlite mirror
  reconcile.js                     # NEW — authorized_keys rewrite
  bootstrap.js                     # NEW — script template renderer
  index.js                         # NEW — addEntry/revokeEntry/removeEntry/list/show

cli/src/commands/ssh-access/
  add.js                           # NEW
  revoke.js                        # NEW
  remove.js                        # NEW
  list.js                          # NEW
  show.js                          # NEW
  reconcile.js                     # NEW
  bootstrap-script.js              # NEW
  index.js                         # NEW — re-exports

cli/bin/proxypilot.js              # +`ssh access` command group

admin/backend/src/routes/
  ssh-access.js                    # NEW — REST wrapper around core

admin/frontend/src/pages/
  SshAccess.jsx                    # NEW

admin/frontend/src/components/
  Layout.jsx                       # +"SSH Access" sidebar entry
```

## Hard segmentation rules (non-negotiable)

Same as steps 6 / 7:

1. Reads ≤ 200 lines. Grep first, then `Read` with offset +
   limit.
2. Edits are targeted.
3. Long-running commands run in the background.
4. `TodoWrite` checkpoints between segments.
5. **One checklist item = one commit.** Push after every commit.
   Suggested split:
   1. Schema migration (`ssh_access` table).
   2. Core state + reconcile + bootstrap (`cli/src/core/ssh-access/`).
   3. CLI subcommands (`cli/src/commands/ssh-access/` + bin
      registration).
   4. Last-seen scanner + timer.
   5. Backend route (`admin/backend/src/routes/ssh-access.js`).
   6. Frontend page + sidebar entry (`admin/frontend/...`).
   7. Audit pass — re-read each commit against the hard
      constraints.

## Audit pass requirement

After the commits above land, do an audit pass like the previous
sessions had. Look specifically for:

* **`authorized_keys` write paths outside reconcile** — the
  backend route MUST funnel through `reconcile({ actor })`. Any
  `fs.writeFileSync` against a `.ssh/authorized_keys` path
  outside reconcile is a regression.
* **Operator-added line clobbering** — verify reconcile strips
  ONLY lines ending `# proxypilot:<id>` and preserves
  everything else.
* **chown correctness** — `authorized_keys` written by root
  needs to end up owned by the target unix user, mode 0600.
  Test with a non-root unix user.
* **`fingerprint` dedup** — re-adding the same pubkey under a
  different `id` fails. Re-adding the same `id` fails. Re-adding
  a *revoked* fingerprint fails (operator should pick a new id +
  a new key).
* **Lockout gate** — revoking the last ProxyPilot key for a user
  with no operator-added fallback either warns + requires
  `--force` + typed phrase, or refuses outright per the
  constraint above. Verify both paths behave as documented.
* **Bootstrap script never sends key material to the server** —
  it's plain stdout text the operator copies, not an HTTP POST
  or an API call.

## What NOT to do this session

* Do not implement the SSH CA chain (steps 8–12 / 15). The
  deviation note in the spec is the contract; don't reverse it
  in code.
* Do not flip `PasswordAuthentication no` automatically. Operator
  step.
* Do not modify `/etc/ssh/sshd_config` directly under any
  circumstance.
* Do not touch `~/.ssh/known_hosts` — that's a client-side file.
* Do not implement the dashboard panels for firewall + VPN. They
  are step 14 (the session AFTER this one), not step "8′".
* Do not introduce a new `audit_log` table or migration
  framework.
* Do not commit `node_modules/`. The `.gitignore` already
  excludes it.
* Do not push to main, the firewall branch, or any step 5 / 6 /
  7 branch.

## Begin

After reading the spec end-to-end (especially the new
`## SSH Access Management (per-device authorized_keys)` section
and the spec deviation note above the SSH CA section), post a
one-paragraph plan for this session covering:

* Schema additions (`ssh_access` table, additive).
* The four core building blocks (state, mutations, reconcile,
  bootstrap script).
* The seven CLI subcommands and where they wire into
  `proxypilot.js`.
* The dashboard panel: backend route file + frontend page +
  sidebar entry.
* The lockout gate's typed phrase choice.
* Whether you intend to ship as a single session (default ~7
  commits) or split early if the dashboard work blows up.

Wait for go.
