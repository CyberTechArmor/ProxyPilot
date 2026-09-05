# Git remotes: submitting projects, static sites and LXC containers to Gitea

*2026-09-05.* ProxyPilot can push everything it hosts to a git remote on any
Gitea instance (or GitHub, or a generic HTTPS/SSH remote). The remote is always
optional: the local state (the project's bare repo, the site's docroot, the
container's app directory) stays primary.

## 1. The connection: git connectors

**Where:** Projects → Connectors → **Git connectors** tab (`/projects/connectors`,
admin only; the Projects module must be enabled).

A connector is a named credential for one host: provider (`gitea`, `github`,
`generic_https`, `generic_ssh`), **base URL** (required for Gitea, e.g.
`https://git.fractionate.ai`), auth kind (`token` or `ssh_key`) and the
credential. Tokens are encrypted at rest in `mock2.db` (`lib/secrets.js`), never
shown again, and never enter a container: every push runs host-side through
the pivot with the token injected into that one transport (ADR-006). **Test**
calls the host's identity endpoint (`/api/v1/user` on Gitea) and records the
verdict on the connector.

Any number of connectors can exist, so several Gitea instances (or a Gitea and
GitHub) can be targets at the same time.

## 2. Binding a remote to something

| Kind | Where in the UI | What is pushed | Table |
|---|---|---|---|
| AI-dev **project** | Project page → *Repository* card; or the **New project** dialog | the project's bare repo (`HEAD` → `main`) | `mock2_project_remotes` |
| **Static site** | Dashboard → site → *Settings* → *Git remote*; or the **Add New Service** dialog when kind = Static Site | a snapshot of the docroot | `mock2_target_remotes` (`kind = static_site`, target = service id) |
| **LXC container** | Containers → container → *Details* tab → *Git remote*; or the **Create LXC Container** dialog | a snapshot of a directory inside the guest (default: the registered startup working dir, e.g. `/opt/app`) | `mock2_target_remotes` (`kind = lxc`, target = container name) |

Each binding has:

- **Connector** and **repository** (`owner/name` on the connector's host, or a
  full URL).
- **Create the repository if missing** (default on): for Gitea and GitHub
  token connectors ProxyPilot looks the repo up and creates it (private) under
  the token's user or the named organisation, so "submit to Gitea" is one
  action. A repo that cannot be created is an error at save time, not a failed
  push later.
- **When to push**: *manual* (only on **Push now**) or *auto*. For projects,
  auto means after every checkpoint (the existing `push_on_checkpoint`). For
  static sites and containers, auto means after every content change ProxyPilot
  itself makes: file save, revert, zip apply, import (UI or MCP), file write into
  a guest, startup re-run. Bursts are debounced into one commit.
- **Push now** for all three kinds; the result and the last pushed commit are
  shown on the card and stored on the row (`last_push_at`, `last_push_error`,
  `last_pushed_commit`).

"Before and after the start": the remote can be set in the create dialog
(before any content exists; the first push happens when content lands or on
Push now) and at any later time from the object's page.

## 3. How the mirror works (static sites and containers)

A docroot or a guest directory is not a git repo, and must not become one (a
`.git` inside a served docroot would be served; a `.git` inside a guest would
mix the operator's files with ours). So each target owns a **bare mirror repo**
on the host under `MOCK2_DATA_DIR/git-mirrors/<kind>/<target>.git`. A push:

1. exports the content as a tar stream (`tar -C <docroot>` on the host, or
   `incus exec <guest> -- tar -C <dir>` for a container), excluding
   `node_modules`, `.git`, `dist`, `build`, caches, `.env*`, keys and the
   platform's own staging dirs;
2. extracts it into a fresh temporary work tree and commits into the mirror
   with a fresh index, so deletions are recorded too; an identical tree is
   reported as *already up to date* and nothing is pushed;
3. pushes the mirror's `HEAD` to `refs/heads/main` on the remote through the
   connector.

The docroot path is translated from the backend's view (`SERVICES_DATA_DIR`) to
the host's (`CADDY_STATIC_ROOT`) exactly as the Caddy renderer does. Nothing is
written into the docroot or the guest.

## 4. API and MCP

REST (admin, under `/api/mock2`):

```
GET/POST/DELETE /remotes/:kind/:target        kind = static_site | lxc
POST            /remotes/:kind/:target/push
GET/POST/DELETE /projects/:id/remote           (+ create_repo)
POST            /projects/:id/remote/push
POST            /projects                      body.remote = { git_connector_id, remote_repo, push_on_checkpoint, create_repo }
```

MCP tools: `list_git_connectors`, `set_git_remote` (kind, target, connector,
remote_repo, push_mode, source_dir, create_repo) and `push_git_remote`. The
server instructions point clients at them.

## 5. Boundaries kept

- The core (`routes/services.js`, `routes/lxc.js`) never imports the Projects
  module. It emits content-change events on `lib/change-events.js`; the module
  subscribes at enabled boot (`mock2/git-push-hooks.js`). With the module off
  nothing changes.
- Credentials never enter a container and never appear in status columns (git
  output is scrubbed of `https://token@`).
- The remote is a copy. Rollback, restore and the source of truth stay where
  they were.

## 6. Not done yet

- A **default** connector applied to every new object automatically. Today the
  operator ticks the option per object; a `mock2.default_git_connector`
  setting would make it opt-out instead.
- Pull from the remote (the mirror is one-way).
- Syncing the Mock2 standards themselves from Gitea into the framework seed
  (see `docs/mock2/standards-and-cpr.md` §4).
