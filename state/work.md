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
