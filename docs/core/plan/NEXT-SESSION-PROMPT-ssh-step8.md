# Next session — SSH Certificate Authority setup (build sequence step 8)

You are picking up the ProxyPilot Firewall + VPN + SSH CA upgrade.
Five things are already shipped — do **not** re-implement any of
them:

* Firewall manager (steps 1–4) — see
  `docs/core/plan/phase-08b-firewall-manager.md`.
* VPN server (step 5) — see `docs/core/plan/phase-12a-vpn-server.md`.
* VPN peer lifecycle (step 6) — six commits ending at `c5bef94` on
  `claude/setup-vpn-step6-prompt-OqCEZ`.
* Per-peer scope at L4 + L7 (step 7a/7b) — fourteen commits ending
  at `986a74c` on `claude/proxypilot-firewall-vpn-ssh-WT5n1`. Read
  the step-7 commit log + `cli/src/core/firewall/reconcile.js` +
  `cli/src/caddy/render.js` + `cli/src/caddy/reconcile.js` end to
  end before starting; the post-step-6 fixes (`6a807dd`, `1b35486`,
  `5444369`, `84ecb73`, `b4ca5e0`) are already merged into the step-7
  branch.

## Spec

The complete spec lives at the repo root:
`proxypilot-firewall-vpn-ssh-prompt.md`. Read it end-to-end before
writing code, especially:

* `## Design Principles (specific to this upgrade)` — state-driven,
  default deny, **never lock the operator out**, short-lived
  credentials over long-lived.
* `## SSH Certificate Authority` → `### CA Setup During Init` — this
  is your scope. Read the eight numbered steps closely; they are
  the build order.
* `## SSH Certificate Authority` → `### SQLite Schema` — `ssh_ca`,
  `ssh_certs`, `ssh_principals`. Step 8 only writes to `ssh_ca`;
  the other two are populated in steps 9 + 10.
* `## Implementation Constraints` — no edits to
  `/etc/ssh/sshd_config` (drop-in only), no private keys in SQLite
  or audit logs, atomic file writes everywhere, lockout safety on
  every relevant command.

## Branch

The harness will assign a branch. Stay on it. Branch off
`claude/proxypilot-firewall-vpn-ssh-WT5n1` (head `986a74c`) so the
step-7 work is present — step 8 builds nothing on top of step 7
directly, but operators expect the SSH CA work to land on a branch
with the per-peer scope already in place. Do **not** push to main,
the firewall branch, or any step 5 / 6 / 7 branch.

## Scope of this session — step 8 only

Implement `## Build Sequence` step 8 — generate the user + host CA
keypairs, sign the host's own SSH host keys, initialize an empty
KRL, and render the sshd drop-in so sshd trusts the CA **without
disabling `authorized_keys`**. Both auth methods must work
simultaneously after this step.

Do **not** start step 9 (cert issuance + KRL revocation), step 10
(principals / `auth_principals/<user>`), step 11 (`migrate-from-
authorized-keys`), step 12 (host CA renewal timer), or step 15
(`harden-vpn-only` transition). Each of those is a separate
session.

## What "done" looks like

### CA generation

* `cli/src/core/ssh/ca.js` exposes `generateUserCa({ actor })` and
  `generateHostCa({ actor })`. Each:

  * Runs `ssh-keygen -t ed25519 -f <path> -N ""` (no passphrase —
    step 9 will pull through tmpfs at signing time, the on-disk
    private key is mode 0600 either way).
  * Writes the private key to `/etc/ssh/proxypilot_user_ca` /
    `proxypilot_host_ca` mode 0600, and the pubkey to
    `<path>.pub` mode 0644 — both via the shared `atomicWrite`
    helper from `cli/src/core/vpn/server.js` (`.tmp.<pid>.<ts>`
    + chmod + rename, `flag: 'wx'`).
  * Inserts a row into `ssh_ca` (kind, public_key, fingerprint,
    created_at). Re-running on an existing CA refuses unless
    `force: true` is passed — silent regeneration would invalidate
    every host cert and every cert step 9 issues.
  * Audit row: `ssh.ca.generate` carrying `kind` + `fingerprint`
    (NEVER the private key, NEVER the public key body — only the
    fingerprint and kind).

* The spec says CA private keys live in **Infisical** at
  `core/SSH_USER_CA_PRIVATE_KEY` / `core/SSH_HOST_CA_PRIVATE_KEY`,
  pulled to `/run/proxypilot/ca/` (tmpfs, mode 0700) only at
  signing time. **Infisical is not yet integrated** in this
  codebase. Step 8 ships with the private keys living on disk at
  `/etc/ssh/proxypilot_*_ca` mode 0600, with a clearly-flagged
  `// TODO(infisical)` next to the file path so step 9 can swap in
  the secret-store pull. Document the deferral in the commit
  message — operators reading the audit pass need to know the keys
  are on-disk-only until Infisical lands.

### Host key signing

* `cli/src/core/ssh/ca.js` also exposes `signHostKeys({ actor })`.
  For each `/etc/ssh/ssh_host_*_key.pub` that exists on the host:

  * Sign with the host CA via
    `ssh-keygen -s /etc/ssh/proxypilot_host_ca -h -I "host:<fqdn>" -n "<fqdn>,<short>" -V +52w <key.pub>`.
  * Output lands at `/etc/ssh/ssh_host_*_key-cert.pub`
    automatically (ssh-keygen's behaviour with `-h`).
  * Skip key types that ssh-keygen refuses (e.g. dsa on modern
    distros) — log a warning, don't abort.
  * Audit row per signed key: `ssh.host-key.sign` with the host
    key fingerprint + the principals list.

* Hostname resolution: `<fqdn>` from `hostname -f`, `<short>` from
  `hostname -s`. If `hostname -f` returns an unqualified name
  (common on minimal VMs), fall back to `<short>` only and log
  a warning. Operators distribute the host CA pubkey via
  `proxypilot ssh export-ca` (lands in step 12) so this is
  recoverable.

### KRL initialization

* `cli/src/core/ssh/krl.js` exposes `initKrl()`. Runs
  `ssh-keygen -k -f /etc/ssh/proxypilot_revoked_keys`. Mode 0644
  (sshd reads as root, no secret content). Idempotent: skip if
  the file exists and is non-empty.

* No revocation logic in step 8. The KRL is initialized empty so
  step 9's `proxypilot ssh revoke` has a file to append to.

### sshd drop-in rendering

* `cli/src/core/ssh/sshd.js` exposes `renderDropIn(state)` and
  `applyDropIn({ actor })`. The drop-in path is
  `/etc/ssh/sshd_config.d/proxypilot-ca.conf` mode 0644.

* Drop-in body (deterministic, byte-identical for identical
  state):

  ```
  # Generated by ProxyPilot SSH CA manager. Do not edit by hand.
  # Source of truth: ssh_ca + /etc/ssh/proxypilot_*_ca.pub
  TrustedUserCAKeys /etc/ssh/proxypilot_user_ca.pub
  HostCertificate /etc/ssh/ssh_host_ed25519_key-cert.pub
  HostCertificate /etc/ssh/ssh_host_rsa_key-cert.pub
  RevokedKeys /etc/ssh/proxypilot_revoked_keys
  AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u
  ```

  Emit `HostCertificate` lines only for host key types that were
  actually signed (skipped types stay absent).

* `applyDropIn` sequences:
  1. Render the new drop-in body.
  2. Atomic-write to `<path>.tmp.<pid>.<ts>` then rename — same
     pattern as wg0.conf / firewall ruleset / Caddyfile sites.
  3. Run `sshd -t -f /etc/ssh/sshd_config` to validate the
     **whole** sshd config (drop-in is included automatically).
     If validation fails, **roll back** by `unlink`-ing the new
     drop-in and re-rendering the old one if one existed; the
     existing `authorized_keys` flow keeps working unchanged.
     Throw with the sshd stderr so the operator sees what broke.
  4. `systemctl reload sshd`. `reload` (vs `restart`) does not
     drop existing sessions, which is the lockout-safe choice.
  5. Audit row: `ssh.sshd.applied` with the drop-in checksum
     (sha256 of the rendered body) — same pattern as
     firewall_reconciles.

* **Do NOT** unset `AuthorizedKeysFile`. The drop-in trusts the
  CA but leaves `authorized_keys` active — both auth paths must
  work after step 8 lands. Step 11 (`migrate-from-authorized-keys`)
  is the only place that retires the legacy path.

### Orchestrator + CLI

* `cli/src/core/ssh/index.js` exposes `caInit({ actor, force })`
  that runs the four pieces in order:
  1. `generateUserCa` (skip if `ssh_ca` row exists with
     `kind='user'` and `force` is false)
  2. `generateHostCa` (same)
  3. `signHostKeys` — always re-runs; signing is idempotent on a
     given (host CA × host key) pair because ssh-keygen overwrites
     the cert file.
  4. `initKrl` (skip if file exists)
  5. `applyDropIn`

  Each step's success/skip status is collected into a result object
  the CLI surfaces. Hard failure on any step throws — `applyDropIn`
  must never run if any prior step failed, because the drop-in
  references files that don't exist yet.

* New CLI: `proxypilot ssh ca-init [--force]`. The only step-8 CLI.
  `--force` regenerates BOTH CA keypairs after a typed
  confirmation phrase distinct from the existing three (step 6's
  `I understand this locks everyone out` and `remove this active
  peer`, step 7a's `demote the last admin peer`). Suggested phrase:
  `regenerate the ssh certificate authority`. Refuse `--force`
  over JSON mode (no TTY for typed confirm).

  Default (no `--force`) is fully idempotent: re-running on a host
  with a populated `ssh_ca` row is a no-op for keypair generation,
  re-signs host keys, ensures the KRL exists, and re-applies the
  drop-in. Operators can run it as part of `update.sh`.

* Wire into `cli/bin/proxypilot.js` as a top-level
  `ssh ca-init` subcommand. Mirror the pattern of
  `proxypilot vpn enable` / `proxypilot firewall detect-bridge`:
  one CLI file, one core function, one audit chain.

### Smoke check (operator confirms by hand on a real host)

* On a host where step 7b has landed and `authorized_keys`-based
  SSH currently works:

  1. `proxypilot ssh ca-init` runs cleanly. `ls -la /etc/ssh/`
     shows `proxypilot_user_ca` (0600), `proxypilot_user_ca.pub`
     (0644), `proxypilot_host_ca` (0600), `proxypilot_host_ca.pub`
     (0644), `proxypilot_revoked_keys` (0644), and
     `ssh_host_*_key-cert.pub` for each ed25519 / rsa host key.
  2. `cat /etc/ssh/sshd_config.d/proxypilot-ca.conf` shows
     the `TrustedUserCAKeys` + `HostCertificate` + `RevokedKeys` +
     `AuthorizedPrincipalsFile` lines exactly as specified.
  3. `sudo sshd -T | grep -i 'trustedusercakeys\|hostcertificate\|revokedkeys\|authorizedprincipalsfile'`
     shows the values are picked up by the live sshd.
  4. **Crucial:** an existing operator session that authed via
     `~/.ssh/authorized_keys` continues to work unchanged
     (`reload` not `restart`). A new SSH connection from the same
     authorized-key client succeeds.
  5. `proxypilot ssh ca-init` re-run is a no-op for keypair
     generation (audit log shows no new `ssh.ca.generate` rows),
     re-signs host keys (one `ssh.host-key.sign` row per key per
     run), and re-applies the drop-in (one `ssh.sshd.applied` row
     per run).
  6. `proxypilot ssh ca-init --force` (interactive, with the
     typed phrase) regenerates both CA keypairs. Existing host
     certs are re-signed by the new host CA. The user CA's
     fingerprint in `ssh_ca` reflects the new key. `authorized_keys`
     auth still works.

* Future-step verification (NOT in step 8 — record in the commit
  message as "verified manually after step 9 lands"): after step 9
  ships `proxypilot ssh issue`, an operator can issue a cert
  against this CA and use it to log in alongside the existing
  authorized_keys path.

## Hard constraints (re-read every commit)

1. **No edits to `/etc/ssh/sshd_config`.** All sshd settings go
   through `/etc/ssh/sshd_config.d/proxypilot-ca.conf`. The main
   file is left untouched for operator overrides.
2. **No `iptables` shell-outs anywhere.** No `nft` calls outside
   the firewall manager. (Step 8 doesn't touch the firewall, but
   the constraint stands across the whole upgrade.)
3. **No private keys in SQLite or audit logs.** `ssh_ca` stores
   only `public_key` + `fingerprint`; audit rows reference CA
   keys by fingerprint and kind. The on-disk private keys at
   `/etc/ssh/proxypilot_*_ca` are mode 0600. **No** path that
   logs, prints, or audits the private key body, ever.
4. **Atomic file writes everywhere.** CA private key, CA public
   key, KRL, sshd drop-in — all `.tmp.<pid>.<ts>` + chmod +
   rename via the shared `atomicWrite` helper from
   `cli/src/core/vpn/server.js`. `flag: 'wx'` so a stale tmp
   from a crashed prior run never gets inherited.
5. **Lockout safety on every relevant command.**
   * `applyDropIn` runs `sshd -t` BEFORE `systemctl reload sshd`.
     Validation failure ⇒ rollback the drop-in, throw with
     stderr.
   * Drop-in **never** unsets `AuthorizedKeysFile` —
     `authorized_keys` keeps working through step 8.
   * `--force` on `ca-init` requires a typed phrase distinct
     from the three already in use.
   * Use `systemctl reload sshd`, never `restart` — reload
     doesn't drop existing sessions.
6. **Determinism.** Identical `ssh_ca` rows + identical signed
   host-key set → byte-identical drop-in across runs. Sort
   `HostCertificate` lines by key type alphabetically (`ecdsa` <
   `ed25519` < `rsa`) so the output is stable even if sshd's
   default key list ordering shifts between distros.
7. **Idempotence.** Re-running `caInit` on a populated host is
   a no-op for keypair generation, re-signs host keys (cert files
   overwritten), ensures the KRL exists, re-applies the drop-in.
   No spurious audit rows: only `ssh.host-key.sign` and
   `ssh.sshd.applied` per re-run; no `ssh.ca.generate` if the
   `ssh_ca` rows already exist.
8. **Audit completeness.** One audit row per mutation. New
   actions: `ssh.ca.generate`, `ssh.host-key.sign`,
   `ssh.sshd.applied`. KRL initialization writes
   `ssh.krl.initialized` once on first run, no row on
   subsequent re-runs (file exists).
9. **Schema-add only.** Three additive `CREATE TABLE IF NOT
   EXISTS` blocks for `ssh_ca`, `ssh_certs`, `ssh_principals`
   — even though step 8 only writes to `ssh_ca`, defining all
   three now means steps 9 and 10 don't re-touch
   `cli/src/db/schema.js`. Don't introduce a migration framework.

## Composition with what's already shipped

You build a wholly new module (`cli/src/core/ssh/`); you do not
modify any existing surface beyond the hooks below.

* `cli/src/core/vpn/server.js` — re-use the exported
  `atomicWrite()` helper as-is. Do not re-implement.
* `cli/src/db/schema.js` — append the three SSH tables in the same
  style as the existing `firewall_rules` / `vpn_peers` blocks
  (`CREATE TABLE IF NOT EXISTS`, comments above each block).
* `cli/src/db/audit.js` — already has `audit({ subsystem, action,
  resource, actor, before, after })`. Reuse with
  `subsystem: 'ssh'`. Do not extend the audit table.
* `cli/bin/proxypilot.js` — add a new top-level `ssh` command
  group with one subcommand (`ca-init`). Mirror the
  `firewall detect-bridge` pattern: one option (`--force`), one
  action handler, no nested groups yet (`ssh issue` / `ssh
  revoke` / `ssh role` / `ssh export-ca` are all later steps).
* `scripts/install-*.sh` — do **not** wire `proxypilot ssh
  ca-init` into install in step 8. The CLI exists and is
  idempotent, but auto-running it during install is a step-9
  decision (it's coupled to the bootstrap admin cert flow). The
  step-9 prompt will pick the right install hook.

## File layout

```
cli/src/db/schema.js          # +ssh_ca, ssh_certs, ssh_principals tables

cli/src/core/ssh/
  ca.js                       # NEW — generateUserCa, generateHostCa, signHostKeys
  krl.js                      # NEW — initKrl
  sshd.js                     # NEW — renderDropIn, applyDropIn (with sshd -t gate)
  index.js                    # NEW — caInit() orchestrator + re-exports

cli/src/commands/ssh/
  ca-init.js                  # NEW — single CLI subcommand
  index.js                    # NEW — re-exports

cli/bin/proxypilot.js
  +`ssh ca-init` top-level subcommand
```

## Hard segmentation rules (non-negotiable)

Same as steps 6 / 7:

1. Reads ≤ 200 lines. Grep first, then `Read` with `offset` +
   `limit`.
2. Edits are targeted.
3. Long-running commands run in the background.
4. `TodoWrite` checkpoints between segments.
5. **One checklist item = one commit.** Push after every commit.
   Suggested split:

   1. Schema migration: `ssh_ca` + `ssh_certs` + `ssh_principals`
      tables in `cli/src/db/schema.js`. (Step 8 only writes
      `ssh_ca`; the other two land now so step 9 and 10 don't
      re-touch the schema file.)
   2. `cli/src/core/ssh/ca.js` — `generateUserCa`,
      `generateHostCa`, `signHostKeys`. Pure shell-out wrappers
      with audit + atomic-write.
   3. `cli/src/core/ssh/krl.js` — `initKrl`. Tiny.
   4. `cli/src/core/ssh/sshd.js` — `renderDropIn`, `applyDropIn`
      with `sshd -t` gate + rollback on validation failure.
   5. `cli/src/core/ssh/index.js` orchestrator (`caInit`) +
      `cli/src/commands/ssh/ca-init.js` CLI + wire into
      `bin/proxypilot.js`.

## Audit pass requirement

After the commits above land, do an audit pass like steps 5 / 6 /
7 had. Re-read each commit against the hard constraints. Look
for:

* **`sshd -t` gate skipped.** `applyDropIn` MUST validate before
  reload. Verify the failure path (corrupt drop-in body) actually
  rolls back and throws.
* **`AuthorizedKeysFile` accidentally unset.** Greppable: search
  the rendered drop-in body for `AuthorizedKeysFile` — if present
  in step 8, that's a regression. Should appear ONLY in step 11.
* **CA private key body in audit / log / stdout.** Greppable:
  search for `private_key` / `privateKey` references in the SSH
  module — the only place a private key path should appear is
  the file-write sites. The body itself never enters JS strings.
* **Atomic-write stale-`.tmp` inheritance** — every new write
  path uses `atomicWrite()` from `core/vpn/server.js` (which has
  `flag: 'wx'` + chmod). Verify no `fs.writeFileSync` direct
  call lands on `/etc/ssh/*`.
* **Determinism breaks** — `Object.entries` / `Map.values()`
  ordering used instead of explicit sort for the
  `HostCertificate` lines.
* **Idempotence** — re-running `caInit` produces zero
  `ssh.ca.generate` audit rows after the first run, but does
  produce `ssh.host-key.sign` + `ssh.sshd.applied` rows (those
  are correctly idempotent on the file system but logged on
  every call).
* **Hostname fall-back path** — `hostname -f` returning an
  unqualified name is handled (warning + short-name only) rather
  than crashing.
* **Empty-string CA passphrase** — `-N ""` is correct for the
  current on-disk-CA path. When step 9 swaps in Infisical the
  passphrase pattern stays the same; flag the deferred Infisical
  TODO in the audit pass output if the comment is missing.
* **`systemctl reload` vs `restart`** — verify reload, not
  restart. `restart` would drop existing operator sessions and
  is a lockout-class regression.

Fix what's worth fixing in a separate commit so the history makes
the fix obvious. Skip nice-to-have refactors.

## What NOT to do this session

* Do not implement step 9 (`proxypilot ssh issue` + KRL revocation
  logic). Separate session — that work pulls the user CA private
  key into a `/run/proxypilot/ca/` tmpfs scratch dir, signs, and
  wipes; out of scope here.
* Do not implement step 10 (`/etc/ssh/auth_principals/<user>`
  management + `proxypilot ssh role` commands). Separate session.
* Do not implement step 11 (`migrate-from-authorized-keys`). The
  whole point of step 8 is that `authorized_keys` keeps working
  unchanged.
* Do not implement step 12 (host CA renewal timer +
  `proxypilot ssh export-ca`). Separate session.
* Do not implement step 15 (`harden-vpn-only` SSH transition).
* Do not modify `/etc/ssh/sshd_config` directly — drop-in only.
* Do not unset `AuthorizedKeysFile` in the drop-in.
* Do not delete or rename any `~/.ssh/authorized_keys` file.
* Do not introduce an Infisical client. The `// TODO(infisical)`
  comment marks the future swap; the actual integration is a
  cross-cutting concern that lands separately.
* Do not introduce a new `audit_log` table or migration
  framework.
* Do not commit `node_modules/`. The `.gitignore` already
  excludes it.
* Do not push to main, the firewall branch, or any step 5 / 6 / 7
  branch.

## Begin

After reading the spec end-to-end and the four phase docs (12b
may not exist yet — fall back to the step-6 commit log + the
step-7a / 7b commits on `claude/proxypilot-firewall-vpn-ssh-WT5n1`),
post a one-paragraph plan for step 8 specifically:

* Schema additions (the three SSH tables, additive,
  `CREATE TABLE IF NOT EXISTS`).
* The four building blocks (`ca.js` keypair generation,
  `ca.js` host-key signing, `krl.js` init, `sshd.js` drop-in
  with `sshd -t` gate).
* The orchestrator + CLI shape, including the `--force` typed
  phrase choice.
* How `authorized_keys` stays untouched through the whole
  step-8 lifecycle.
* Whether you intend to ship as a single session (default) or
  flag any larger-than-expected risk early.

Wait for go.
