# Delegated editing

Hand somebody outside ProxyPilot a key that lets **their** Claude edit the files
of **one** directory in **one** LXC container — and take it back at any time.

The main MCP server (`docs/features/mcp.md`) is the opposite of this: it hands a
trusted operator the whole host. Delegated editing exists because "let the
agency that maintains unlimited.lighting fix their own CSS" should not require
giving them containers, routes, projects and a shell.

---

## The trust model

**The key holder is assumed hostile.** Not because they are, but because the key
may leak and because their AI session may be talked into something by a page it
reads. Every guarantee below is enforced server-side against a client that sends
whatever it likes. Nothing depends on the client naming the right container or
behaving well.

Three consequences shape the whole design:

1. **Scope lives on the key row.** The endpoint derives the container from the
   authenticated key on every call. There is no `container` parameter in any
   tool schema — not one the server ignores, one that *does not exist*. A prompt
   injection cannot express the request.
2. **The tool set is a separate catalog, not a filter.** `EDITOR_MCP_TOOLS` in
   `admin/backend/src/lib/editor-keys-logic.js` is its own list. A tool that is
   not in it was never registered on that endpoint, so it does not resolve by
   name — there is nothing to deny.
3. **Everything is read per request.** No cached auth decisions. Revoking a key,
   flipping the toggle, or changing the docroot takes effect on the very next
   call.

---

## Where the pieces live

| File | What it is |
|---|---|
| `admin/backend/src/lib/editor-keys-logic.js` | The pure layer: token shape, docroot and path validation, the containment predicate, the in-guest canonicalization script, the restricted catalog, the rate limiter. Native-free, so it tests without a database. |
| `admin/backend/src/lib/editor-keys.js` | The store: activations and keys in SQLite, plus the audit writes. |
| `admin/backend/src/routes/mcp-editor.js` | The restricted MCP endpoint and the admin API. |
| `admin/backend/src/routes/mcp.js` | Exports `runDelegableLxcTool` — a frozen eight-name allowlist over the existing LXC content handlers — and `lxcContainerExists`. |
| `admin/frontend/src/components/lxc/DelegatedEditing.jsx` | The **Sharing** tab on a container's dialog. |
| `admin/backend/src/__tests__/editor-keys-logic.test.js` | The containment tests, written as attacks. |

Migrations **901** (`lxc_editor_activations`) and **902** (`lxc_editor_keys`) in
`admin/backend/src/db.js`.

---

## Endpoints

`/api/mcp-editor` — the restricted MCP endpoint. Bearer auth with a `ppedit_`
key, or `/api/mcp-editor/t/<token>` for claude.ai custom connectors, which
cannot set headers. A **separate path**, not a separate port: ProxyPilot is one
Express app behind one Caddy site, and a second listener would need its own
firewall rule, TLS story and deployment line for no isolation the path does not
already give. The isolation that matters is the catalog, and that is a different
object entirely. CSRF-exempt for the same reason the main endpoint is — the
token never rides ambient cookies.

`/api/lxc-editor/*` — admin API behind the normal cookie session, admin only:

| Route | Does |
|---|---|
| `GET /activations` | Every container's activation, for badging the list. |
| `GET /:container` | One container: activation, keys with live status, whether the container still exists. |
| `PUT /:container/activation` | Turn it on/off and set the editable directory. |
| `POST /:container/keys` | Mint a key. **The only response that ever contains the plaintext.** |
| `DELETE /:container/keys/:id` | Revoke — permanent, immediate. |

---

## The tools a key can reach

Eight, all content:

`list_files`, `read_file`, `search_files`, `write_file`, `file_diff`,
`restore_file`, `inspect_zip`, `apply_zip`

They map onto the main server's existing LXC content handlers, so a delegated
write goes through **exactly** the same staged-and-verified path as an admin
write: a file that exists is not replaced until `confirm_overwrite: true`, every
replacement is kept as `<name>.old`, and every write is hashed and read back
before it counts as done. `file_diff` and `restore_file` work off those backups.

**Not on the endpoint in any form:** `run_lxc_command`, container lifecycle
(create/delete/start/stop), `set_lxc_network`, `set_lxc_config`, snapshots,
`get_lxc_logs`, `probe_lxc_port`, `rerun_startup`, and every project, route,
static-site, upload-ticket and host tool.

Two absences worth calling out:

- **`apply_zip` cannot register or run a startup script.** The underlying
  handler can; the delegated call pins `run_startup: false` and
  `startup_script: null` server-side, so a file drop is never a code-execution
  primitive.
- **There are no upload tickets.** A delegated zip rides inline as base64, so it
  is capped at about 2 MB. This is a real limitation: a large site upload is an
  admin operation, on the main endpoint.

---

## Docroot confinement

An activation has exactly one editable root, set by the admin (default
`/var/www/html`). It lives on the **activation**, not the key, so all of a
container's keys share it and changing it applies to every one of them on their
next request.

From the key holder's side the docroot is `/`. They pass relative paths; a
leading `/` is accepted and means root-relative, never the host root. Results
come back rewritten into those coordinates, including the tails of error
messages — the docroot's real location is not something a delegated session
learns.

Confinement is two layers, and both are needed:

1. **Argument validation** (`validDelegatedPath`) rejects `..` in any position,
   backslashes and control characters before anything runs.
2. **Canonicalization inside the guest** (`canonicalizePathScript`) resolves the
   path with `cd -P && pwd -P` and checks containment — of the parent as well as
   the leaf. This is the layer that matters: a symlink planted inside the
   docroot can only be resolved where it lives, and a symlinked *directory*
   defeats a leaf-only check. Exit 65 = docroot missing, 66 = parent missing,
   67 = outside.

The result is re-checked on the Node side from the script's output before
dispatch. `/` is refused as a docroot by both `validDocroot` and the script
itself — it would make every containment check trivially true.

Zip entries are covered by the shared parser (`lib/zip-extract.js`), which
already rejects absolute paths, `..` traversal and symlink entries before
extraction. `apply_zip` additionally re-checks the staged upload's target
directory against the **current** docroot, because the staging store is shared
with the main endpoint and because the admin may have changed the docroot since
the inspect.

---

## Key lifecycle

`ppedit_` + 64 hex. A distinct prefix from the main server's `ppmcp_` so a
leaked secret is identifiable on sight — in a log, a secret scanner, a
screenshot — as delegated editing rather than host access.

Only the sha256 hash is stored. `token_prefix` (the first 14 characters) is kept
purely so an admin can match a key in hand to a row; it leaves 228 bits unknown.
The plaintext appears in the creation response and nowhere else, ever.

Four states:

| Status | Means | Reversible? |
|---|---|---|
| `active` | Working | — |
| `revoked` | This key, permanently | **No.** Issue a new one. |
| `suspended` | The container's toggle is off — every key at once | Yes |
| `orphaned` | The container no longer exists | Only by recreating it |

Revocation outranks the others: a revoked key reads as revoked whatever else is
true. A key can only be created for a container that exists at creation time. A
deleted container's keys are **not** auto-deleted — they show as orphaned so the
admin sees what was pointing at it.

---

## Audit and limits

Every delegated call lands in the normal `audit_log` as `LXC_EDITOR_CALL` with
the key id, label, display prefix, tool, path and outcome — never the token.
Activation changes, key creation and revocation are logged too
(`LXC_EDITOR_ACTIVATED` / `_DEACTIVATED`, `LXC_EDITOR_KEY_CREATED` /
`_REVOKED`), as are failed auth attempts (`LXC_EDITOR_AUTH_FAILED`).

Rate limiting is a token bucket per key (120 burst, 60/min refill — sized for a
model that reads a lot while orienting and then writes slowly) and a tighter one
for failed auth (10 burst, 5/min). The per-key bucket is charged **per tool
call, not per HTTP request**: a JSON-RPC batch is an array of messages, so
charging the request would let one POST carrying two hundred calls through for
the price of one. Batches are additionally capped at 20 messages.

**Known limitation:** the failed-auth limiter keys on `req.ip`, and ProxyPilot
does not set Express's `trust proxy`. Behind the bundled Caddy that degrades to
one shared bucket rather than one per source. Reading `X-Forwarded-For` instead
would be worse — without a trusted-proxy setting the header is
attacker-controlled, so a guessing client could pick a fresh bucket per request.
A successful auth never touches this limiter, so a working key is never locked
out by somebody else's failures.

---

## Admin UI

Container dialog → **Sharing**. Turn delegated editing on (which requires
setting the editable directory), create a labelled key, and see the key list
with each key's live status, display prefix, created and last-used times, and a
Revoke button. The new key is shown once, full-screen on a phone, with the
ready-to-paste connector URL.

---

## What is deliberately not here

No multi-container keys. No scope for static sites or projects — the key table
carries a `scope_type` column defaulting to `'lxc'` so a second scope is an
insert rather than a table rebuild, but only the LXC scope is built. No expiry
dates; revocation covers it. No self-service key management for the holder.
