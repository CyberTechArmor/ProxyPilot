# Existing application releases

ProxyPilot can register a running LXC application, preserve its native Git
history, create review-branch commits, validate a sealed candidate, deploy that
candidate and merge its verified commit into a configured remote release branch.
Registration imports source; it does not install an application, rewrite a
systemd service, move live directories or publish a route.

The LXC dialog's **Releases** tab and the application-release MCP tools call the
same service. The HTTP API is `/api/application-releases`, behind the existing
session, administrator and fresh-auth checks. MCP retains its existing key scope,
confirmation and audit/ledger boundaries. No new credentials are created.

## Source and evidence

| Record | What it establishes |
|---|---|
| Source checkpoint | Full native Git commit and tree, preserved host-side; not a synthetic directory snapshot |
| Profile revision | Exact target, source path, service, scripts, health URL, preserved paths and remote configuration |
| Validation | The pinned candidate and profile passed their named validation scripts; artifact identity is sealed |
| Review publication | The requested review branch was read back independently; a successful push alone is insufficient |
| Live verification | Service, process working directory, release identity, artifact and loopback health match |
| Release merge | The exact verified candidate advanced the configured remote branch under an expected-head lease and was read back |

Changing a profile creates a new immutable revision. Prior evidence remains in
storage but does not authorize the new revision. A queue response means queued,
not tested or deployed. A passing validation is not product acceptance.

Native repository data lives under
`/var/lib/proxypilot/application-repositories/<id>/repo.git`. Imports preserve
guest branches and tags under `refs/guest`; they do not overwrite canonical main
on every checkpoint. Source commits are made in a temporary host worktree and
update the chosen review branch only against the expected parent. Credentials
stay on the host and are passed to Git for the individual operation; they do
not enter the guest bundle, repository remote configuration or returned logs.
Current application transport supports existing token connectors. Other auth
kinds return an explicit unsupported result.

Reachable history is checked for protected filenames, credential patterns and
bounded object/byte limits before source can be cleared for publication. This
is a concrete safety check, not a claim that arbitrary secrets can be detected.
Tracked guest changes must first be committed or preserved by the operator;
ProxyPilot does not silently discard them. A stopped repository operation can be
reconciled only with its exact token, a different/dead process identity, and an
idle host repository lock.

## Supported deployment profile

The first release supports an **existing Node/systemd application** with:

- A non-shallow native Git repository and an existing token Git connector.
- An existing exact `.service` unit and HTTP loopback readiness endpoint.
- Named `package.json` scripts for validation and optional dependency/build steps.
  At least one validation script is required. These are script names, not
  arbitrary shell command inputs. Their code is part of the reviewed candidate.
- A stable source path that is already a symlink into an explicit release root.
  The service must run from that stable path. A plain source directory can be
  registered and reviewed, but deployment refuses until the layout is adopted
  deliberately.
- Explicit shared data paths and environment-file references. Validation does
  not receive production data or environment files. Deployment links declared
  in-application paths after validation; external service references remain
  external.

The runner stages a Git bundle, executes the saved scripts, seals the release,
checks the artifact again, records the old target, switches the symlink and
restarts the existing service. It verifies the actual service process and health
before recording success. A failed activation attempts restoration and records
its outcome. Database migration rollback is not inferred from a source rollback;
an application needing such migrations needs its own reviewed rollout design.

Jobs live in the **core setup database** and use the existing guest lock,
fencing, checkpoints and runner lifecycle. The separate Mock2 database holds
profiles and repository evidence. An interrupted disruptive operation does not
silently replay the promotion: recovery uses its recorded targets and refuses an
unexpected live target. No Incus upgrade or general startup installer is invoked.

## MCP workflow

Start with `discover_capabilities({query: "existing application git release"})`.
It searches only the caller's permitted catalog and returns entry points and
optional schemas; it never expands a key's permissions or enables a flag.

1. `list_applications` / `register_application` / `get_application`.
2. `checkpoint_application` imports an already committed guest ref, or
   `inspect_application_source` reads the exact canonical candidate and
   `commit_application_changes` creates a real review-branch commit from a diff
   with an exact parent. A diff too large for one call (up to 1 MiB) is
   uploaded first with `create_upload_ticket` (then PUT, or
   `append_upload_chunk` + `finish_upload`) and passed as `ticket`, optionally
   with its `sha256`, so a whole change is one commit instead of many inline
   pieces. The ticket is single-use and is taken only when the commit is
   confirmed. `update_application_profile` saves deliberate changes with the
   expected revision.
3. `prepare_application_release`, then `validate_application_release` and poll
   `get_application_job`. Fix failed validation and create a new candidate.
4. Optionally `publish_application_release` to an explicit review branch and
   independently `verify_application_remote`.
5. `deploy_application_release`, poll the job, then
   `verify_application_release` when fresh live evidence is needed.
6. `merge_application_release` with the independently observed remote SHA.
   An absent remote branch must be supplied explicitly as `null`. A changed
   head or non-fast-forward ancestry refuses; unrelated histories are never
   resolved with an `ours` merge or force rewrite.

`rollback_application_release` selects a previously validated candidate.
`reconcile_application_operation` concerns repository operations, not permission
to discard a deployment job. Read the returned blocker and next action.

The existing `set_git_remote` / `push_git_remote` path still exports LXC/static
directories as snapshots. `get_git_remote` labels that mode;
`verify_git_remote` independently compares its configured remote against the
saved pushed commit. Neither implies native history preservation or deployment.

## ProxyPilot self-update

`prepare_self_from_git` stages a full reviewed SHA from the live checkout's
configured HTTPS origin. It preserves the previous candidate ref, checks a clean
base and invalidates old checks. `run_self_checks` and `promote_self` then use the
existing exact-build contract. The general maintenance updater is a different
path and should not be used for a code-only deployment with a no-Incus-upgrade
requirement.

When a patch-based bootstrap and a merged remote commit have different parents
but **identical entire Git trees**, preparation reports `same_tree_alignment`.
After checks on that exact remote SHA, `adopt_self_git_commit` can align only the
Git identity under a compare-and-swap, preserve a rollback ref, and request a
pinned rebuild. It refuses different source trees. It is not a general history
rewrite, a rebase or a way to bypass the normal promotion checks.

The dashboard image includes `py3-cryptography` and `poppler-utils`, which the
existing Python receipt and bounded PDF extraction checks require. Candidate
preparation repairs only these missing packages in the existing Alpine dashboard
container so the full required checks can run before rebuilding the new image.
It never pivots to the host or invokes a general package upgrade.

Clients may need to refresh their ProxyPilot tool catalog after deployment to
see new tools. The initialize instructions and `discover_capabilities` reduce
the need for an agent to remember a large catalog by name.

## Nodus follow-up outside this ProxyPilot release

The preserved Nodus roadmap and deployment facts remain the basis for its own
feature releases. This ProxyPilot change does not implement remember/correct,
memory architecture, Chat/Teams parity, MEET/TURN or upstream Mock2 changes.

Before adopting Nodus, reconcile its native Git history with the existing Gitea
directory-snapshot publication. Preserve both histories; do not use the old
`merge -s ours --allow-unrelated-histories` publishing shortcut. Declare Nodus's
real build/test commands, service, health endpoint, data and environment paths,
then prepare its source layout for versioned releases. This is an application
maintenance change, not something registration performs automatically. Copying
Nodus to another LXC is not required to fix Git ownership or publication.

The missing newer remember/correct source still needs recovery from an actual
backup/checkout or reimplementation against the roadmap. Source infrastructure
does not recreate missing feature code. Forget semantics remain a separate
product decision; this release establishes no suppression, deletion or retention
policy.
