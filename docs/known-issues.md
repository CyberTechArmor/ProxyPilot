# Known issues

A grab-bag of operator-facing follow-ups uncovered during feature
work but parked because they fall outside the active session's
scope. Anyone picking up a future session should treat this file
as a punch list, not a roadmap — items here are meant to be
addressed individually, not bundled.

## Backend test runner: 6 test files fail under `node --test` in a
fresh sandbox

Discovered during the WireGuard MTU = 1280 session
(`docs/core/plan/NEXT-SESSION-PROMPT-wireguard-mtu.md`); count
re-verified 2026-07 (grew from 3 to 6 as tests were added).

Affected files (all `ERR_MODULE_NOT_FOUND` — packages absent from
the sandbox, never logic failures):

- `admin/backend/src/__tests__/cve-research.test.js` — imports real `db.js` → `better-sqlite3`
- `admin/backend/src/__tests__/cves.test.js` — imports real `db.js` → `better-sqlite3`
- `admin/backend/src/__tests__/incus.test.js` — imports real `db.js` → `better-sqlite3`
- `admin/backend/src/__tests__/webauthn.test.js` — imports real `db.js` → `better-sqlite3`
- `admin/backend/src/__tests__/vpn-mtu.test.js` — imports `cli/src/db/index.js` → `better-sqlite3`
- `admin/backend/src/__tests__/ldap.test.js` — imports `src/lib/ldap.js` → `ldapts`

Other backend tests stub the DB at the module boundary and pass
cleanly.

Pre-existing — these fail on `main` too. The rest of the suite
passes (943 pass / 954 as of 2026-07).

Possible fixes (pick one — they're not all equivalent):

1. Provide a dev-only stub for `better-sqlite3` that backs onto an
   in-memory pure-JS SQLite (`sql.js`) so the tests don't need the
   native module at all. Cleanest for CI; keeps prod path
   untouched.
2. Refactor the three failing tests to import their unit-under-test
   without dragging in `db.js` (e.g. inject a fake DB at
   construction). Most invasive but most "correct".
3. Make `node_modules` part of CI image setup (i.e. `npm ci` runs
   before `node --test`) so `better-sqlite3` is always present.
   Easiest if CI is the only place these run; doesn't help local
   sandbox runs.

Verifying the fix: in a fresh checkout, run

```
cd admin/backend
node --test 'src/__tests__/*.test.js'
```

and confirm `pass 76 / fail 0`.

## Self-update: operator proof U.V1–U.V6 not yet run on a VM

Added 2026-09-05 with the self-update feature (`docs/features/self-update.md`).
The runner contract, the agent methods, the backend logic/driver and the MCP
tools are covered by machine checks that run in the sandbox
(`self-update-runner.test.js` drives the real `scripts/update-runner.sh`
against a fake `update.sh`; `cmd/agent/methods/update_test.go` covers the
agent). What the sandbox cannot do is the end-to-end proof on a real host:
systemd path-unit triggering, `update.sh --yes` through a real
`docker compose` rebuild, the dashboard reconnecting on the new build, and
the MCP status tool polled through the restart. The six scenarios are
tabled at the end of `docs/features/self-update.md`; run them on a
disposable VM and record the results there. Until then, treat "Update now"
as verified by construction, not by observation.

The repo's GitHub releases are stale and mis-numbered: the latest is
`v1.21.0` (2025-12-29, evidently meant to be v1.2.1, on a commit that is not
on `main`) while the code's version is 1.4.0. The dashboard no longer
believes the tag (the commit sha decides, see the feature doc), but the
release list itself is wrong until someone with release permissions deletes
or renames `v1.21.0` (and its tag) or publishes a `v1.4.0` release at
`main`. The "View release notes" link points at that stale release until then.

Also fixed in passing: `Profile.jsx` called `api.checkForUpdates`,
`api.updateGithubRepo` and `api.resetDismissUpdate`, none of which existed
in `lib/api.js` — the old update badge could never render, and saving the
GitHub repo from the profile page threw. All three exist now.

## Smoke UI checks fail (rather than skip) on an app with no first administrator

**Half closed** (fix 1 below is done; fix 2 is not needed for the declared-user
half and is still open for the create-administrator-form half).

The smoke gate now seeds the fixture users a project's `ui-checks.json`
declares, immediately before it runs the checks
(`ensureScreenAccounts`, `smoke.js` → `driveBrowserConnector`), and the
operator can create the same set on demand from **App access → Screen
accounts**. Only the reserved `@fixture.invalid` domain is minted; a spec
naming a real address is skipped and reported, because that account is the
operator's and would consume their first-admin slot.

What remains: on an app with no first administrator, `/login` still shows the
create-administrator form and hides the sign-in form, so a baseline check
asserting a sign-in selector still times out rather than reporting "not yet
possible". Fix 2 below is the remedy for that half.

The original diagnosis follows.

Observed on project 46 build 129: 5 of 7 checks reported
`locator.waitFor: Timeout 5000ms exceeded`, including the platform's own
`platform-baseline-signin-legal`.

Not a build defect. The first administrator belongs to the operator and the
build is forbidden to create it, so a freshly built app is legitimately in
first-run state — and in that state:

- `/login` shows the create-administrator form and HIDES the sign-in form, so
  `expect_visible #login-password` (or any sign-in selector) times out;
- every check declaring `login: <someone>@fixture.invalid` fails, because the
  build writes those credentials into `state/ui-checks.json` and nothing
  creates the account. The platform seeds a fixture admin for the design
  REVIEW (`review-account.js`), never for the smoke.

So the checks are not failing — they are not yet possible, and the report
cannot tell those apart. An operator reads "5 of 7 failed" on a build that did
nothing wrong.

Two fixes, either of which closes it:

1. Have the smoke seed the fixture users a project's `ui-checks.json`
   declares, the way `ensureReviewAccount` already does for the review. Same
   reserved `@fixture.invalid` domain, same exclusion from "a real user
   exists", so it cannot consume the operator's bootstrap.
2. Detect first-run state (`GET /api/auth/bootstrap/status` →
   `canCreateSuperadmin: true`) and report "no first administrator yet — N
   session checks could not run" instead of N failures.

(1) is the better outcome — the checks actually run — and is the one to do
unless it turns out a project's declared users need roles the platform cannot
safely mint.

(1) is now done; see the note at the top of this section. A declared user's
ROLE is honoured where the project has one by that name, and anything that is
not clearly an admin role falls back to the LEAST privileged role in the table
rather than the first — a viewer fixture that quietly became an admin would
make every permission check pass and prove nothing.

## Frontend has no linter — a use-before-declare shipped a blank page

2026-07-30 (LEARNINGS row 144): a derived const in `BuildChat.jsx` read a
state variable declared ~350 lines later. Vite compiled it clean (builds
don't evaluate component bodies) and the temporal-dead-zone ReferenceError
only fired at render — blanking the entire dashboard until the hotfix.

Follow-up: add ESLint to `admin/frontend` (flat config; at minimum
`no-use-before-define` with `variables: true` plus `eslint-plugin-react-hooks`)
and run it next to `npm run build` in the pre-push checklist. Expect a
first-run cleanup pass: the rule is reference-order-based and will flag some
benign callback-ordering patterns that need either reordering or targeted
disables.

## Two mock2 gate-script tests flake under full-suite parallelism

2026-08-03, noticed while fixing the project-55 build blockers. Both pass
reliably in isolation and fail intermittently under `npm test`:

- `mock2-ui-checks.test.js` — "the ui-interaction gate hands over a template
  that is valid JSON, passes itself, and parses" (and, less often, its
  neighbour "P47 shape: sw.js + build-id are infrastructure")
- `mock2-scaffold-push.test.js` — "the generated push.ts encrypts what a
  browser can decrypt, and signs a valid VAPID JWT"

Verified pre-existing: on an unmodified checkout the ui-checks one failed in
2 of 3 consecutive full-suite runs, so it is not a regression from any
particular change. Both shell out (`git init`, `sh`, `execFileSync`) into
`mkdtemp` directories while the rest of the suite runs concurrently, which is
the likely cause — a timing/resource-contention flake, not a logic failure.

Do not "fix" the gate scripts over this. The fix belongs in the tests: give
each its own serialised context (`test('…', { concurrency: 1 })` or a
per-file `--test-concurrency=1`), or drop the subprocess where a pure
assertion would do. Until then, re-run a single failing file in isolation
before believing it.

## Mock2 standards are vendored, not linked

2026-09-05: the framework seed (`admin/backend/src/mock2/framework-seed/`) was
brought up to the Mock2 standards site v0.2.0/0.3.0 and CPR v1.1 by hand. There is
no sync from git.fractionate.ai/mock2/mock2-core; a site change reaches projects
only when someone updates the seed and the backend boots. The design for a live
link (settings key, boot/timer sync into `insertFrameworkVersion`) is in
`docs/mock2/standards-and-cpr.md` §4. Pushing projects, static sites and LXC
containers TO Gitea exists (`docs/features/git-remotes.md`); a default connector
applied to every new object is the remaining piece.

## Storage (ZFS): verified on loop devices in CI, not yet on real hardware

`docs/features/storage.md`. The unit tests and the loop-device integration
test (`storage-loop.integration.test.js`, run by
`.github/workflows/storage-integration.yml` as root on ubuntu-latest with
`zfsutils-linux` + `sanoid`) cover create / snapshot / rollback / policy /
syncoid replication to a second pool / destroy-with-stream / scrub /
export-import / replace-resilver. Not yet exercised on a real host:

- **`smartctl` through the nsenter path** on real SATA/NVMe devices (the
  parser is tested on captured output; the agent reports `permission_denied`
  and the backend fills it in as root).
- **The Incus half**: `set_incus_storage_pool`, `move_guest_storage`,
  `restore_guest_from_snapshot` (the `proxypilot-storage-restore-guest`
  helper builds an Incus backup tarball from a ZFS clone — the
  `backup/index.yaml` layout follows `incus export`; verify `incus import`
  accepts it on the installed Incus version before relying on it),
  `rollback_guest_dataset`. CI has no Incus.
- **Remote (SSH) replication** end to end; the wrapper and the config file
  are tested locally only.
- **`zpool status -j --json-int`** on OpenZFS ≥ 2.3 (the JSON normaliser is
  tested on a synthetic document; the text parser is the primary path).
- **The alert fan-out** to real webhook / SMTP channels (unit: the alert set
  and its keys).

Operator steps that remain by hand: `sudo bash scripts/install-storage.sh`
(packages, units, helpers, sanoid seed), the SSH key for remote replication,
and `zfs allow` / sudo on the replication target.

## Extended MCP surface: what is verified by construction only

2026-09-19: the 133-tool extended surface (`docs/features/mcp.md` § "The
extended surface") is unit-tested against a fake ctx (catalog ↔ handler
coverage, the gates, the ledger, scopes, the renderer, the validators) but the
sandbox cannot prove the host-side halves. Parked follow-ups:

- **Self-editing end to end** on a real host: candidate clone under
  `/var/lib/proxypilot/self`, `run_self_checks` on the container's node
  (needs `npm ci` to work inside the dashboard image), `promote_self` →
  runner rebuild → `rollback_self`. Run it on a disposable VM first.
- `set_route_options.rate_limit` needs the caddy-ratelimit module; the tool
  probes `caddy list-modules` and refuses with the install hint otherwise.
  Basic auth renders the Caddy 2.8 `basic_auth` directive (older Caddy
  spells it `basicauth`; adapt fails and the change rolls back).
- `pull_git_remote` supports token connectors only; ssh-key connectors are
  refused by name.
- `list_dns_records` / `set_dns_record` are Cloudflare-only (the DNS-01
  token). No other DNS provider is integrated.
- `run_lynis` / `run_trivy` need the binaries on the host; `list_host_snapshots`
  / `create_host_snapshot` need btrfs or zfs and say so otherwise.
- `restore_proxypilot_db` replaces table contents in the LIVE SQLite database
  inside one transaction; sessions and in-memory caches may be stale
  afterwards (sign in again). It has not been exercised against a database
  whose schema differs from the backup's beyond added columns.
- `service_control`'s `enable` / `disable` and `install_package` are not
  recorded in the guest's startup script; a guest rebuilt from its startup
  script loses them.

## The MCP chat lane does not carry the framework content

2026-09-05: builds started from the UI are prompted with the pinned framework
version; an MCP client on the operator's subscription is not. It gets the
STANDARDS pointer in the server instructions and the per-repo `CLAUDE.md` /
`state/*` files the scaffold now seeds, nothing more. Follow-up: an MCP resource
or `get_standards` tool served from `getCurrentFrameworkVersion()` — see
`docs/mock2/standards-and-cpr.md` §5.

## `npm audit` findings no longer red the security-scan check

2026-09-05, by design (mock2-core v0.2.0 `check:audit`; CPR §10.2): a high or
critical advisory is printed as `security-scan: WARNING …` and the item passes;
a committed secret still fails the check. Operators reading a battery report
should look for the WARNING line, not only the colour. If a project needs the
audit to block promotion, that is a per-project decision recorded in
`state/decisions.md`, not a seed change.


## `mock2-ui-checks.test.js` — the ui-interaction gate test is flaky under the full suite

`the ui-interaction gate hands over a template that is valid JSON, passes
itself, and parses` passes on its own and fails intermittently under
`npm test` (roughly two runs in three), with the gate reporting *"no
user-facing screen files in this change … skipped"* for a temp repo that
plainly has one. Cause: the gate script in
`src/mock2/framework-seed/gates.json` writes its changed-file list to the
fixed path `/tmp/ui-gate-changed.txt`, so two gate runs on one machine —
which the suite does, in parallel, each in its own temp repo — clobber each
other's list. The fix is a per-run path (`mktemp`), but the script lives in
the framework seed, and editing the seed publishes a new framework version on
the next boot (see `docs/mock2/standards-and-cpr.md`), so it belongs in a
change of its own rather than riding along with unrelated work. Pre-existing;
not caused by the storage feature.

## The migration inventory's size concern overstates on a container source

`manifestConcerns` warns when a mount holds a lot ("/ holds 420 GiB — the
transfer will take a while and the guest's disk must be at least that big").
Inside a container, `df` and `findmnt` report the HOST filesystem the guest
lives on, so the number is the host's usage, not the container's — on the
throwaway `pp-mig-src-lxc` (a ~1.3 GB guest) it read 420 GiB.

It is a `warn`, never blocking, and on a physical or VM source it is correct
and worth saying. Fixing it properly means asking the guest what its own
subtree costs (`du -xs /`, which is slow on a large rootfs) or reading the
storage quota, and choosing between them per source kind — a change of its
own. Until then, read that concern as "the filesystem / lives on", and judge a
container source's real size from the transfer itself, which reports actual
bytes.

## `reset.sh` deletes the legacy database path, and deletes it at all — RESOLVED 2026-09

`reset.sh` ("reset password / TOTP / full reset") used to clear
`ADMIN_PASSWORD` in `.env` and then `rm -f` `data/proxypilot.db` so the
first-boot setup flow re-triggered. Two problems. The database moved to
`data/db/proxypilot.db` (update.sh migrates the legacy layout), so on a
current install the delete was a no-op and the restart alone did not re-open
setup — the reset did not reset. And where the path still matched, the
recovery tool wiped every service, route, user and audit row to reset one
password. Found during the 2026-09 platform-architecture review.

Resolved by the non-destructive root recovery command
(`docs/features/root-recovery.md`): `sudo proxypilot recover admin <name>
--password [--totp …]` edits the one named local administrator in the live
users table, revokes that account's sessions, elevation grants and trusted
devices, records an audit event without secret material, takes a `VACUUM
INTO` copy first, and leaves every other account, all data, the `.env` and
its keys alone. `reset.sh` keeps its commands and delegates to it; it no
longer deletes or rewrites anything. Still open: the host acceptance run
recorded at the end of the feature doc.

## The sudo window is still four sliding hours

The 2026-09 immediate repairs removed the elevation a passkey login used to
grant as a side effect and cleared every open window once (migration 605),
so elevation now comes only from an explicit re-proof. The window itself
(`SUDO_GRANT_HOURS`, default 4, re-armed on every gated call in
`middleware/auth.js` `requireSudo`) is unchanged: it was an explicit operator
request ("looser, sliding 4h"). The architecture review proposes five minutes
plus per-operation confirmation for the most sensitive actions. That is a
policy decision for the operator, not a repair; when it is made, change both
the grant and the slide (they read the same variable) and consider a hard
cap measured from the original grant so re-arming cannot extend it forever.

## Delegated-editing keys are not owner-checked per call

`lib/editor-keys.js` (the `/api/mcp-editor` restricted sibling) stores
`created_by` on each key like `mcp_tokens` does, but its lookup checks only
the hash, the revocation timestamp and the container's activation switch.
The 2026-09 owner-validity rule (refuse a token whose minting admin is gone
or disabled; revoke on disable/delete) was applied to the MCP surface only.
Those keys are pinned to one container's docroot and the activation toggle
suspends all of them at once, so the exposure is small; apply the same rule
there in a change of its own.

## Existing generated apps cannot receive updated component code

`installOne` keeps every path that already exists in a project ("a re-install
never wipes adapted files"), so publishing a new version of a seed component
reaches new projects only. The 2026-09 immediate repairs needed this to be
otherwise: the auth component learned to migrate an LDAPS secret stored under
its development master secret, but an existing app keeps its old
`src/auth/*.ts`, so the platform now DEFERS minting `AUTH_MASTER_SECRET` for
such an app (contract `requires_marker`) instead of stranding its data. Those
apps run on the development master secret until a deliberate component
upgrade flow exists — one that can replace component-owned files a build has
not adapted (hash-matched to the installed version, like the auth-wiring
repair does for entry files) and re-run the deploy so the key is minted. A
change of its own; until then `docs/features/immediate-repairs.md` says how
to do it by hand.

## The container lock is in-process, and a backend restart can leave an app stopped

**Since:** 2026-09 (PR #601, immediate repairs). **Closed** by the setup
engine (gate two): the lock is the persistent `setup_locks` lease, the
deploy is a saved job with checkpoints, and a restart mid-deploy is
reconciled to a resume, a recovery or a recorded recovery-required state —
`docs/features/setup-engine.md`. The text below describes the state before
it, kept for the history of the record.

`mock2/container-lock.js` serializes deploys, the two platform restores
(`restore_project_db`, `restore_snapshot`) and the retry path's secret mint
per container, and refuses a restore while a deploy holds the container. It
is a map in the backend's memory: it does not survive a backend restart. A
deploy interrupted by a restart is not resumed — the next deploy reaps the
orphan's scripts inside the guest first, so deploys do not overlap, but the
app the interrupted deploy stopped stays stopped until that deploy or a manual
`systemctl start mock2-dev.service` in the guest. The restart a failed deploy
attempts reports *serving* / *not serving* / *unknown* and never *recovered*:
the credential is not read back through the application.

**Remedy:** a persistent lock and a host runner with saved progress that
resumes or records recovery on start — requirements R1–R4 in
`docs/core/setup-engine-requirements.md` (gate two). Until then, after a
backend restart during a deploy, check the project's readiness lines and start
the unit by hand if the app is down.

## Forward rollback: ownership of uncertain resources is reported, not reconstructed

Recorded 2026-09-28 with the closing corrections of A-17.8 (platform
ledger R-057). A `forward_apply` interrupted between creating a resource
(the row, the proxy device, the firewall rule) and persisting its
ownership record resumes with that resource `present` and
`ownership: uncertain`; a later definite failure leaves it in place and
ends `rollback.state: unresolved` with the operator action on the record
(decide whether it belongs to the forward, remove it by hand, retry).

Deferred, deliberately: reconstructing ownership from the guest (for
example by matching the device's listen / connect to the plan, or the
rule's saved properties) and cleaning such a resource up automatically.
Both would turn an honest "not recorded" into an inference, which is
what R-054 forbids for the rollback. If it is ever wanted, the safe form
is an explicit operator verb that shows the evidence and asks for
confirmation, not a change to the settlement.

## Full Platform: a Custom plan save after apply wedges the coordinator

Found 2026-09-23 while adding the Platform Setup MCP family. The coordinator
refuses to continue when the shared service plan's revision differs from the
one the Full Platform revision recorded ("Custom setup changed the shared
service plan…"), and it re-records the shared plan only when a NEW Full
Platform revision is saved. Saving an unchanged Full Platform plan does not
create one, so after a Custom / Advanced plan save there is no way forward
except changing a field or resetting. `get_platform_setup` now reports this as
`shared_plan_changed` and routes to `reset_platform_setup` (data kept).
Proper fix: let an explicit re-review of the same Full Platform revision
re-record the current shared plan (it is the operator's reviewed choice).

## Full Platform: service records are written before the G3 observer exists

`prepareServiceConnections` saves the Vaultwarden/OpenBao/Infisical records
before the coordinator's `connect_managed_identity` step creates the read-only
observer and saves the ProxyPilot SSO record. From then on Custom / Advanced →
Vaultwarden → Apply is enabled and fails deterministically at
`dedicated_keycloak_handoff` ("The existing read-only Keycloak observer for this
provider is required.") until the coordinator gets past that step.
`continue_platform_setup({ service })` refuses such a retry with the reason;
the dashboard's Apply button does not. Fix: prepare those records after the SSO
record is saved, or gate the per-service Apply on the observer.
