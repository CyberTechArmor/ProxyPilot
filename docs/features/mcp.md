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
| LXC file edits | `read_lxc_file`, `write_lxc_file`, `rerun_startup` | The chat-only update loop: read a file, propose the edit, write on approval (previous version kept as `<path>.old`), then re-run the registered startup script to redeploy — run output and exit code come back to the chat. Lets a Claude subscription do small container updates without any zip or shell. |
| Projects | `list_projects`, `get_project`, `send_project_build`, `upload_project_reference`, `clone_project` | `send_project_build` queues a quick update on the project's own AI harness — **this lane spends the project's configured API budget**. `clone_project` mirrors the UI's Clone (fresh / full-with-database). |
| Project build control | `interrupt_project_build`, `cancel_queued_build` | Stop a running build (checkpoint-and-stop by default, or abandon) and cancel not-yet-started queue entries — the "that build is burning tokens on the wrong thing" stop switch, from chat. |
| Project file edits | `list_project_files`, `read_project_file`, `write_project_file`, `redeploy_project` | The subscription lane for Projects: the chat does the thinking, ProxyPilot only executes file ops — no build tokens spent. Writes are git-committed to the project's history (and pushed to its repo), and refused while a build is running. `redeploy_project` then installs/migrates/builds/restarts and health-checks the live app. |
| Transfer | `create_upload_ticket` | Big zips: the tool returns a one-shot `upload_url`; `curl -T site.zip -H 'Content-Type: application/zip' <url>` pushes the bytes, then the ticket is referenced in an inspect tool. Zips ≤ 2 MB may ride inline as `zip_base64`. |

## The two AI lanes (how to phrase a request)

A Claude chat connected to this server can update a Project two ways, and the
words you use pick the lane:

- **"Queue a build on X" / "have the project build …"** →
  `send_project_build`: the project's own harness does the work on the API
  key configured in ProxyPilot (estimates, gates, change records — and API
  token spend).
- **"Edit the files directly" / "use the MCP file tools, don't queue a
  build"** → `read_project_file` → `write_project_file` →
  `redeploy_project`: the chat itself (your Claude subscription) does the
  thinking; ProxyPilot only reads/writes files and redeploys. No build
  tokens are spent, but there are also no harness gates — review the diffs
  the chat shows you before approving writes.

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

## Limitations / follow-ups

- Auth is token-based, not OAuth 2.1 with dynamic client registration.
  claude.ai connects fine via the tokenized URL; a full OAuth flow is a
  possible follow-up (see docs/known-issues.md).
- Upload tickets live in process memory — a backend restart between
  `create_upload_ticket` and the PUT invalidates the ticket (re-create it).

## Troubleshooting

- **"Couldn't register with ProxyPilot's sign-in service" on claude.ai** —
  fixed in 1.4.0: OAuth discovery probes (`/.well-known/oauth-*`) used to be
  answered by the SPA with a 200, which made claude.ai attempt OAuth client
  registration. They now 404 cleanly. Leave the OAuth Client ID/Secret fields
  empty — auth is the token in the connector URL.
- **Connector URL starts with `http://`** — fixed in 1.4.0 (the backend now
  honors the proxy's X-Forwarded-Proto). Re-copy the URL after updating, or
  just change the scheme to `https://` by hand.
