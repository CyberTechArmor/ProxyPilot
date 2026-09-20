# Guest exports: compression and prepared downloads

*Added 2026-09-20. Code: `lib/export-compression.js`, `lib/lxc-exports.js`,
`lib/lxc-exports-instance.js`, `routes/lxc.js` (`/api/lxc/exports*`),
`routes/mcp-tools/lxc-admin.js`, `components/lxc/PreparedDownloads.jsx`.
Migration 912. Tests: `lxc-exports.test.js`.*

Two problems, one change.

**The download held a tab open.** The old Export button ran
`incus export <guest> -` straight into the HTTP response. The work was tied to
one request — close the tab and it was SIGTERM'd — every click paid the full
build again, and because the response had no `Content-Length` the browser
could show no progress, offer no resume, and the dashboard had to buffer the
whole tarball in a JavaScript `Blob` before it could hand it to the user. On
the one measured case (searxng, ~2.3 GB logical) the wait was 47 seconds for
1.00 GB, with nothing to look at but "Preparing snapshot… 13s elapsed".

**Everything compressed with gzip.** Not by decision — by each site taking
Incus's default or naming gzip outright. gzip is single-threaded at roughly
50 MB/s. That is slower than a gigabit link, so on a LAN the compressed
download arrives LATER than an uncompressed one would, while 31 of this
host's 32 cores sit idle.

## The compressor

`lib/export-compression.js` is the only place that decides. The order is:

1. what the call asked for (`compression` on `export_lxc`, on
   `POST /api/lxc/exports`),
2. the `exports.compression` app setting (`zstd` | `gzip` | `none`),
3. `zstd`.

Then reality: Incus shells out to the `zstd` binary, so a host without it
FALLS BACK to gzip and says so in the result, rather than failing a backup
over a missing package. `apt install zstd` and the next one is zstd.

The setting is MCP-writable (`set_setting`, policy `settings.writable`) and
governs every guest tarball this install writes:

| Site | What it is |
| --- | --- |
| `GET /api/lxc/containers/:name/export` | the streaming download (still there for scripts) |
| `GET /api/lxc/containers/:name/snapshot/:snap/export` | same, for a snapshot |
| `POST /api/lxc/exports` | a prepared download |
| `export_lxc` (MCP) | the synchronous export |
| `delete_lxc_container`, `delete_project` | the pre-delete tarball |
| `lib/snapshot-s3-export.js` | the snapshot push to S3 (the object's extension follows the compressor) |
| `cleanup_migration` | the tarball taken before a migration's guest is deleted |
| the migration agent | what the SOURCE host compresses a rootfs, a directory or a mysqldump with |

Two places deliberately do NOT follow it:

- **`lib/backup-pack.js`** — the `.tar.gz` member names are part of the pack
  format, and an older ProxyPilot restoring a newer pack has to find them
  where it expects.
- **ZFS dataset compression and syncoid** — different layer, already zstd.

Nothing decompresses by name: `incus import`, `tar` and `zstd -d` all detect
the format from the bytes, and decompression is 5-10× cheaper than
compression, so the restore path never has to know what was chosen.

## Prepared downloads

`lib/lxc-exports.js` builds the tarball ONCE into a file, in the background,
and then the download is an ordinary static file.

- **Prepare** (`POST /api/lxc/exports`, or the container dialog's Backup
  panel) validates the guest and snapshot exist, refuses a second build of
  the same artifact while one is in flight, and refuses outright when the
  guest's used bytes exceed the free space where the tarballs land — with the
  numbers, before anything is started.
- **Build** runs `nice -n 19 incus export` into `<file>.part` and moves it
  into place only when it is whole, so a half-built tarball is never
  servable. A snapshot is materialised as a throwaway instance first
  (instant on ZFS), deleted in a `finally`. One build at a time.
- **Progress** is read from the `.part` file as it grows, every two seconds —
  the only honest source. The percentage's denominator is the guest's used
  bytes from the storage volume, so it overshoots slightly, which is the
  right way round. Ten minutes with no growth is reported as stalled rather
  than hidden (on `dir` storage the copy phase really is silent).
- **Download** (`GET /api/lxc/exports/:id/download`) serves the file with
  `Content-Length`, `Accept-Ranges` and 206 for a Range request, so the
  browser draws its own progress bar and resumes an interrupted download
  instead of starting over. Any number of times, from any device. The bytes
  come back through `dd … iflag=skip_bytes,count_bytes` because the backend
  runs in a container that cannot see the ZFS exports dataset.
- **Delete** removes the file and the row; it refuses mid-build.
- **Retention** keeps the newest 3 per container and drops anything past 14
  days, on boot + every six hours (`index.js`). A prepared download is a
  convenience, not the backup of record — that is sanoid + replication.

`export_lxc`, `delete_lxc_container` and `delete_project` register what they
make in the same store, so the dashboard and `list_lxc_exports` show ONE list
rather than two views of a directory that disagree.

## MCP

- `list_lxc_exports({ container?, state? })` — every prepared download with
  its state, byte progress, compression, sha256, download count and expiry.
- `delete_lxc_export({ id, confirm: true })` — a plain confirm, not a token:
  the guest is untouched and retention would have dropped it anyway.
- `export_lxc({ container, snapshot?, compression? })` — unchanged except
  that it now names the compressor, reports it back, and registers the
  artifact.

## Where the numbers come from

Measured on this host (32 cores, ZFS on NVMe) against a real guest — see
`state/run-ledger.md` for the run. gzip's ~50 MB/s is the number that makes
the default zstd rather than a preference.
