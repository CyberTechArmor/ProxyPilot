# Remote MCP server — connect Claude to ProxyPilot

ProxyPilot exposes a remote MCP server (Model Context Protocol, Streamable
HTTP transport) so an AI client on a Claude subscription can operate the
parts of ProxyPilot you'd otherwise drive by hand: deploy zips to static
sites and LXC containers, and list/build/clone AI-dev Projects.

## Connecting

1. **Mint a token** — Security page → *Remote AI access (MCP)* → Create
   token. The raw token (and a ready-to-paste connector URL) is shown once.
2. **claude.ai / Claude mobile** — Settings → Connectors → *Add custom
   connector* → paste the **connector URL**
   (`https://<your-host>/api/mcp/t/<token>` — the token rides in the URL
   because custom connectors can't set headers; treat the URL as a secret).
3. **Claude Desktop / Claude Code / SDK clients** — endpoint
   `https://<your-host>/api/mcp` with header `Authorization: Bearer <token>`.

Revoking the token (same card) immediately cuts the client off.

## What the tools can do

| Area | Tools | Notes |
|---|---|---|
| Static sites | `list_static_sites`, `inspect_static_site_zip`, `apply_static_site_zip` | Two-phase: inspect reports conflicts; apply refuses to overwrite until `confirm_overwrite` — so the AI asks you in-conversation first. Replaced files are kept as `<name>.old`. |
| LXC | `list_lxc_containers`, `inspect_lxc_zip`, `apply_lxc_zip` | Same conflict flow, plus optional startup-script registration (`startup.sh` convention) with run output + exit code returned. |
| LXC observe | `get_lxc_container`, `list_lxc_files`, `search_lxc_files`, `get_lxc_logs`, `probe_lxc_port`, `get_lxc_startup` | All read-only. Container detail (addresses, security/limits config, snapshots, registered startup), file listing/grep inside a guest, journald / startup-service / docker-compose logs without redeploying, and an in-guest port probe that reports status metadata but **never response bodies**. `probe_lxc_port` + `test_route` together separate "app down" from "edge misrouted" in two calls. |
| LXC exec | `run_lxc_command` | One allowlisted command inside a guest, same containment as `run_project_command` (argv → positional parameters, no shell, 64 KB tails, clamped timeout). The allowlist is `lib/mcp-policy/lxc-command-allowlist.json`: read-biased (docker/compose status+logs, systemctl status, journalctl, ip, ss, curl probes, df, free, ls, stat, du), `docker compose up/restart/stop/pull` only in the registered startup working dir, `deny_always` wins over everything — no shells, no package managers, no deletion. |
| LXC lifecycle | `create_lxc_container`, `control_lxc_container`, `set_lxc_config`, `set_lxc_network`, `snapshot_lxc_container`, `lxc_file_diff`, `restore_lxc_file` | Every mutation requires `confirm: true` and snapshots first; there is deliberately **no delete verb** and no force-kill. `set_lxc_config` writes only the keys in `lib/mcp-policy/lxc-config-allowlist.json`; `security.privileged=true` additionally demands `acknowledge_risk: true` and carries the container-root-is-host-root warning. `set_lxc_network` pins a guest's IPv4 (static DHCP reservation) so a lease renewal can't silently 502 a route. `lxc_file_diff`/`restore_lxc_file` complete the `.old` backup story (restore swaps, so it's reversible). |
| Routing | `list_routes`, `get_route`, `test_route`, `set_route` | Inspect every served hostname (orphaned upstreams flagged), per-domain TLS/cert detail, and an edge-vantage probe pinned to the local proxy that names which failure class it found — proxy down, stale proxy→upstream binding, or app-level. `set_route` binds a hostname to a container (preferred) or ip:port through the same DB → regenerate → adapt → reload pipeline the UI uses, with rollback on failure; overwrites need `confirm_overwrite` and return the previous binding. |
| Static-site management | `create_static_site`, `get_static_site`, `list_static_site_files`, `read_static_site_file`, `write_static_site_file`, `get_static_site_cert` | Site creation (creation-only — refuses an already-routed domain), docroot inspection, single-file read/write with the `.old` + `confirm_overwrite` contract, and certificate status. Site ids are uuid strings for UI-created sites; the zip tools accept both uuid and legacy integer ids. |
| LXC file edits | `read_lxc_file`, `write_lxc_file`, `rerun_startup` | The chat-only update loop: read a file, propose the edit, write on approval (previous version kept as `<path>.old`), then re-run the registered startup script to redeploy — run output and exit code come back to the chat. `write_lxc_file` takes an optional `mode` ("0755") so a script lands executable without a zip apply. `rerun_startup` takes `timeout_seconds` (default 120, max 1800) and returns the **last** 64 KB of each stream — a first-boot Docker install no longer has to fit inside a fixed 2-minute window, and the failure summary (which prints last) is what comes back. Lets a Claude subscription do small container updates without any zip or shell. |
| Projects | `list_projects`, `get_project`, `create_project`, `clone_project`, `upload_project_reference` | `list_projects` takes optional `lifecycle` (`active` / `stopped` / `archived` / `all`) and `pinned` filters and every row carries `pinned` — the Projects-page star, read project-wide (true when *any* user has starred it). `get_project` adds `container` (the Incus instance name, `m2-<id>`) and `container_status` (`running` / `stopped` / `none`). `create_project` mints `<slug>.<parent domain>` from the name and provisions the container — the same path as the UI's Create, minus the model-picked design preset. `clone_project` mirrors the UI's Clone (fresh / full-with-database). Both return immediately; poll `get_project` until `lifecycle` is `active`. `upload_project_reference` stores the file as-is (no generated brief — that pass is a model call). **No tool here queues a build**: see *The one lane* below. |
| Project archive / host usage | `set_project_lifecycle`, `set_project_pinned`, `get_host_usage`, `reclaim_report` | Reclaim host memory without the UI — see *Archiving idle projects* below. `set_project_lifecycle` archives **one** project per call (refused while pinned or while a build is live), snapshotting and cleanly stopping its guest and forcing `boot.autostart` off while keeping routes, DNS, checkout, database and the container itself, so `action: "unarchive"` is a pure reversal. `set_project_pinned` toggles the star. `get_host_usage` reads CPU/memory/swap/disk/pool/container numbers from the host (never a guest); `reclaim_report` is the deterministic before/after delta. Policy: `lib/mcp-policy/project-lifecycle-allowlist.json`. |
| Project build control | `interrupt_project_build`, `cancel_queued_build` | Stop a running build (checkpoint-and-stop by default, or abandon) and cancel not-yet-started queue entries — the "that build is burning tokens on the wrong thing" stop switch, from chat. These only ever *reduce* spend; the builds they stop are started from the UI. |
| Project orientation | `project_map`, `read_project_files`, `search_project_files` (`context_lines`) | The round-trip reducers — see *One call, not twenty* below. `project_map` returns every tracked file with its line count and its top-level symbols in one call; `read_project_files` reads up to 50 files (or ranges) at once; `search_project_files` with `context_lines` returns the code **around** each hit, which is what removes the search → read → read → read chain. |
| Project file reads | `list_project_files`, `search_project_files`, `read_project_file` | The granular forms, for when you genuinely want one thing. `search_project_files` is `git grep -E` over the tracked files and returns `path` + `line_number` + the matching line (add `context_lines` for the surrounding code, or `files_with_matches` for paths only); `read_project_file` takes `offset`/`limit` to pull one window (it always reports `total_lines`, so a ranged read can say what it left behind). Reading whole files to find one function is the expensive habit these exist to break. |
| Project file edits | `apply_project_patch`, `write_project_file`, `edit_project_file`, `append_project_file`, `insert_project_file_at_line`, `delete_project_file`, `move_project_file`, `redeploy_project` | The subscription lane for Projects: the chat does the thinking, ProxyPilot only executes file ops — no build tokens spent. `edit_project_file` replaces an exact string and refuses unless the match count is what the caller expected, which is the one to reach for on a large file — `write_project_file` rewrites the whole thing and gets riskier the bigger the file. `append_project_file` and `insert_project_file_at_line` add to a file without moving its existing content anywhere, which is the safe way to extend a big one. Every write is staged, hashed and read back before it counts as done, and every writing tool takes an optional `expected_sha256` precondition. `move_project_file` uses `git mv` so history follows. For a change that spans **more than one file or one hunk**, `apply_project_patch` does the whole thing in one call — see below. All are git-committed and pushed, and all are refused while a build is running. `redeploy_project` then installs/migrates/builds/restarts and health-checks the live app. |
| Project history | `project_git_log`, `project_git_diff`, `project_git_show` | Read-only history as structured data: `project_git_log` returns parsed commit rows rather than raw text. `project_git_diff` with no `ref` shows uncommitted work **and lists untracked files** — that is how you catch a build that wrote a file and never committed it, which is invisible to `git log` and to reviewers but still on disk and still running. Raw git is also reachable via `run_project_command` when you want a specific format. |
| Build diagnosis | `get_build_log` | The recorded event stream of one cycle — status, error, and the steps it produced. A failed build otherwise surfaces as a status with no output, leaving nothing to diagnose from. Keeps the tail (a failure explains itself at the end). |
| Audit trail | `append_change_record` | Appends a hash-chained record for chat-lane work, which otherwise writes none. ProxyPilot computes `seq`/`prev_hash`/`hash` server-side through the same code the build runner uses, and mirrors the record to `state/changes/<seq>.json` in the checkout. The chain is re-verified immediately after appending. **Never hand-compute these hashes** — see below. |
| Project verification | `run_project_command` | Runs one allowlisted command in the project's checkout — `npm ci`, `npm run <script>`, `npx playwright …`, or a read-only `git` subcommand — so the chat lane can run the project's own gates instead of shipping unverified. Same container and environment `redeploy_project` builds in (`/etc/environment` sourced, cwd = the app dir), so a green result means what it says. Returns `exit_code` plus the **last** 64 KB of each stream (a failing test prints its summary last). Refused while a build is running. |
| Transfer | `create_upload_ticket`, `append_upload_chunk`, `finish_upload` | Big zips: the ticket tool returns a one-shot `upload_url`; `curl -T site.zip -H 'Content-Type: application/zip' <url>` pushes the bytes, then the ticket is referenced in an inspect tool. Clients that cannot reach the upload URL (egress-restricted agent sandboxes) instead send ordered base64 chunks over MCP with `append_upload_chunk` and seal them with `finish_upload`, whose mandatory `sha256` is verified before the ticket becomes usable. Zips ≤ 2 MB may ride inline as `zip_base64`. The inspect tools also accept an optional `sha256`, verified **before** parsing, so transport corruption fails as a checksum mismatch rather than a confusing extraction error. |

## Archiving idle projects (reclaiming the host)

Every AI-dev project keeps a guest running, and a host full of finished projects runs out of memory before it runs out of disk. The archive flow lets an agent hand memory back without touching the UI:

1. `get_host_usage({ per_project: true })` — the before picture: load, memory, swap, `/` and the Incus pool, container counts, the top guests by memory, and one row per project saying what its guest holds.
2. `list_projects({ lifecycle: "active", pinned: false })` — the candidates. A pinned project (the star on the Projects page, read project-wide: anyone's star counts) is never a candidate.
3. One `set_project_lifecycle({ project_id, action: "archive", confirm: true })` **per project**. There is deliberately no archive-all verb: each archive is its own audit row, its own change record, and its own pinned check — a pinned project refuses by name rather than being skipped silently, and a project with a running or queued build refuses and points at `interrupt_project_build` / `cancel_queued_build`.
4. `get_host_usage()` again, or `reclaim_report({ before })` for the arithmetic (`memory_freed_mb`, `containers_stopped`, `load_delta`, `disk_freed_gb`) plus a plain-language summary.

What an MCP archive does, in order: checkpoint-commit the working tree into the bare repo (so the UI's *Rehydrate*, which rebuilds from that repo, stays lossless), take an Incus snapshot (the same auto-snapshot `set_lxc_config` takes — the archive refuses without one), cleanly stop the guest (`stop_container: false` keeps it running), set `boot.autostart=false` so it stays down across a host reboot, and mark the row `archived`. Routes, DNS, the checkout, the database, the bridge and the container are all **kept** — nothing is freed except memory and CPU, which is the point. The result carries `previous_lifecycle`, the `snapshot` name and a `reverse_with` call.

`action: "unarchive"` reverses it from the state the archive recorded on the row (migration 557): `boot.autostart` goes back to its pre-archive value (unset stays unset), the guest is started only if the archive step was the one that stopped it, the previous lifecycle returns (`active`, or `stopped` for a project that was already idle-stopped), the route is republished and re-verified with `test_route`.

This is a different verb from the UI's *Archive*, which destroys the guest and rebuilds it from the bare repo on *Rehydrate*. Both leave `lifecycle = archived`; a UI-archived project has no container (`get_project` reports `container_status: "none"`) and `unarchive` over MCP refuses it, pointing at *Rehydrate*. A UI *Rehydrate* of an MCP-archived project works too (it deletes the kept guest and rebuilds from the checkpoint) — it is just slower than `unarchive`.

`set_project_pinned({ project_id, pinned, confirm: true })` stars the project for the token's owner (`pinned: true`) or removes every user's star (`pinned: false`) so the project-wide flag really reads false. Pinning an archived project is allowed; it only protects it from bulk operations.

## The restricted sibling: delegated editing

A second, separate MCP endpoint (`/api/mcp-editor`) exists for handing somebody
*outside* ProxyPilot the ability to edit one directory of one container — an
agency fixing their own site's CSS, without containers, routes, projects or a
shell. Its credentials are pinned to one container server-side, its catalog is
eight content tools and is a different object entirely from `MCP_TOOLS`, and its
paths are confined to a docroot. Nothing in this document's tool surface changes
because of it. See `docs/features/delegated-editing.md`.

## One call, not twenty (working on project files)

Every MCP tool call is a full model turn — roughly 15–30 seconds whether it
moved a megabyte or a single line. So the cost of an agent editing a project
through this server is the **number of calls**, not the bytes. A recent
single-feature change took 39 minutes across 116 + 49 agent steps, and the
great majority of those steps were "find the code" and "read a bit more of
this file" rather than "write the change".

Four tools exist to collapse that. The intended sequence, which the server
also states in its `initialize` instructions:

1. **Orient** — `project_map`. Every tracked file with its line count and its
   top-level symbols (exported functions, classes, consts, types, default
   exports, route registrations) in one call. Do not rebuild this picture with
   `list_project_files` plus a read per file. The symbol index is
   **regex-extracted and approximate**: a map for deciding what to open, not a
   compiler. Narrow a big repo with `subdir`.
2. **Search** — `search_project_files` with `context_lines` set (5–10 is
   usually right). The result is then `blocks` — contiguous runs of
   `{ path, start_line, lines[], match_lines[] }` — so the surrounding code
   arrives *with* the hit. Do not follow a search with reads unless the
   context genuinely was not enough. `files_with_matches: true` answers "does
   this symbol exist anywhere" for almost nothing.
3. **Read** — one `read_project_files` call listing every file you still need
   (up to 50, ranges allowed), not one call per file.
4. **Write** — `apply_project_patch`. Send the whole change as a unified diff:
   one call, one commit. A sequence of `edit_project_file` calls for a
   multi-file change is the slow path; the single-file tools are for a
   genuinely single-file, single-place edit.
5. **Verify** — `run_project_command` (`npm run gates`), then
   `redeploy_project`.

A representative five-file feature change is six calls end to end: map →
search-with-context → batch read → `apply_project_patch` with `dry_run: true`
→ apply → `run_project_command`.

### `apply_project_patch` is all-or-nothing

The tool is only worth having if a rejected patch is *exactly* as harmless as
never calling it. It is applied with `git apply --3way --index` inside the
project container, and four things hold that line:

- **The patch is a verified write like any other.** It is delivered over
  stdin, staged to a temp file, byte-counted and hashed *before* git is
  allowed to read it. Pass `sha256` and a corrupt transfer fails as a checksum
  mismatch rather than as a confusing rejected hunk.
- **The touched paths must be clean.** If any file the diff names has
  uncommitted work, the patch is refused rather than applied on top of it —
  which is also what makes the rollback exact rather than best-effort.
- **Every failure path rolls back**, including the one that looks like
  success: with `--3way`, `git apply --check` **exits 0** for a patch it could
  only apply *with conflicts*, and applying it would leave conflict markers in
  a source file. That case is detected and refused.
- **The report is per-hunk.** A rejection names the file, the line, and why
  ("hunk context does not match the file at this line", "file is not in the
  checkout", "applied with conflicts"), because "failed" tells a model nothing
  it can act on.

`dry_run: true` runs the same checks and returns the per-file change types and
line counts without writing anything. `expected_sha256` takes a
`{ path: sha }` map — the concurrent-editor guard `edit_project_file` has,
one entry per file — and refuses the whole patch if any of them moved. Diffs
over 1 MB go through `create_upload_ticket` and are passed as `ticket`.

Patches may only touch paths inside the app checkout: absolute paths, `..`
and anything under `.git` are refused before git ever sees the diff.

### Nothing is ever partially returned

`read_project_files` inherits the property that matters from
`read_project_file`: a file comes back whole or not at all. Each file is
hashed **inside the container** and the hash is checked here, so a truncated
transfer is an error against that file rather than a plausible-looking prefix
of it. A file over the 512 KB per-file cap, or one that will not fit in what
is left of the response budget (`max_total_bytes`, default 512 KB), is listed
in `dropped` with its size and the reason. The same holds for the search
budgets: anything cut is reported as `truncated`, never silently trimmed.

### What deliberately did not change

`run_project_command` is still not a shell. No pipes, no redirects, no `$()`,
no `;` or `&&` — the `npm run <script>` escape hatch already covers legitimate
repo-side tooling, and those scripts are committed and reviewable. The
batching above is the answer to round trips; a shell is not.

## The one lane (this server spends no API budget)

There used to be two lanes here and the words you chose picked one. The
budget-spending one is gone: `send_project_build` — the tool that queued work
onto the project's own AI harness, on the API key configured in ProxyPilot —
is no longer part of this surface. The harness lane still exists, but it is
started from the **UI**, where the person paying for it sees the estimate
first. Nothing a chat can call over MCP bills the project's connector.

What that leaves is the lane that was already the cheap one:

- `project_map` → `search_project_files` (with `context_lines`) →
  `read_project_files` → `apply_project_patch` → `run_project_command` →
  `redeploy_project`: the chat itself (your Claude subscription) does the
  thinking; ProxyPilot only reads/writes files, runs the project's own checks,
  and redeploys. The harness's own gates still don't run in this lane, but
  `run_project_command` closes the gap that mattered most — the chat can run
  `npm run gates` itself and show you the exit code before you approve a
  deploy. Review the diffs either way.

Two other paths that used to spend were closed with it:
`upload_project_reference` no longer queues the document-summary model call
(the file is stored and read in full instead of as a brief), and
`create_project` always seeds the built-in design preset rather than the `ai`
one, which would have a model pick the look. `interrupt_project_build`,
`cancel_queued_build` and `get_build_log` remain, because reading and stopping
a UI-started build is how you *stop* paying for it.

  Note that `redeploy_project` runs the project's **build**, not its tests: a
  green deploy proves the checkout compiles and boots, never that it passes.
  Ask for `run_project_command` explicitly if you want the tests run.

## The change-record chain (do not hand-compute it)

`state/changes/` is an append-only, hash-chained audit trail:
`hash = sha256(prev_hash + canonical_json(payload))`, with `prev_hash = ''`
for `seq` 1. The authoritative implementation is
`admin/backend/src/mock2/change-logic.js`.

The part that catches people out is **what `payload` is**. It is not "the
record minus its hashes" — it is an explicit twelve-field allowlist
(`changePayload`), with its own defaults, in sorted-key canonical JSON:

    project_id, cycle_id, seq, initiated_by, acting_as_admin,
    framework_version, framework_version_id, rules_touched,
    gates_run, commit_sha, summary, created_at

Missing fields become `null` (`summary` becomes `''`), `acting_as_admin` is
normalized to `1`/`0`, and anything else on the row — the SQLite `id` above
all — is **excluded**. A recipe derived by matching existing records will
agree on rows that happen to carry exactly those fields and silently diverge
on any row that does not, which is the worst possible failure for an audit
trail: it keeps looking verified while chaining to nothing.

So append records with `append_change_record`, which calls
`insertChangeRecord` and derives `seq` and `prev_hash` inside a transaction
from the project's last record. It verifies the whole chain immediately
afterwards and reports `chain_ok`. There is a unit test asserting that the
naive recipe produces a *different* hash from the real one, so this cannot
quietly stop being true.

## Security model

- Tokens are bearer secrets (`ppmcp_…`); only a sha256 hash is stored.
  Minting/revocation is admin-only and audited (`MCP_TOKEN_*`).
- Every tool call runs under the identity of the admin who minted the token
  (audit rows carry `via: 'mcp'`).
- The endpoint is CSRF-exempt by design: authentication never rides ambient
  cookies, so a cross-site request cannot ride a session.
- Upload tickets are single-use, unauthenticated-by-ticket (the ticket *is*
  the secret, minted over the authenticated channel), and expire in 30 min.
- No server-initiated SSE stream is offered (GET returns 405) — every
  feature is plain request/response, which the MCP spec permits.
- **`run_project_command`'s allowlist is not a sandbox, and must not be read
  as one.** It bounds the *command surface* — a typo or a confused model
  cannot `rm -rf`, `curl` something out, or install a package — and it makes
  the audit row state an intention a human can read. It does not bound
  *privilege*: `npm run <script>` executes whatever `package.json` says, and
  `write_project_file` can edit `package.json`, so a client holding the token
  can already reach arbitrary code in the container by writing a script and
  invoking it. That is accepted rather than overlooked — the same token
  already drives `redeploy_project`, which builds and runs the checkout. Treat
  an MCP token as equivalent to deploy access to every project.
- The caller's command never reaches a shell: the argv is passed to `sh` as
  positional parameters (`sh -c '… exec "$@"' sh npm run gates`), so no token
  is ever re-parsed. Shell syntax (`;`, `&&`, `|`, `>`, `$(…)`) is refused
  with a message telling the caller to make separate calls.

## Limitations / follow-ups

- The LXC / static-site / routing surface above implements the field-derived
  upgrade spec packaged as
  `docs/features/examples/mcp-lxc-sites-upgrades.component.json`
  (key `mcp-lxc-sites-upgrades`) — its six bugfixes plus all 25 tool
  definitions. The component remains the design record: its `policy/` files
  are vendored verbatim as `admin/backend/src/lib/mcp-policy/*.json` (the
  enforcement source of truth for `run_lxc_command` and `set_lxc_config`) and
  must be kept in sync. Deviations from the spec, chosen deliberately:
  `rerun_startup` gained `timeout_seconds` directly (no separate
  `rerun_startup_v2`; `dry_run` is covered by `get_lxc_startup`), and
  `set_route` has no `enabled` toggle because the Caddy regenerator renders
  every stored route — parking a hostname stays a UI/host operation.
- `set_route` manages root-path bindings only; path-prefixed fan-out routes
  (e.g. `/api` → a second port) are still UI-only over MCP.
- Auth is token-based, not OAuth 2.1 with dynamic client registration.
  claude.ai connects fine via the tokenized URL; a full OAuth flow is a
  possible follow-up (see docs/known-issues.md).
- Upload tickets live in process memory — a backend restart between
  `create_upload_ticket` and the PUT invalidates the ticket (re-create it).
- `edit_project_file` refuses files over 512 KB. It reads the file out,
  replaces in the backend and writes it back, and the reader caps at 512 KB —
  so editing a larger file would drop everything past the cap. Use
  `append_project_file` / `insert_project_file_at_line` to ADD to such a file
  (neither moves the existing content), or `write_project_file` with the
  complete content to replace it.
- `search_project_files` returns matching lines, not surrounding context. Pair
  it with `read_project_file`'s `offset`/`limit` to pull the lines around a
  hit; that composes better than a fixed context window and costs one extra
  call only when you actually need the context.
- `run_project_command`'s timeout (default 600s, max 1800s) kills the `incus`
  client, not the process inside the container — a command that overruns may
  still be running there. The result says so when it times out. `deploy.js`
  has the same property and reaps orphans via a marker in the command line;
  this tool deliberately does *not* carry that marker, so a later deploy will
  not kill a test run that is still going.

## Write integrity

A read-modify-write tool is only as trustworthy as its read. This one was
not, once: the host capture wrapper stopped at 256 KB while the file tools
advertised 512 KB, so files in between came back cut at a chunk boundary and
`edit_project_file` wrote the stump back over the original — five files, no
error, cut points varying with the chunk (~267 KB, ~299 KB, ~327 KB). Four
checks now stand between a bad read and a written file, cheapest first:

1. **The transport reports its cap.** `runHostCapture` returns
   `stdoutTruncated` and `stdoutComplete`, file reads run with a budget above
   the 512 KB read cap, and a capped or unflushed read is an error rather
   than a short string that looks like a file.
2. **Reads are checked against the file.** Every read carries the file's byte
   count and its SHA-256 as computed *inside* the container. What arrives
   must match both, or the call fails before anything is written.
3. **The byte-count invariant.** A literal string replacement has exactly one
   possible result length: `original − len(old)×n + len(new)×n`, in bytes,
   against the file's on-disk size. `edit_project_file` refuses to write
   anything else. Each of the five truncations missed it by tens of
   thousands of bytes.
4. **Read-back on every write.** Content is staged next to the target,
   verified there by byte count and SHA-256, renamed into place, then re-read
   and re-hashed at its real path. A write that does not verify leaves the
   previous file exactly where it was, and says so.

`apply_project_patch` inherits all four rather than opting out of them: the
diff itself is staged, byte-counted and hashed before git reads it (check 1
and 2); `git apply --check --3way` is the equivalent of check 3, run before
anything is written, with the `--3way` "applied with conflicts" case — which
git scores as exit 0 — treated as a rejection; and the resulting files are
re-hashed off disk afterwards rather than taken from git's account of them
(check 4). A patch that does not apply leaves the checkout byte-identical,
and every failure path rolls the touched paths back explicitly.
`read_project_files` carries check 2 per file: each file is hashed inside the
container, checked here, and dropped by name rather than returned short.

On top of those, `expected_sha256` is an optional precondition on
`edit_project_file`, `write_project_file`, `write_lxc_file`,
`append_project_file`, `insert_project_file_at_line` and — as a
`{ path: sha }` map — `apply_project_patch`: pass the `sha256`
that came back from the matching read tool and the call is refused if the
file has changed since — the guard for two agents editing one file. Every
write returns `bytes`, `total_lines` and `sha256` of what actually landed, so
a caller can assert without a second round trip.

## Talking to the host (Incus CLI, guest addressing, listing budget)

Three field-found defects, all fixed in the shared helpers rather than in the
tools that surfaced them (mailcow migration, current Incus release):

- **Snapshots use the subcommand CLI.** Current Incus spells snapshot
  management `incus snapshot create|list|delete|restore <instance> …`; the
  legacy LXD-style `incus snapshot <instance> <name>` fails with
  `unknown command "<instance>" for "incus snapshot"`. Because every mutating
  LXC tool snapshots before it changes anything — and `set_lxc_network`
  refuses to run without its snapshot — the stale spelling blocked IP pinning
  outright. `takeLxcSnapshot` (routes/mcp.js) now renders argv through
  `snapshotArgv()` and detects the host's spelling ONCE by probing
  `incus snapshot create --help`, caching the answer for the process; a
  shape-mismatch stderr (and only that) is retried once in the other form.
- **A guest's upstream is its bridge address.** `incus list` reports a
  docker-ready guest's `docker0` / `br-*` / `veth*` interfaces alongside its
  NIC, and taking "the first non-loopback address" bound a route to
  `172.22.1.1` — a Docker gateway inside the guest, unreachable from the host,
  so every request 502'd. Address resolution now goes through the NIC device
  attached to a host network (`network:` / `parent:`): `get_lxc_container`
  returns addresses host-reachable-first, each tagged `bridge` / `internal`,
  with `primary_address` naming the one to bind to, and `set_route` /
  `set_lxc_network` / `list_lxc_containers` all read that. A guest holding
  only internal addresses is an explaining refusal, never a silent 502.
  `set_route` additionally probes `ip route get <upstream>` before writing: no
  route at all refuses a container-resolved upstream (nothing is left to wait
  for) and warns on a literal `upstream_ip` (which an operator may bind ahead
  of the network that serves it), a via-a-gateway route is applied with a
  warning, and an unreadable probe changes nothing.
- **`incus list --format json` gets its own capture budget.** Each guest entry
  is 10–20 KB of state/config/devices/snapshots, so on a ~15-guest host the
  listing crossed the 256 KB default host-capture budget and arrived cut —
  reported as "incus list returned unparseable JSON", which pointed the
  diagnosis at incus instead of at our own transport. Every `incus list`
  shell-out now runs on `LXC_LIST_CAPTURE_CAP` (16 MB), and a listing that
  still fails reports the byte count, whether the budget or an early stdout
  close cut it, and incus's stderr.

## Troubleshooting

- **"Couldn't register with ProxyPilot's sign-in service" on claude.ai** —
  fixed in 1.4.0: OAuth discovery probes (`/.well-known/oauth-*`) used to be
  answered by the SPA with a 200, which made claude.ai attempt OAuth client
  registration. They now 404 cleanly. Leave the OAuth Client ID/Secret fields
  empty — auth is the token in the connector URL.
- **Connector URL starts with `http://`** — fixed in 1.4.0 (the backend now
  honors the proxy's X-Forwarded-Proto). Re-copy the URL after updating, or
  just change the scheme to `https://` by hand.
