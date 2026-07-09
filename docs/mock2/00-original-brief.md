# Mock2 Design Brief (verbatim)

> This is the operator's design brief, preserved verbatim as the requirements
> source. It was written **without** access to the ProxyPilot repo. Assertions
> in it about ProxyPilot's current state were verified during planning; the
> corrections live in `01-survey.md` and the deliberate deviations in
> `02-adrs.md`. When this brief and those documents disagree about what
> *exists*, the survey wins. When they disagree about what to *build*, the
> ADRs record the argument and the operator decides.

---

# ProxyPilot + Mock2 — Planning Session

## What I want from this session

Read the ProxyPilot codebase. Then produce an implementation plan for adding Mock2 as a module inside it. **Do not write application code in this session.** I want a plan I can execute across many subsequent build cycles.

Where this document asserts something about ProxyPilot's current state, verify it against the code rather than trusting me. Where the design below conflicts with what already exists, say so — the existing code usually wins, and I want to know before I commit to a plan.

---

## Background

**ProxyPilot** is a compliance-first control plane: reverse proxy management, LXC container lifecycle, domain routing, TLS, host hardening, secrets, observability. It targets HIPAA and SOC 2 Type 2. Its production deployment model is pull-based — agents on production servers pull from git; nothing pushes into them.

**Mock2** is a four-stage spec-driven AI development framework (Concept → Define → Build → Run). It lets a domain expert with no coding ability produce production software. It works by fixing the standards — TypeScript, Express, Drizzle, Zod, PostgreSQL, Vitest, API-driven structure — so the only thing under discussion is the domain. It has two human sign-offs (design approval, rules confirmation) that gate all code. Its durable state is files in the repo: `state/inventory.json`, `state/rules.md`, the work file, and append-only change records.

**What we are building:** a Mock2 module inside ProxyPilot. A non-technical user describes an application in chat, approves an HTML mockup, answers whatever domain questions the framework can't answer on its own, and gets a working application running in its own LXC container behind its own URL. They then iterate through the same chat. The code lands in a git repo. Production is a *different* ProxyPilot host that pulls that repo. The Mock2 module is a development tool and never runs in production.

---

## Architecture — the load-bearing decisions

### Trust boundary

Git is the seam between dev and production. The Mock2 module pushes; production ProxyPilot pulls. Nothing else crosses.

Inside the dev plane, the orchestrator holds an exec handle into each project's LXC container and writes files directly — like Claude Code over SSH. This is a deliberate inversion of ProxyPilot's production posture and it is why the module must not exist on production hosts.

### The Mock2 module is absent-by-installation on production hosts

Not a database flag. Not a toggle in the admin UI. On a host where Mock2 is disabled:

- The agent binary is not installed
- The LXC exec socket is not mounted into the orchestrator
- No model API key store exists
- Mock2 routes are not registered

Enabling requires an environment variable **and** the presence of credentials. The installer asks on fresh install. Updates re-ask only if currently disabled, and **non-interactive upgrades always preserve the existing answer** — never default to enabled, never block on input. Production installs need a pin file that makes disabled permanent and suppresses the prompt entirely.

The compliance claim we want to be able to make is "the module is absent by installation," not "there is a toggle and it is off."

### Four planes

1. **Orchestrator** — the ProxyPilot web app. Project registry, chat, job queue, stage state machine, checkout locks, audit queue, framework registry.
2. **Project container** — one persistent unprivileged LXC per project. Holds the working tree, the dev server, the project database, and the agent's shell. Destroyed on archive.
3. **Routing** — existing ProxyPilot. Wildcard subdomain per project.
4. **Git** — a local bare repo per project on the ProxyPilot host, always. Remotes are optional.

### Network isolation is what makes the unconstrained agent safe

The agent runs with no authorization prompts inside the container. That is fine *for the container*. It is not fine for the host. What actually bounds the blast radius:

- One bridge or VLAN per project
- No route from a project bridge to the control plane, its database, or any other project bridge
- Egress allowlist per project: package registries, the project's git remote, the configured model APIs. Nothing else.
- Shared Postgres cluster, but: control-plane database on a separate cluster or a network project bridges cannot reach; per-project role with rights only on its own database, no `CREATEDB`, no `CREATEROLE`; connections via PgBouncer with per-project credentials; `pg_hba` scoped by source.

A model that decides to reach elsewhere should find nothing to reach. Enforce this in the network, not in the prompt.

### Credentials never live in the project container

The agent commits to the local repo inside the container. The orchestrator fetches from it and does any push to an external remote. If the agent must push directly, mint a per-repo, write-only, short-TTL token per operation.

An account-scoped GitHub token reachable from a container running LLM-authored code is one bad build away from writing to every repo on the account.

### Secrets

The repo is the thing that survives. It never contains secrets. `.env` is gitignored; what is committed is a manifest of required keys with no values. Production ProxyPilot injects from Infisical at pull time.

Project secrets live in the project container, visible and editable by editors, not viewers. Policy: production credentials never enter a dev container. Sandbox EHR keys only.

---

## Routing and preview

Superadmin registers **parent domains** (`dev.example.com`), each with a wildcard cert and wildcard DNS. Registration verifies both before the domain becomes selectable.

At project creation the editor picks a parent domain. The system mints a **random slug** — `p-7f3a9c2e`, never derived from the project name. Store `parent_domain_id` and `slug`; derive the FQDN, don't store it.

**Rotate** issues a new slug, registers the new route, keeps the old alive for a one-hour grace window, then drops it. Old slugs go on a never-reuse list. Editors can rotate. Logged.

**Custom domains** are the alternative: editor supplies a hostname, system emits the DNS challenge, verifies, provisions the cert, no slug. Admin-gated.

Constraints: slug unique per parent domain, not globally. Reserved prefixes blocked (`www`, `api`, `admin`, `auth`). `robots.txt` deny and `X-Robots-Tag: noindex` on every dev route. **The forward-auth hook sits in every dev route config from day one, set to off** — gating previews to project members is a later iteration and must be a config flip, not new plumbing.

`ip:port` appears only in the admin project detail as a debug view. **No host port allocation anywhere in the system.**

### Port exposure is declared, not discovered

The Mock2 standard requires each project to declare its topology: `web: 3000` exposed; `postgres: 5432`, `valkey: 6379` internal. ProxyPilot reads the manifest, registers exactly one route, and default-denies the rest at the bridge.

Scanning is verification, not discovery: scan, diff against the manifest, raise `drift` to the admin queue. Default-allow-what-I-found is not safe when the code was written by a model from a non-technical description.

---

## Identity, roles, access

### Two-step authentication

LDAPS proves employment. Postgres grants access. A directory user who has never been approved can sign in and do nothing but request access.

- Scheduled directory reconcile auto-deactivates users disabled in AD. Without it, a terminated employee keeps a live session.
- Deactivation in Postgres revokes live sessions immediately — server-side sessions, or short-lived tokens with a revocation check.
- **At least one local superadmin does not depend on LDAP.** An LDAPS outage must not lock you out of the system that fixes LDAPS.

### Roles

| Role | Scope |
|---|---|
| Superadmin | Everything. Cannot be removed or blocked by an admin. Edits the framework. |
| Admin | Everything except acting against the superadmin. Archives projects. Answers framework deviations. |
| Editor | Full access within assigned projects. Invites editors and viewers. Answers domain questions. |
| Viewer | Reads chat and changelog, opens preview, can raise a flag. Never takes the checkout lock. |

Projects are independent of their creator. If a project has no editor it is flagged `orphaned` for an admin to assign one. Admins and superadmins have full access to all projects. An admin chatting inside another user's project is logged as such, in the transcript **and** in the change record the project's editors read.

### Archive

One destructive operation: **Archive.** Checkpoint, commit, destroy the container, keep the repo. The project reappears in a filtered list and rehydrates from git.

Because rehydrate-from-repo is the only recovery path, **build and test it early.** If it ever depends on a ZFS snapshot, archive is silently lossy and you will find out on a project someone cares about.

Note for the plan: nothing is ever deleted. Retention and purge are deferred, but flag it as an open policy item rather than an oversight.

---

## The checkout lock

One container, one writer.

- The lock is held by *whatever* is writing. An autonomous build cycle holds it exactly as a human does.
- Idle timer is 15 minutes by default, admin-configurable, and starts from the **last write**, not from build completion.
- **Auto-release checkpoints first.** Commit, then release. An auto-release that discards uncommitted work is a data-loss bug wearing a feature's clothes.
- Warn the holder before releasing; give them a keep-working button.
- Waiters see who holds it and how long remains, and can request takeover, which pings the holder.
- Admins can force-release. Logged.
- Viewers never take the lock.

This is a lock on the *container*, not the repo. If branch-per-user or parallel preview environments are ever added, this design must be revisited. Write that assumption down in an ADR.

---

## Stages and the audit

### Flow

**Concept.** Chat produces an HTML mockup, constrained to the framework's locked design system so the mockup is a spec rather than a suggestion. The only exit is the design approval gesture, which writes `state/inventory.json`. In this stage the model cannot write backend code and cannot touch rules.

**Audit** runs when the user presses Build. It compares the approved mockup and inventory against the framework and the project's existing rules, and produces a list of unanswered questions. Two kinds, routed differently:

- **Domain questions** — *can a scheduler see another practice's shifts? who approves a shift swap? what happens to an assignment when a provider is deactivated mid-week?* These go **to the editor**, in plain language, as tappable choices. No framework will ever contain these; they are the reason the domain expert exists. Their answers write to that project's `state/rules.md`. **This is Stage 2 — triggered lazily, so the user only answers what is actually ambiguous.** The answers are the rules-confirmation sign-off.
- **Framework deviations** — *this project needs MySQL. Skip auth on this endpoint. Expose this port without TLS.* These go **to the admin queue**.

If the audit produces no questions, the build starts immediately.

**A project's answer never edits the framework.** Domain answers write to that project's `rules.md`. If the audit reveals a genuine standards gap, that opens a separate, deliberate framework change — reviewed, versioned, released. Otherwise Mock2 becomes a junk drawer of one-off decisions from whichever project hit the gap first.

**Build.** The agent execs into the project container, makes targeted incremental changes, runs the gate battery, remediates, and commits. What the user sees is the stage, the current gate, and gates going green — not a token stream and not a diff. A checkpoint commit lands after each targeted change and after each green gate run.

### The rule-change classifier

Every iteration message is classified before anything runs. **Three outcomes, not two:**

1. **Implements within confirmed rules** → build, no interruption.
2. **Contradicts or amends a confirmed rule** → back to the editor to reconfirm. It is their rule; an admin cannot authorize a change to a domain rule they do not understand.
3. **Unaddressed by the rules** → new rule question to the editor, same lazy-interview mechanism, then build.

Outcome 3 is the one that matters. *"Schedulers should see other practices' shifts"* usually doesn't **break** a rule — it occupies space the rules never addressed. Nothing breaks, so it builds, and now the system does something nobody confirmed, and every gate derived from the rules is validating a system that no longer exists. Quietly. Around month three.

Bias the classifier toward flagging. A false positive costs one tap. A false negative costs the framework.

Framework deviations still route to admins. **Editors own project rules; admins own framework deviations.** Protect that split.

### Interrupt semantics

A message arriving mid-cycle offers: *queue after current step*, *stop after current step (work is saved)*, *abandon cycle (uncommitted work is discarded)*. Admin `stop all` destroys runners and resets branches to their last checkpoint. These options only mean anything because of the checkpoint discipline above.

### Failure escalation

Terminal access is admin-only. When a cycle exhausts its retries the project transitions to `awaiting admin` **automatically** — this is not the same thing as the manual flag button, and without it a non-technical user sits in a failed build wondering whether to press it. The user sees plain language and a handoff button that gives an admin the container, the branch, and the log.

Gate failures are shown as reviews, not errors: *"the security check found the patient list can be reached without a login. I fixed it — here's what changed."* That is both the usable framing and the honest description.

---

## The framework registry

Mock2 lives in Postgres as a **versioned bundle**: the constitution prose, the four skills, and the gate scripts, under one monotonic version number. A prose change and a gate change that disagree is a failure mode; one version across the bundle prevents it.

- Editable in-app as markdown. Diff shown before commit. **Superadmin only** — it is a global action affecting every project's next cycle. Appears in the admin activity log.
- Revert creates a **new version restoring old content.** Versions are never hard-deleted; change records point at immutable version IDs.
- Optionally synced from a git repo. Postgres remains the source of truth for what a cycle actually ran.

### Versioning semantics

- The **project floats.** It always picks up the current framework on its next cycle. Never pinned.
- The **cycle pins.** At cycle start the orchestrator snapshots the current version and uses it for the entire cycle; the change record stamps it, immutably. A framework edit landing mid-cycle must not change the standard underneath a build that is three targeted changes deep.
- `framework_version_initial` is a point-in-time reference, not a pin.

### Drift

The audit **detects** drift every cycle: *"this project predates the current standard in 3 ways."* It never silently remediates. A project born under 1.2 with the framework now at 1.5 must not have its auth layer rewritten inside a request to move a button.

Remediation is an **explicit, consented cycle** with its own change record reading `Mock2 1.2 → 1.5` and a full gate battery. Users see "an update is available" and choose. Never auto-upgrade a running project.

---

## Models, quotas, connectors

### Model connectors

Add a key. Superadmin defines which models are available. **Slots are per-stage and per-capability, not one global default** — Ollama and DeepSeek can summarize a chat; they will not reliably drive an agentic build loop with tool use and gate remediation. Be honest in the UI about which models can occupy which slot.

Claude API, OpenAI, Gemini, and self-hosted (Ollama, DeepSeek weights) are all in scope as connector types.

### Quotas — a reservation model

The 15% buffer implies reservation whether or not we call it that:

- Estimate the cycle's cost before it starts.
- **Refuse to start** if the projection exceeds remaining-minus-buffer. Never begin work you cannot finish.
- If the buffer is crossed mid-cycle: finish the current targeted change, checkpoint, stop, and say so plainly.
- Maintain a per-model pricing table.
- Self-hosted models cost zero dollars and still need a cap. Use wall-clock or concurrent-request limits — GPU contention is the actual scarce resource.

### Git connectors

GitHub, Gitea, and others via OAuth or API token. One repo per project, created at project creation.

**The local bare repo on the ProxyPilot host is primary, always.** External remotes are optional. The "Postgres only, export zips" option is then not a separate code path — it is the same repo with no remote configured, and the zip is `git archive`. One state model, one recovery story, and Mock2's state files cannot diverge between modes.

### Container lifecycle

Token quotas bound model spend, not host resources. Fifty projects means fifty containers holding RAM and ZFS whether or not anyone is chatting.

- Stop after N days idle. Dataset retained; restart is seconds.
- Archive on request: container destroyed, repo retained.
- Rehydrate from repo.

---

## The interface

Projects render as tiles, consistent with ProxyPilot's existing LXC tile pattern. A tile opens to a project detail containing: description, chat, a design section holding UI/UX requirements that override the framework's defaults when present, the changelog, the adaptive summary, and the preview link (opens in a new tab, so chat and preview can sit side by side).

**Stage and progress are always visible, subtly, in view.**

### Adaptive summary

Derived from **change records and `rules.md`** — never from the chat transcript, or it drifts into narrating conversation instead of describing the system. Trigger deterministically: any cycle touching `rules.md`, `inventory.json`, or adding or removing a screen or action. Then let the model write the prose. Versioned so it can be diffed.

### Change records

Always-on, append-only, ideally hash-chained. Every record carries: who initiated, whether they were an admin acting inside someone else's project, the framework version the cycle ran under, the rules touched, and the gates run.

### The admin's view

**The admin's real object is a queue of items, not a list of projects.** One project can simultaneously have a framework-deviation request and a drift alert; a project list flattens that. Build the item queue; let it filter by project.

Statuses are **derived, never hand-set**, with the manual flag as the one overlay:

`provisioning` · `idle` · `online` · `checked out` (by whom, time remaining) · `building` (stage, current gate) · `awaiting user` (rules question pending) · `awaiting admin` (framework deviation, or retries exhausted) · `failed` · `orphaned` · `quota exhausted` · `drift` · `archived`

**Flag an Admin** is a manual button available to editors and viewers — "I'm stuck," or "the preview looks broken." It raises an `!` on the tile and an item in the queue. It is not the only path into that queue; retry exhaustion gets there on its own.

---

## Explicitly deferred

Do not build these. Do not design around their absence in ways that make them expensive later.

- **Gated previews.** Preview URLs are reachable by anyone with the link. The forward-auth hook is present and off.
- **PHI handling, retention, and purge.** The position is that self-hosting plus a BAA with the model provider addresses it. Access control on previews and a retention schedule are a later iteration.
- **The iframe preview.** New tab only for now.
- **Branch-per-user and parallel preview environments.** The checkout lock assumes one container, one writer.

---

## What to produce

1. **A survey of what already exists.** Which of this is served by current ProxyPilot subsystems — LXC lifecycle, routing, cert management, secrets, auth, observability — and which is new. Be specific about the seams.
2. **ADRs for the contested decisions.** At minimum: the dev/prod inversion of the trust boundary and how absence-by-installation is enforced; the audit routing split; the cycle-pins-version model; the container-scoped checkout lock and what it forecloses; the declared port manifest; the local-bare-repo-as-primary decision.
3. **A data model.** Projects, memberships, parent domains, slugs and slug history, chats, cycles, change records, framework versions, audit items, quotas, locks, model connectors, git connectors.
4. **A phased implementation plan**, ordered so each phase is independently testable and useful. My instinct for the first phases:
   - Project registry, container provisioning, bare repo, parent domain and slug routing, live URL — with no AI at all.
   - Rehydrate-from-repo, proven.
   - Cycle runner: agent exec into the container, targeted change, gate battery, checkpoint commit.
   - Stage 1 chat and mockup, design approval writing `inventory.json`.
   - Audit, with domain questions to the editor and deviations to the admin queue.
   - Iteration with the rule-change classifier.

   Argue with that ordering if the codebase suggests better.
5. **Risks and unknowns**, especially anything in this document that the existing architecture makes harder than I've assumed.

Ask me anything that is ambiguous before you begin planning.
