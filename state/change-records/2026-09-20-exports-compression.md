# Change record — guest exports: one compressor, prepared downloads (2026-09-20)

Branch `claude/proxypilot-zfs-storage-l9szn1` · size L · author: Claude Code session for Thomas@tagarmor.com

## Ask

Two things the operator asked for after a snapshot on ZFS "felt instant" but
its download did not:

1. **Compression should be a decision, not five accidents.** Every guest
   tarball was gzip — 47.4 s for a 1.00 GB export of searxng, measured — and
   nobody had chosen that. Use what is best for each job, with no user-facing
   gzip switch ("they do not need to browse").
2. **A download that survives the tab.** Build it once in the background,
   show byte progress, download it as many times as you like from any
   device, delete it when done.

## What changed

| Area | Files | Notes |
|---|---|---|
| The decision | `lib/export-compression.js` (new) | request → `exports.compression` setting → zstd; automatic gzip fallback (with a note) on a host with no zstd binary; the extension, content type, `incus --compression` args and `tar` flag all derive from the one answer |
| The store | `lib/lxc-exports.js`, `lib/lxc-exports-instance.js` (new) | prepare / build / progress / serve / delete / retention, with every host call injected so the lifecycle is testable without an Incus |
| DB | `db.js` migration 912 | `lxc_exports` (state, byte progress, sha256, downloads, expiry) + two indexes |
| REST | `routes/lxc.js` | `GET/POST /api/lxc/exports`, `GET /api/lxc/exports/:id`, `DELETE /api/lxc/exports/:id`, `GET /api/lxc/exports/:id/download` (Content-Length, Accept-Ranges, 206, `dd` with byte offsets); the two streaming download routes now name their compressor and extension |
| MCP | `routes/mcp-tools/lxc-admin.js`, `lib/mcp-ext/catalog/lxc.js` | `list_lxc_exports` (reader) and `delete_lxc_export` (plain confirm); `export_lxc` gains `compression`, reports it back and registers the artifact. 175 → 177 tools |
| Other export sites | `lib/snapshot-s3-export.js`, `routes/mcp-tools/project-config.js`, `lib/migration/service.js`, `routes/mcp-tools/admin.js`, `lib/mcp-policy/mcp-extended-policy.json` | the S3 push (object key extension follows the compressor), `delete_project`'s pre-delete tarball, `cleanup_migration`'s, and `set_setting` validation for the new key |
| Migration transport | `cmd/agent/migrate/{compression,transfer,client}.go`, `lib/migration/service.js` | the job names a compressor, the agent PROBES what the source's tar can actually run and falls back to gzip; the mysqldump is compressed through a Go-wired pipeline that checks both exit codes (dash has no `pipefail`); ProxyPilot sniffs the first four bytes of what arrives and decompresses on the HOST before piping a plain tar into the guest |
| Frontend | `components/lxc/PreparedDownloads.jsx` (new), `pages/LxcContainers.jsx`, `lib/api.js` | the Backup panel: Prepare, percentage, Download, Delete. The streaming `Blob` download and its progress plumbing are gone; the per-snapshot Download button prepares one too |
| Retention | `index.js` | 3 per container / 14 days, five minutes after boot and every six hours |
| Gates | `mock2/framework-seed/gates.json` | the ui-interaction and component-reuse gates now `mktemp -d` their scratch state (LEARNINGS 187) |
| Tests | `__tests__/lxc-exports.test.js` (new, 16 cases), `migration-service.test.js`, `mcp-extended.test.js`, `cmd/agent/migrate/compression_test.go` (new) | migration 912's DDL is executed from `db.js` so the shipped schema is what the test runs |
| Docs / state | `docs/features/lxc/exports.md` (new), `docs/features/{mcp,migration}.md`, `CLAUDE.md`, `state/*`, `LEARNINGS.md` 186–187 | |

## Decisions worth knowing

- **zstd by default, and the setting exists because the answer depends on the
  link.** gzip is single-threaded at ~50 MB/s — slower than a gigabit link,
  so on a LAN it makes the compressed download arrive later than an
  uncompressed one would. `none` is there for a 10 Gb link; `gzip` for
  maximum compatibility. No switch in the UI, per the ask: the setting is
  MCP- and operator-writable and the per-call override stays for scripts.
- **The fallback is silent and loud at once.** A host without the zstd binary
  gets gzip automatically — a missing package must never fail a backup — and
  the result says so, so the operator can fix it if they care.
- **Nothing decompresses by name.** `incus import`, `tar` and `zstd -d` all
  detect the format; the restore path never has to know what was chosen.
  Where a guest is the consumer (the migration unpack) ProxyPilot
  decompresses on the HOST, because a fresh minimal guest has tar but may not
  have the binary tar shells out to.
- **`backup-pack.js` stays gzip on purpose.** Its `.tar.gz` member names are
  part of the pack format, and an older ProxyPilot restoring a newer pack has
  to find them where it expects. The comment in the file says so.
- **Built into `.part`, moved when whole.** A half-built tarball is never
  servable, and progress is read from the growing file rather than estimated
  — the only honest source.
- **A prepared download is a convenience, not the backup of record.** Hence
  the retention sweep, and hence the capacity refusal up front rather than a
  full exports dataset discovered later.
- **The sweep adopts what it did not write.** Tarballs from before this
  table existed were invisible to the panel and unreachable by retention —
  a gigabyte each that nothing would ever delete. Claiming "one list" and
  then keeping a second, invisible one was the part that had to go.

## Measured

`export_lxc searxng` three times on the operator's host, same guest, same
flags, back to back — 8.158 GB of tar each time, durations from
`mcp_ledger.duration_ms`:

| | time | size |
|---|---|---|
| **zstd** | **28.3 s** | **3.647 GB** |
| gzip | 179.7 s | 3.775 GB |
| none | 36.8 s | 8.158 GB |

zstd is 6.3× faster than gzip and 3% smaller, and 30% faster than writing
the tarball uncompressed. The default stands, and `none` turns out to have
no speed argument on this host at all.
