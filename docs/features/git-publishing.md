# Publishing to an external git host (Gitea / GitHub)

Push ProxyPilot-managed content to a self-hosted Gitea (or GitHub) repository:
an AI-dev project's real git history, or a snapshot of a static site's docroot
or an LXC guest's application directory.

## Configuring the connection

**Projects → Connectors**, "Git connectors". A connector is:

| Field | Notes |
|---|---|
| Provider | `gitea`, `github`, `generic_https`, `generic_ssh` |
| Base URL | Required for Gitea — e.g. `https://git.example.com`. Plain `http://` is honoured as given for a LAN-only instance. |
| Auth | `token` (a Gitea access token) or `ssh_key` |
| Credential | Encrypted at rest with `TOTP_ENCRYPTION_KEY` (`lib/secrets.js`) |

"Test" validates the credential against the host's identity endpoint without
pushing anything.

**Token scopes on Gitea:** the token needs `write:repository`. Add
`write:organization` only if you want ProxyPilot to create missing repositories
under an organisation.

Connectors are deliberately **not** creatable over the MCP server. Creating one
takes an access token, and a token that passes through an agent's context has
been disclosed to everything able to read that context. `list_git_connectors`
returns metadata and never the credential.

## The three sources

### Projects — real history

A project already *is* a git repo, so publishing pushes its actual commits.

1. Bind it: `POST /api/mock2/projects/:id/remote` (or `set_project_remote`).
   `push_on_checkpoint` publishes automatically after every build checkpoint.
2. Publish on demand: `POST /api/mock2/projects/:id/remote/push`
   (or `push_project_to_git`). This works whether or not `push_on_checkpoint`
   is set — the flag only governs the automatic path.

### Static sites and LXC — snapshots

Neither is a git repo, so a publish is a **snapshot commit**:

1. Clone the remote (shallow, branch-scoped).
2. Replace the published subtree with the current source.
3. Commit the difference and push.

Consequences worth knowing:

- **History is preserved.** Each publish is an ordinary commit on top; you can
  diff and revert. It is never a force-push and never a fresh repo.
- **Deletions propagate.** A file removed from the source is removed in the
  commit — that is what makes the remote a faithful mirror.
- **No-op when unchanged.** If the remote already matches, nothing is committed.
- **`subdir` scopes the replacement.** Publishing into `sites/docs` leaves the
  rest of the repository untouched, so several sources can share one repo.

Endpoints: `POST /api/git-publish/static-sites/:id/publish` and
`POST /api/git-publish/lxc/:name/publish`. Both are admin + sudo.

## LXC scope

An LXC publish defaults to the container's **registered startup working
directory** — the application directory ProxyPilot already tracks. There is no
default that reads anything else.

Publishing another path needs `path` **and** `confirm_path: true`. That is not
ceremony: a container filesystem holds credentials, keys and system state, and a
publish is a one-way egress to an external host. Inspect the directory
(`list_lxc_files`) before confirming one.

The credential never enters the container. Files are copied out with
`incus exec … tar` and all git work happens host-side.

## Secret hygiene

Application directories routinely hold deployment secrets. Publishing is
**deny-by-default**: `.env`, `*.key`, `*.pem`, `id_rsa*`, `.ssh/**`, `.aws/**`,
`.netrc`, `.npmrc`, `.pgpass`, `credentials.json`, `service-account*.json`, plus
local state (`.git/**`, `node_modules/**`, `*.sqlite`). `.env.example` and its
siblings are templates and *do* publish. The full list is
`DEFAULT_EXCLUDES` in `lib/git-publish-logic.js`.

Every held-back path is named in the response — a silent exclusion would be its
own hazard, since an operator who believes a file shipped and one who believes it
did not both need to be right.

`include_secrets: true` disables the filter. It is off by default and recorded
in the audit entry when used.

**Always dry-run first.** `dry_run: true` reports exactly what would be sent and
what would be held back without contacting the remote.

## MCP tools

| Tool | Purpose |
|---|---|
| `list_git_connectors` | Configured connectors; never the token |
| `get_project_remote` / `set_project_remote` | Read / bind a project's remote |
| `push_project_to_git` | Push a project's history now |
| `push_static_site_to_git` | Snapshot a docroot into a repo |
| `push_lxc_to_git` | Snapshot a guest's app directory into a repo |

## Repository creation

If `remote_repo` is `owner/name` and does not exist, ProxyPilot creates it
**private** (Gitea and GitHub only). It tries the organisation endpoint first,
then the authenticated user's. A full `https://` URL is used as-is and never
checked. If creation fails, the push produces the real error.

## Audit

`MOCK2_PROJECT_REMOTE_SET`, `MOCK2_PROJECT_REMOTE_PUSH`,
`GIT_PUBLISH_STATIC_SITE`, `GIT_PUBLISH_LXC` — each records the connector,
repository, branch, file count and whether the secret filter was disabled.
