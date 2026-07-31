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
| Projects | `list_projects`, `get_project`, `send_project_build`, `upload_project_reference`, `clone_project` | `send_project_build` queues a quick update on the project's own AI harness. `clone_project` mirrors the UI's Clone (fresh / full-with-database). |
| Transfer | `create_upload_ticket` | Big zips: the tool returns a one-shot `upload_url`; `curl -T site.zip -H 'Content-Type: application/zip' <url>` pushes the bytes, then the ticket is referenced in an inspect tool. Zips ≤ 2 MB may ride inline as `zip_base64`. |

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
