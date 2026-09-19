# Change record — the migration agent (2026-09-19)

Branch `claude/proxypilot-zfs-storage-l9szn1` · size L · author: Claude Code session for Thomas@tagarmor.com

## Ask

A migration agent that copies a running web application from another server,
VM or container onto a ProxyPilot-managed Incus guest, with ProxyPilot
driving the process end to end. Two modes in one binary: whole-machine
(wrapping the official `incus-migrate`, with a rootfs-tar path for a Proxmox
LXC) and application/adopt. An inventory manifest first; REST + MCP + a page;
the imported guest fenced with no route until the operator reviews; a
post-import cutover checklist; both modes proven end to end against
throwaway guests.

## What changed

| Area | Files | Notes |
|---|---|---|
| Pure layer | `lib/migration/{manifest,plan,token}.js` | the inventory schema + the never-values refusal + the derivations (routes, egress, database plan, concerns); the target spec, the transports, the phase machine, the pasted command, the checklist, bytes/rate/ETA; single-use scoped expiring tokens (sha256 only) |
| Service | `lib/migration/{service,index}.js` | rows, token claim, the agent's job document, the event stream, the Incus work (trust token, split-image import, guest creation, the fence), the checklist and the egress decisions |
| REST | `routes/migrations.js`, mounted in `index.js` | operator router (admin + sudo): list/create/get/events/approve/cancel/checklist/egress. Agent router (no session, token in the path, CSRF-exempt by design): `install.sh`, `binary/:arch`, `job`, `inventory`, `event`, `artifact`, `finish` |
| MCP | `routes/mcp-tools/migration.js`, `lib/mcp-ext/catalog/migration.js`, catalog + handler registration, policy (`mcp.migration`, a `migration` section) | 6 tools: create / get / list / approve / cutover / cancel |
| Agent | `cmd/agent/migrate/{parse,inventory,client,transfer,migrate}.go`, `main.go` | the same binary as the host agent, run as `proxypilot-agent migrate`: collectors, TLS-pinned client, the three transports, self-removal, `--print` and `--inventory-only` |
| Build | `scripts/build-migration-agent.sh`, `install.sh`, `update.sh` | CGO-free cross-build for linux/amd64 + arm64 into `/var/lib/proxypilot/agent/` with `.sha256`, on every install and update |
| DB | `db.js` migration 909 | `migrations` (spec, token hash, manifest, egress decisions, checklist) + `migration_events` |
| Frontend | `pages/Migrations.jsx`, `components/migration/*`, `lib/api.js`, `App.jsx`, `Layout.jsx` | the list, the phase rail and live rate, the inventory review with the approve gate, the cutover checklist, the agent log |
| Tests | `__tests__/migration-{manifest,plan,service,routes}.test.js`, `cmd/agent/migrate/parse_test.go`, CI | 28 backend cases + the Go collectors; the migration-909 DDL is executed from `db.js` so the shipped schema is what the test runs |
| Docs / state | `docs/features/migration.md`, `docs/features/mcp.md`, `CLAUDE.md`, `.env.example`, `state/*`, `LEARNINGS.md` 175–182 | |

## Decisions worth knowing

- **Secrets are structurally impossible to carry.** `.env` files travel as a
  path and KEY NAMES; the agent discards the value half at the source before
  anything is serialized, the Go struct has no field for a value, and the
  server refuses a manifest carrying one anywhere in it. Proven on the live
  run: `STRIPE_SECRET_KEY` is in the record, `sk_live_…` is not.
- **The gate is the product.** The agent posts the manifest and waits;
  `approve_migration` is what lets bytes leave. `auto_transfer` exists for a
  lab and defaults to false.
- **Application mode is not rsync**, which the brief asked for. rsync needs a
  reachable sshd and an authorized key inside the target guest — a package
  and an open port ProxyPilot would be adding to a guest that asked for
  neither, when `incus exec` already reaches it. Each directory is tarred to
  the same artifact endpoint the rootfs path uses and unpacked from the host;
  the dump travels the same way. The final delta sync keeps its meaning
  through `tar --newer-mtime`.
- **The server owns the `incus-migrate` answer script.** The tool is a prompt
  loop whose order changes between releases, so adapting to a new version is
  a server-side edit, not a re-roll of every agent on every source host.
- **The guest fence is bridge → host.** Learned the hard way (LEARNINGS 182):
  approving an internet destination records that it was reviewed and says so,
  rather than claiming a fence that does not cover it.

## Verification

Both modes end to end on the operator's host against throwaway guests
(`state/handoff.md` has the table): 300 MiB streamed and hash-verified for
whole-machine, the app directories and a PostgreSQL dump for application
mode, and in both cases a running app and intact data in the target. Five
defects were found by running it and are fixed, pinned and re-verified
(LEARNINGS 175, 176, 179, 180/182, 181). `incus-migrate` against a real VM,
a real Proxmox source and an arm64 source remain unverified and are listed
in the handoff.
