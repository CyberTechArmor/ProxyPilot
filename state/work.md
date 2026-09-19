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
| 12 | End-to-end on throwaway guests (one LXC, one VM) on the operator's host | see handoff.md |
| 13 | Docs, change record, handoff.md, run-ledger row | done |

## Decisions

- **Wrap, don't reimplement.** Whole-machine mode shells out to the official
  `incus-migrate`; ProxyPilot supplies the target definition and a one-time
  Incus trust token and reads its progress. A Proxmox LXC, where
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
