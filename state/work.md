# Work — MCP tools for Full Platform setup and management (size L)

Branch: `claude/mcp-platform-setup-tools-sny7bk` (against the release installed from PR #620)

## Authorized scope

- **Outcome:** an MCP client can read the full setup state and next required action, save and apply the plan, continue after a failure, repair/reinstall/remove owned services, and reset the setup. Every step that needs a human is named, with where to do it.
- **Done when:** items 1–6 of the brief are demonstrated (read tools; save; apply/continue; per-service repair/reinstall/remove; reset incl. `purge_data`; the human-only boundary).
- **Excluded:** revealing credentials, entering the administrator password, activating SSO, typing vault secrets. These stay dashboard-only.

Findings are labelled **IN SCOPE**, **PREREQUISITE** or **FOLLOW-UP**.

## Tasks

| # | Task | Status |
|---|---|---|
| 1 | `lib/setup-engine/full-platform-mcp.js` — the read model (setup state, next_actions, service detail, jobs, preflight) over the dashboard's own stores | done |
| 2 | `lib/setup-engine/full-platform-reset.js` — reset review (preview + token), queue, runner op, route-removal backend step, purge backup set | done |
| 3 | `routes/mcp-tools/platform.js` + `lib/mcp-ext/catalog/platform.js` + policy flags `mcp.platform`, `mcp.platform.purge` | done |
| 4 | Dashboard: Custom / Advanced → Reset Full Platform (fresh local auth) | done — rendered at 360/375/768 in Chromium, no overflow, buttons ≥44 px |
| 5 | Tests alongside `full-platform.test.js` | done — `full-platform-mcp.test.js`, 13 cases |
| 6 | Docs: full-platform-setup.md reset section, mcp.md, CLAUDE.md count; change record | done |

## Findings

- **IN SCOPE (fixed):** PR #620 runtime actions threw `ERR_INVALID_ARG_TYPE` for every non-Keycloak service on a real host (eager `join(KEYCLOAK_ROOT, row.id)` with integer id 1). Fixed in `ownedRoot`; regression test.
- **IN SCOPE (fixed):** reset draft checked container labels per service; now all before the first change.
- **IN SCOPE (fixed):** a new import in `backend-steps.js` reordered module evaluation and broke `guided-sso.test.js`; removed.
- **FOLLOW-UP — observer on this host.** Evidence (read-only, installed ProxyPilot MCP, 2026-09-23 UTC): `FULL_PLATFORM_APPLIED` rev 2 at 06:12:59; `VAULTWARDEN_PLAN_APPLIED` (the Custom / Advanced G7 route — the coordinator never writes that audit action) at 06:17:48, 06:18:20 and 06:21:54; `PLATFORM_PLAN_SAVED` rev 3 (a Custom plan save) at 06:20:03, then three `FULL_PLATFORM_APPLIED` in 13 s (06:20:17/23/30), each `created: true`, so each prior coordinator job had already ended. The route inventory has the Keycloak route (`iam.fractionate.ai`) but **no `proxypilot-local-recovery` route**; the coordinator creates that route only after it saves the SSO record that names the observer. Reading: the 06:12:59 coordinator got past `prepareServiceConnections` (the Vaultwarden record existed for the 06:17 Custom apply) but not past saving the SSO record, so no observer exists; the Vaultwarden applies were run from Custom / Advanced before the coordinator had created it, and since 06:20:03 the coordinator refuses because the shared plan changed. The Full Platform flow **is** supposed to create the observer (`connect_managed_identity`); it did not get that far. Why the first run stopped is in that coordinator job's reason, which the new `get_platform_setup` / `get_platform_job` will show. Not fixed here: items 1–6 do not depend on it. Two related defects are in `docs/known-issues.md`.
- **FOLLOW-UP:** the step-up boundary. Items 4–5 ask for MCP runtime actions and reset, which the dashboard guards with fresh local proof. Over MCP they are guarded instead by the one-time confirmation token bound to the previewed digest plus `mcp.destructive` (and `mcp.platform.purge`). The actions listed in item 6 have no MCP tool at all.

---

# Work — Migration agent (size L)

Copy a running web application from another server, VM or container onto a
ProxyPilot-managed Incus guest, with ProxyPilot driving the process end to
end. Two modes in one binary; the source host runs one pasted command.

Branch: `claude/proxypilot-zfs-storage-l9szn1`

## Shape

```
source host ──(1) one-line command────────────────────────────────┐
              curl -fsSL <base>/api/migrations/agent/<token>/…     │
              | sudo sh -s -- --token <token>                      │
                                                                   ▼
  proxypilot-agent migrate  ──(2) inventory manifest──►  POST /api/migrations/agent/inventory
        │                    ──(3) progress events───►  POST /api/migrations/agent/event
        │
        └──(4) incus-migrate ──────────────────────►  Incus API (whole-machine mode)
            or rsync + pg_dump ────────────────────►  the target guest (application mode)
```

Everything the agent sends is authenticated by the single-use migration
token, scoped to one migration, expiring, TLS-pinned to the certificate
fingerprint in the token payload. No session cookie, no MCP key.

## Tasks

| # | Task | Status |
|---|---|---|
| 1 | `lib/migration/manifest.js` — the inventory schema, validation, the never-values guarantee, derivations (routes, egress, databases) | done |
| 2 | `lib/migration/plan.js` — target spec, phase machine, the one-line command, the post-import checklist | done |
| 3 | `lib/migration/token.js` — mint / verify: single-use, scoped, expiring, TLS pin | done |
| 4 | `lib/migration/service.js` — DB-backed: create / get / list / cancel / cutover / agent event ingestion | done |
| 5 | Migration 909 (`migrations`, `migration_events`) | done |
| 6 | `routes/migrations.js` — operator REST + the token-authenticated agent endpoints + the binary at a tokened URL with sha256 | done |
| 7 | MCP family `migration` + catalog + policy flag | done |
| 8 | Go: `cmd/agent/migrate` — inventory collectors, incus-migrate wrapper, tar export, rsync + dump, self-removal | done |
| 9 | `scripts/build-migration-agent.sh` + install.sh / update.sh cross-build (amd64, arm64) | done |
| 10 | `pages/Migrations.jsx` + components (create, progress, inventory review, checklist) | done |
| 11 | Tests: Node (manifest, plan, token, service, routes, MCP) + Go (collectors) | done — 29 new cases; four real defects caught before any of it ran (LEARNINGS 175–178) |
| 12 | End-to-end on throwaway guests on the operator's host | done for BOTH modes against a throwaway LXC source (whole-machine -> pp-mig-dst-lxc, application -> pp-mig-dst-app). The VM / incus-migrate path is unverified: it needs `incus config set core.https_address :8443` on the host, an outward-facing change I did not make unasked - handoff.md |
| 13 | Docs, change record, handoff.md, run-ledger row | done |
| 14 | Five defects found by RUNNING it, fixed, pinned and re-verified live (LEARNINGS 175, 176, 179, 180/182, 181) | done |
| 15 | Readiness: `migration_preflight` + `enable_incus_listener` (MCP), `GET /preflight` + `POST /incus-listener` (REST, sudo), the Readiness panel on the page | done — the manual `incus config set core.https_address` step is now a product capability that proposes the bridge gateway and refuses a public bind without being asked |
| 16 | `incus-migrate` end to end from the throwaway LXC source, with the listener on | done — `Instance pp-mig-im2 successfully created`, 434.7 MiB moved, guest fenced and stopped; the migrated app serves its own vhost and all four rows survived. Three defects found by running it (LEARNINGS 183, 184, 185), all fixed, pinned and re-verified |
| 17 | All three transports now proven on real hardware; only a VM source, a real Proxmox host and arm64 remain unverified (handoff) | done |
| 18 | Token lifecycle: no clock by default, revocable, every token listed with its state (migration 910, `list_migration_tokens`, `revoke_migration_token`, the Agent tokens panel) | done |
| 19 | `cleanup_migration` + the Clean up button: delete the guest a finished migration created, its record, or both — refusing a live migration, an adopted guest, a published one, and an unreadable route table | done |
| 20 | Where a migration lands: `pool` honoured by ALL three transports (incus-migrate answers its overrides menu 4 → pool → size → 1), a pool picker with free space in the dialog | done |
| 21 | Will it fit: `capacityNeeds` / `capacityVerdict`, measured against the pool's own `/resources` and the staging disk, at inventory AND at approval; a block is refused by the service (both surfaces) and overridable deliberately | done |
| 22 | `set_default_storage_pool` — which pool new guests land in, from Storage → Make default, pinning inheriting guests first and moving nothing | done |

## Decisions

- **Application mode does not use rsync**, which the brief asked for. rsync
  needs a reachable sshd and an authorized key inside the target guest — a
  package and an open port ProxyPilot would be ADDING to a guest that asked
  for neither, when `incus exec` already reaches it. Each directory is tarred
  to the same artifact endpoint the rootfs path uses and unpacked into the
  guest from the host; the dump travels the same way. The final delta sync
  keeps its meaning through `tar --newer-mtime`.
- **Wrap, don't reimplement — and answer what it ASKED.** Whole-machine mode
  shells out to the official `incus-migrate`; ProxyPilot supplies the target
  definition and a one-time Incus trust token and reads its progress. The
  server owns the answers, and after the first live run it owns them as
  PROMPT RULES rather than an ordered list: a positional script encodes a
  sequence nobody promised, and 6.0.4 asks for the authentication mechanism in
  a place the old order did not expect (LEARNINGS 183). A prompt no rule
  covers now fails the run with the prompt quoted — which is how the second
  defect was found in one attempt. A Proxmox LXC, where
  `incus-migrate` cannot run inside the guest, gets the rootfs-tar path
  (`tar` → ProxyPilot → `incus import`).
- **Values are never read.** The manifest carries `.env` file PATHS and KEY
  NAMES only. The service REFUSES a manifest that carries a value — the
  agent cannot decide to send one, and a tampered agent cannot smuggle one
  past the server.
- **The fence comes up before the route.** An imported guest is created with
  no route and the default-deny egress fence; observed outbound hosts land
  as pending egress requests the operator approves one at a time.
- **The checklist is state, not prose.** Each step records who completed it
  and when, so the cutover is auditable and resumable across sessions.

---

# Work — guest exports: one compressor, prepared downloads (size L, 2026-09-20)

Two asks from the operator, after a ZFS snapshot "felt instant" and its
download did not:

1. Compression should be a decision, and each job should use what is best
   for it. No user-facing gzip switch.
2. A download that survives the tab: built once in the background, with byte
   progress, downloadable repeatedly from any device, deleted when done.

## Shape

```
                    exports.compression  (zstd | gzip | none, default zstd)
                              │
        lib/export-compression.js  ──  request → setting → default
                              │        + gzip fallback when the host has no zstd
      ┌───────────────────────┼────────────────────────┬──────────────────┐
      ▼                       ▼                        ▼                  ▼
 streaming download    prepared downloads         S3 snapshot push   migration agent
 (routes/lxc.js)       (lib/lxc-exports.js)    (snapshot-s3-export)  (job.compression,
                              │                                       probed at the source)
                   incus export → <file>.part → mv → sha256
                              │
                   GET /api/lxc/exports/:id/download
                   Content-Length · Accept-Ranges · 206 · dd skip/count
```

## Decisions

- **zstd by default because gzip is slower than the link.** Measured here:
  47.4 s for a 1.00 GB export (~50 MB/s, single-threaded) while 31 of 32
  cores idled. `none` is for a 10 Gb link, `gzip` for maximum compatibility.
  The setting exists because the right answer depends on where the bytes go;
  the UI does not ask, per the operator.
- **A missing package never fails a backup.** No zstd binary → gzip, with a
  note in the result.
- **Nothing decompresses by name**, and where a GUEST would be the consumer
  ProxyPilot decompresses on the host first — a fresh minimal guest has tar
  but may not have the zstd binary tar shells out to.
- **`backup-pack.js` stays gzip.** Its `.tar.gz` member names are part of the
  pack format.
- **Built into `.part`, moved when whole**, progress read from the growing
  file. A half-built tarball is never servable and the percentage is never
  invented.
- **Capacity is checked before the build starts**, not discovered when the
  exports dataset fills.
- **Retention (3 per container / 14 days)** because a prepared download is a
  convenience; the backup of record is sanoid + replication.
