# Handoff — the migration agent (size L)

Adopt a running web application from another server, VM or container onto a
ProxyPilot-managed Incus guest. Branch
`claude/proxypilot-zfs-storage-l9szn1`, merged to `main` and deployed to the
live host in five increments; `docs/features/migration.md` is the feature
doc.

## The one line an operator pastes on a source host

```
curl -fsSL https://<your-proxypilot>/api/migrations/agent/<token>/install.sh | sudo sh
```

`create_migration` (MCP) or **Migrations → New migration** prints it with
the token filled in. It refuses to run as anything but root, picks amd64 or
arm64, downloads the agent from the same tokened URL, **verifies its sha256
against the hash baked into the script**, and execs it with the URL, the
token and the TLS pin. `command_steps` is the same thing in three lines for
an operator who wants to read the script first.

Two variants worth knowing:

- `proxypilot-agent migrate --print` — collect the inventory and print it.
  Sends nothing, needs no token; a source owner can see exactly what would
  leave before agreeing to anything.
- `… --inventory-only` — send the manifest and stop, so the review can
  happen days before the copy.

## What was verified, and how

### Verified end to end on the operator's host (two throwaway guests)

Both runs used `pp-mig-src-lxc`, a throwaway Debian 13 guest carrying a
deliberately realistic app: nginx with a two-name TLS vhost proxying to a
Node app on 127.0.0.1:3000, PostgreSQL with a `sampledb` holding four rows,
a cron entry calling `https://hooks.example.com/nightly`, and a 0600 `.env`
containing `STRIPE_SECRET_KEY=sk_live_THIS_MUST_NEVER_LEAVE_THE_SOURCE`.

**Whole-machine mode (`rootfs-tar`) → `pp-mig-dst-lxc`, 40 seconds:**

| Step | Result |
|---|---|
| bootstrap | agent downloaded, sha256 verified against the script, TLS pinned to the live certificate |
| token | claimed by the agent run; the token carried `_` and `-`, the case that used to be rejected (LEARNINGS 175) |
| inventory | 5 s: Debian 13, 26 units, 9 listening ports, 1 vhost → **2 suggested routes**, postgres/`sampledb`, 5 cron entries, 6 env files / 9 key names, `hooks.example.com` found **in the cron line** |
| secrets | `STRIPE_SECRET_KEY` present as a NAME; `sk_live_…` appears nowhere in the migration row — grepped on the live record |
| gate | migration sat in `awaiting_review` until `approve_migration` |
| transfer | 300 MiB streamed at ~15 MB/s, sha256 verified on arrival |
| import | `incus image import metadata.tar.xz rootfs.tar.gz` → `incus init` → temporary image deleted |
| guest | created stopped and fenced, no route |
| agent | removed itself (`/tmp/proxypilot-migrate.*` gone) |
| **proof** | started the guest: `sampleapp`, `nginx`, `postgresql`, `cron` all active; `curl --resolve sample.example.com:80:127.0.0.1` returns the app through its own vhost; all four database rows present |

**Application mode (`file-sync`) → `pp-mig-dst-app`, 15 seconds:**

| Step | Result |
|---|---|
| target | an existing prepared guest was reused (postgres/node/nginx pre-installed) |
| transfer | `/srv/sampleapp` and `/var/www/sampleapp` tarred to ProxyPilot and unpacked into the guest through `incus exec` |
| database | `pg_dump --format=custom` streamed to ProxyPilot and restored inside the guest by its own engine |
| **proof** | in the target: `select note from sample` returns all four rows; `.env` is present at mode 0600 with its mtime; no sshd, no key and no open port were added to the guest |

**The cutover surface** was exercised over MCP against those rows: a
checklist step marked (recorded with who and the note) and reopened, an
egress decision recorded, and an unobserved host refused
(`evil.example.com:443 is not in this migration's observed outbound list`).

Five defects were found by running it — all fixed, all now pinned by tests,
all re-verified live: LEARNINGS 175 (token split), 176 (Incus URL), 179
(the fence), 180 + 182 (what the fence actually governs), 181 (a finished
run reported as stalled).

**`incus-migrate` → `pp-mig-im-lxc` and `pp-mig-im2`, ~28 seconds each:**

The third transport, run from the same throwaway source with
`transport: "incus-migrate"` forced (a container source would otherwise take
`rootfs-tar`). Three attempts, because the first two found real defects:

| Step | Result |
|---|---|
| readiness | `migration_preflight` read the bridge gateway (10.185.17.1), both agent builds with their hashes, the TLS pin, and said `incus-migrate: false` because Incus was not listening |
| listener | `enable_incus_listener` REFUSED `:8443` ("listens on every interface… a source host on your LAN can use 10.185.17.1:8443"), then enabled the bridge gateway and returned `incus config unset core.https_address` as the reverse |
| prerequisite | `apt install incus-extra` on the source — **not `incus-tools`**, which does not exist on Debian 13 (LEARNINGS 184) |
| attempt 1 | FAILED: the positional answer script fed the trust token into 6.0.4's authentication menu (LEARNINGS 183) → rewritten to answer by prompt |
| attempt 2 | FAILED, and failed WELL: "incus-migrate asked something this ProxyPilot has no answer for: \"Please provide the path to a root filesystem:\"" — 6.0.4 says "a", the rule said "the". One pattern, not a new agent |
| attempt 3 | `Instance pp-mig-im-lxc successfully created`, guest stopped and fenced, checklist open — but "0 B moved" while the tool said 469.71MB: decimal units (LEARNINGS 185) |
| attempt 4 | clean: 455.79 MB streamed at ~46 MB/s, **"transfer finished: 434.7 MiB moved"**, guest fenced and stopped |
| **proof** | started `pp-mig-im-lxc`: `nginx`, `postgresql`, `sampleapp`, `cron` all active; `curl --resolve sample.example.com:80:127.0.0.1` returns the app; all four database rows present; `.env` still 0600 with its original mtime; the cron entry intact |

Note what a whole-machine copy means: the guest keeps the SOURCE's identity —
`/etc/hostname` still says `pp-mig-src-lxc`. incus-migrate does not rewrite it
and neither does ProxyPilot; rename it yourself if you want to.

### Verified by test, not on real hardware

- **A VM source.** `incus-migrate` itself is now proven against this host, but
  with a CONTAINER source: the VM path differs only in two answers (`2` for the
  type and the root block device instead of `/`, with `/dev/sdaN → /dev/sda`),
  both covered by `parse_test.go` and `answers_test.go`. No VM has been
  migrated.
- The Go collectors against recorded fixtures (`parse_test.go`: nginx with
  nested locations and a named upstream, apache, a Caddyfile with a global
  options block, `ss`, `systemctl` including a `●`-marked failed unit,
  crontabs, compose, a nested `findmnt` tree, `.env` keys).
- The agent's own manifest, produced by running
  `proxypilot-agent migrate --print` on this machine and fed through
  `validateManifest` — the Go writer and the JS reader agree on the schema.
- 28 backend cases across manifest / plan / token / service / agent routes,
  including: a manifest carrying a value refused at five different depths, a
  database name that is not a name refused before it reaches a shell, the
  bootstrap script's hash check, and an artifact kind the transport does not
  use refused.

### Not verified

- **The `big-mount` concern inside a container.** On `pp-mig-src-lxc` the
  inventory warns "/ holds 420 GiB" because `df` inside a container reports the
  HOST filesystem it lives on, not the container's own usage. It is a warning,
  not a blocker, and it was right to be loud on a physical host — but on a
  container source it overstates. Parked in `docs/known-issues.md`.
- **A Proxmox source.** The `rootfs-tar` path was exercised against a nested
  Incus LXC, which is the same code path and the same `container=lxc`
  detection, but no actual Proxmox host was involved.
- **A VM source**, for the same reason as `incus-migrate` above.
- **An arm64 source.** The arm64 agent builds and is served with its hash;
  nothing has run it.
- **A large transfer.** The biggest real run was 300 MiB. The rate/ETA maths
  is unit-tested, and `stalled` now only applies to a live transfer, but no
  multi-hour copy has happened.
- **The 360 px layout audit** for the Migrations page: built to
  MOBILE_FIRST by construction (single-column grids, 44 px controls,
  full-screen dialogs under `sm`, the phase rail wraps instead of scrolling)
  but not opened in a browser at that width.

## The Incus listener is now ON on this host

`incus-migrate` connects to Incus **directly** from the source, so verifying
that path meant turning the listener on. It is on, at the Incus bridge
gateway:

```
core.https_address = 10.185.17.1:8443      # private: guests and your LAN, not the internet
```

Turn it off with `incus config unset core.https_address` (the tool returned
that line when it made the change), or from **Migrations → Readiness**, which
is also where it goes back on. A bind on every interface (`:8443`) is refused
unless `allow_public: true` says the source really is on the internet.
`rootfs-tar` and `file-sync` need none of this.

## What the operator must do once, by hand

1. **On the source host**, per transport: `curl` always; `incus-migrate` for a
   whole-machine VM or physical source — **Debian/Ubuntu: `apt install
   incus-extra`** (the Zabbly packages call it `incus-tools`); `tar` for a
   container source; the database client (`pg_dump` / `mysqldump`) if a dump is
   being carried.
3. **In application mode, prepare the target guest** with whatever the app
   needs at runtime — most importantly the database engine, or the restore
   stops with "postgresql is not installed in the guest". ProxyPilot will
   create a bare guest for you if one does not exist; adopting into a guest
   you have prepared is the better path and is supported (it says
   "reusing it" in the log).
4. **Lower the DNS TTL** on the name you are moving, well before the
   `dns_switched` step.

## What the Proxmox tar path still needs

The mechanism is complete and proven (tar → artifact endpoint → split-image
import → guest). What is untested is the Proxmox-specific texture:

- **Bind mounts.** `--one-file-system` means a Proxmox mount point
  (`mp0:` …) is *not* in the tarball. The manifest lists the mounts, so the
  operator can see them, but nothing copies them yet — a second pass with
  application mode, or a manual copy, is needed.
- **Unprivileged-container uid shifting.** The tarball is written with
  `--numeric-owner`, and Incus applies its own idmap on import. A source
  with a non-standard Proxmox idmap should be spot-checked for ownership
  after the import.
- **Very large rootfs.** The tar streams through ProxyPilot to
  `/var/lib/proxypilot/migration/<id>/`, which must have room for the
  compressed rootfs (it is deleted immediately after the import). A 500 GB
  source needs that headroom on the ProxyPilot host's disk; there is no
  pre-flight check for it yet.
- **`/etc/fstab` and systemd mount units** come across inside the rootfs and
  will try to mount things that do not exist in the guest. Look at the
  manifest's `mounts` before starting the imported guest.

## Throwaway guests still on the host

All stopped, none deleted, in case you want to look at them:

- `pp-mig-src-lxc` — the sample source (its `.env` holds a FAKE secret; it also
  carries the `/opt/app/mig2*.sh` scripts used to drive the tests)
- `pp-mig-dst-lxc` — the whole-machine (`rootfs-tar`) result
- `pp-mig-dst-app` — the application-mode (`file-sync`) result
- `pp-mig-im-lxc` — the `incus-migrate` result that proved the app and data
- `pp-mig-im2` — the `incus-migrate` result that proved the byte counter

Migrations 1–6 in the Migrations page are those runs (3 and 4 are the two
failures, kept deliberately: their event logs are the evidence). To remove a
guest: snapshot it (the delete guard requires one) and `delete_lxc_container`,
or say the word and I will. Both throwaway MCP keys minted to drive the tests
are revoked, which also makes the token inside those copied scripts inert.

## Where the parts are

| | |
|---|---|
| Pure | `admin/backend/src/lib/migration/{manifest,plan,token}.js` |
| Readiness | `preflight()` + `enableIncusListener()` in `lib/migration/service.js`; `GET /api/migrations/preflight`, `POST /api/migrations/incus-listener`; MCP `migration_preflight`, `enable_incus_listener`; `components/migration/MigrationPreflight.jsx` |
| Service | `admin/backend/src/lib/migration/service.js` (+ `index.js` singleton) |
| REST | `admin/backend/src/routes/migrations.js` — operator router (sudo) + agent router (token only) |
| MCP | `routes/mcp-tools/migration.js`, `lib/mcp-ext/catalog/migration.js`, flag `mcp.migration` |
| Page | `pages/Migrations.jsx`, `components/migration/*` |
| Agent | `cmd/agent/migrate/*.go` — the same binary as the host agent |
| Build | `scripts/build-migration-agent.sh` (install.sh + update.sh call it) |
| Schema | migration 909: `migrations`, `migration_events` |
| Tests | `admin/backend/src/__tests__/migration-*.test.js`, `cmd/agent/migrate/parse_test.go`, CI in `.github/workflows/storage-integration.yml` |
