# Selected browser runtime package contract

This is the separate repository contract for installing and subsequently
updating the selected browser runtime on an already enrolled A3/A4/A7/A8 proof
host. It is implemented by `scripts/selected-runtime-package.py` and exercised
with real temporary files, Ed25519 keys, installation journals and mocked
services in `scripts/tests/test_selected_runtime_package.py`.

No installation was performed by writing or testing this contract. It does not
enroll a host, activate credentials, modify Incus/firewalls/Chromium, create an
acceptance marker, or authorize production execution. Ordinary Settings → Update
delivers current source and this helper, while the capability-aware
`review-runtime-refresh.py` preserves a positively recognized legacy runtime.
The historical two-file public-review refresh and exact guest compatibility
exception remain available for historical source releases. Ordinary Update does
not invoke this package helper. A source merge or dashboard update cannot make
the selected runtime ready.

## Exact package and immutable identity

The coordinated transaction owns exactly **25 files**:

| Location | Files |
| --- | --- |
| `/etc/proxypilot-a3-proof/supervisor/` | `a3-worker-supervisor.py`, `a3-worker-guest.py`, `a3-install-proxy.py`, `a3-install-fence.py`, `a3-network-fence.py`, `a3-origin-proxy.py`, `selected_browser_supervisor.py`, `selected_browser_policy.py`, `selected_browser_gateway.py`, `selected_browser_worker.py`, `selected_browser_contract.py`, `selected-browser-schemas.json`, `selected-browser-model.py` |
| `/etc/proxypilot-a3-proof/` | `origin-proxy.py`, `selected_browser_gateway.py`, `selected_browser_policy.py` |
| `/etc/proxypilot-a4/broker/` | `a4-credential-broker.py` |
| `/etc/systemd/system/` | `proxypilot-a3-supervisor.service`, `proxypilot-a3-proxy-renew.service`, `proxypilot-a3-proxy-renew.timer`, `proxypilot-a3-origin-proxy.service`, `proxypilot-a4-broker.service` |
| `/var/lib/proxypilot-a3-proof/` | `supervisor-install.json`, `proxy-install.json` |
| `/var/lib/proxypilot-a4/` | `broker-install.json` |

Code and units are mode0644; the three installation journals are mode0600.
They keep their existing version, VM UUID, phase and other metadata. Only the
exact owned `files` SHA256 map is updated. The proxy unit receives the reviewed
`--serve --selected-control` profile and fixed private runtime/write paths from
`a3-install-proxy.py`'s source plan. The broker is part of the same transaction;
selected model support cannot be refreshed independently of the supervisor and
gateway protocol.

The first `install` requires the complete historical six-file supervisor
installation, its supervisor/renewal units and public-key journal entry, the
four-file proxy installation, and the two-file broker installation. Selected
helpers must be absent. `update` requires the exact expanded installation.
Unknown files in an installation journal, absent legacy renewal enrollment,
changed file modes, an incomplete journal, or unowned selected helper files
refuse before service operations. This helper does not silently repair or
enroll an unfamiliar host.

All source bytes come from the fixed `/opt/proxypilot/scripts` delivery, which
does not need a `.git` directory. The helper reads only the fixed root-owned
`/var/lib/proxypilot/update/source-dir` record written by ordinary install/update;
it has no source-path flag, environment override or copied-install Git fallback.
The record must contain one canonical absolute root-owned checkout path, with
nonsymlink root-owned ancestors and Git/worktree common state. Every one of the
17 source inputs, including the package helper and installer unit constants,
must match both that checkout's working bytes and
`git show <pinned-HEAD>:scripts/<fixed-name>`. HEAD and the source record are
checked before/after attestation, and all delivered bytes/modes are read back.
Copied source modes0600/0644/0700/0755 accommodate the root updater's umask;
root custody and the plan's exact observed mode still apply. The plan binds
the checkout path, record hash, immutable commit, delivered modes and each input
hash for install, update, commit and recovery. Python syntax and JSON structure are checked; unit strings
are read as AST literals. Candidate Python is never imported or executed while
building a plan. No downloaded package, caller-supplied path, shell fragment,
environment root override or CLI adapter is accepted.

The normal updater resolves fetched `refs/heads/main` once and verifies its
exact SHA and the original checkout branch through re-exec and completion.
Package planning uses that recorded delivery and immutable SHA, without fetching
or resolving a mutable branch. The existing separately authorized exact
`--build-current=<SHA>` behavior remains unchanged; this helper provides no new
route for choosing a source commit.

## Ordinary Update compatibility

When the delivered source includes the expanded selected package, Update
requires the authentic PR724 legacy supervisor/broker/adjacent-code hashes, the
exact PR710 or PR724 guest, existing installed digest journals and fixed units.
The exact pre-renewal owned set remains recognized with both renewal files
absent; no timer is enrolled. Proxy code, certificate/key equality, certificate
lifetime, target/service health, receipt keys, A8 wiring, modes and idle ledgers
remain checked. Mutually consistent unknown code/journal hashes are refused.
Any selected helper, acceptance marker, gateway state or selected-package
transaction directory requires separate review. Unknown/partial selected
installation is not an unavailable-runtime success.

A completely unenrolled host skips runtime work only after positive absence of
the fixed configuration/state roots and supervisor/proxy/broker/fence/renewal
units. Existing artifacts without reviewed A8 settings refuse; Update never
repairs or enrolls them. Current selected runs, conversions and model reservation
database namespaces must contain only recognized terminal states. Unknown/null
states and active selected model-ledger reservations also refuse before effects.

Preservation uses a distinct version2 `preserve_legacy` metadata transaction in
the existing root-private refresh directory. Apply rechecks admission after the
dashboard stops and records complete legacy code/unit/journal pins, protected
identity and exact source delivery. It writes only that private metadata, with
no installed runtime/ledger replacements, daemon stops/restarts or acceptance.
Commit verifies those same preserved source/runtime identities and serving
bytes after dashboard health, while permitting legitimate newly admitted Demo
or provider work. It never restores an earlier runtime ledger.

Interrupted preservation requires its verified rollback before another Update;
that rollback checks current idle admission and retained identities, marks only
the preservation metadata, and performs no runtime restore or service effect.
Drift refuses recovery with the dashboard stopped for inspection. Older
version1 refresh transactions keep their exact four-target rollback behavior;
unknown or incomplete transactions cannot be superseded by preservation.

The expanded preservation profile in `review-runtime-refresh.py` recognizes a
separately committed selected package. It attests current delivered source to
the updater's exact Git revision, checks the complete installed journals and
25-file set, and requires every installed code/unit byte to match both the
committed package and the current source-generated contract. A runtime code or
unit change still requires the separately reviewed package workflow. Normal
application-only updates preserve the runtime without restarting its daemons.
The existing versioned browser/gateway/schema contracts remain unchanged.

A version3 `preserve_selected` transaction records current source, complete
protected inventories, machine/VM/network/Chromium/receipt identity, current
units, installed pins and idle ledgers. It writes only private updater metadata.
Apply requires a stopped dashboard and rechecks admission. Commit verifies
current code and identity after dashboard health, allowing newly admitted work
without comparing, restoring, settling or replaying business history. The
readiness API remains authoritative; preservation never claims browser
availability or writes acceptance. Absent, expired or otherwise unaccepted
proof cannot be converted into acceptance by an ordinary update.

A certificate renewal between completed updates is recognized only when the
proxy journal's certificate/key pair changes: other journal metadata must match
the retained committed generation. Current certificate/key equality, lifetime,
root custody, serving bytes and policy are still verified. A completed renewal during an
in-flight preservation transaction is accepted after those same checks; no
certificate, key or journal is restored. A7 TURN's separate certificate timer
is recognized only for its existing mode0640 certificate/key pair: the current
chain must validate against system trust for the retained installation hostname,
remain valid for a day, match its private key, and have stable loaded TURN and
renewal services. Every other A7 tree entry remains exact. Other drift refuses.

Interrupted preservation requires a stopped-dashboard metadata-only rollback.
A reboot may change only the host boot ID; current idle admission and every
stable identity still verify. Completed new history is retained rather than
compared with old ledgers. Unknown state or other changed pins refuse without
runtime restoration. The updater's exact absent-key `SETUP_EXECUTOR_POLICY`
append is recognized only if removing that fixed suffix reproduces the original
private environment bytes/mode and no prior policy assignment exists.

Once the setup runner or replacement dashboard could have started writing,
update failure retains the current database and runtime history and reports an
incomplete update for inspection. It does not stop a healthy backend or restore
the older database. Pre-start build failures retain the existing stopped-writer
restore path. This guards against a late preservation failure discarding new
work. A completed
initial-install rollback may retain its transaction directory: its exact restored old
files and journal metadata must verify before the existing positive legacy
profile admits an ordinary update. No history directory is deleted to achieve
admission. A fully rolled-back later package upgrade retains the prior expanded
generation; that generation must match its saved old pins and current delivered
source before selected preservation is admitted. Partial package installation/
recovery is never admitted.

Local tests cover these source/filesystem contracts with simulated host effects.
Actual expanded-host update/recovery acceptance is still pending installation;
this source change does not claim that target proof has happened.

Before a future installation approval, obtain the current complete read-only
package plan on the actual host. Record its exact `plan_sha256`, source revision,
source checkout/record/delivered hashes, machine/boot/VM/network/policy identity,
key/SPKI, installed/new25-file pins, protected state, ledgers and unit state.
Approval names those measured values and the exact operation. Repository hashes
or an earlier plan are not a substitute for this action-time measurement.

The following data are protected by fresh file/directory inventories and are
never backed up for restoration, rewritten, pruned or regenerated:

- Receipt private/public key pair, A8 public-key pin and key archive.
- Proxy certificate/private key; canonical Ed25519 receipt identity, proxy
  certificate/key SPKI equality and certificate lifetime are checked.
- Broker configuration/AppRole, supervisor attempt/model/review history,
  broker call/binding/price ledger, and gateway history/latch.
- Fence configuration/journal/unit, existing live marker and A7 configuration,
  secrets, live installation journal, TURN service/certificate units and the
  fixed TURN Caddy site. Retained A7 build/deb caches are outside the owned write
  set and are never scanned, changed or restored.
- Dashboard `.env` and Compose wiring. Exact A8 opt-in and the read-only
  backend-directory/public-key-only mounts are validated; preserving the hash
  of an already invalid wiring arrangement is insufficient.
- `selected-browser-acceptance.json`, including its absence. Updating helpers
  makes previous helper-hash proof stale; the installer never refreshes it.

The plan records current machine ID, host boot ID, exact fixed Incus VM UUID,
VM configuration/device hash, effective nft policy hash with counters removed,
the managed Chromium policy hash, receipt key identity and proxy SPKI. No VM,
network, key, policy, credential or run is created or changed. Host queries and
service health are read-only. Socket health must identify the actual serving
supervisor/guest/broker/gateway bytes; unit fragments, drop-ins, reload state and
enablement must match the fixed contract. Public/model availability is not
inferred from package installation.

## Review authority and admission

The production CLI refuses unless the actual effective UID is0 and the helper
is at the fixed, nonsymlink, root-owned
`/opt/proxypilot/scripts/selected-runtime-package.py` path. It offers no root,
source, database, host adapter, trust token or test-mode override. In-process
`Tree` and `Host` replacements are test seams; no command or backend wire field
can select them.

Every operation holds the existing `/run/proxypilot-a3-fence.lock` exclusively.
The regular root-owned lock recognizes the historical0644 mode and0600 mode;
it never relaxes or rewrites its custody. The reviewed transaction root must
already have its root-owned parent and is created privately at
`/var/lib/proxypilot/update/selected-runtime-package` (0700).

The operator first obtains `plan --operation install` or `plan --operation
update`. This computes metadata without package writes or service effects.
`review --operation <operation> --plan-sha256 <exact-hash>` displays that
complete plan on an interactive root TTY and requires the operator to type the
exact SHA256. A mode0600 `review.json` binds the operation, full plan hash,
one-time random token and a maximum15-minute expiry. Review is explicitly
separate from install/update. Neither source ownership nor a CLI hash string
alone substitutes for that stored review.

`apply --plan-sha256 <exact-hash>` remeasures the complete plan under the lock,
checks the fresh review receipt, and consumes it before the first service
operation. Source, installed hash, host identity, protected bytes, run ledger,
unit state, review expiry or dashboard admission drift refuses. After staging
backups it rechecks the same review and actual bytes again before stopping
services. Replaying the consumed approval fails.

The dashboard must already be stopped by its authorized operator. The helper
does not stop it. Read-only SQLite admission covers Demo and selected runs,
Website reviews, conversions, Demo model calls and selected model reservations.
Supervisor attempts, public reviews, selected model reservations (including
the interval before broker pinning), broker calls and any durable gateway latch
also prevent an unsafe transaction. Unknown states fail closed. Terminal
uncertain spend remains durable and is not retried, settled or cleared.
Remaining guest worker cgroups also refuse admission, so restarting a daemon
cannot silently trigger cleanup of an unowned or terminal guest worker.

## Paired apply and durability

An apply stages every old file and new candidate in a random private generation
directory, with SHA256/size/mode pins. Files newly introduced by initial install
have an explicit absent old pin. The private transaction journal records only
metadata and the fixed owned path set, never credential/state values.

The phase sequence is `prepared → stopped → replacing → applied → committed`.
The renewal timer/service is stopped first, followed by the supervisor, proxy
and broker. Every unit must be inactive. Identity, protected state and all
recognized old/staged bytes are checked again while services are stopped.
Initial install creates only the fixed0700 gateway-state directory, if absent.

Each replacement uses an exclusive random sibling in a pinned parent directory,
an atomic rename, file and parent fsync, and byte/mode readback. All25 files
must match the new manifest before a service restarts. The helper reloads
systemd, then starts broker, proxy, supervisor and the existing renewal timer;
it verifies their serving identity, idle gateway, enablement and protected
state. The package is atomic at the service boundary, not by one filesystem
rename spanning multiple directories. An interruption leaves a durable phase
and recognized old/new file mixture with services stopped; a failed startup
requires recovery and does not announce success.
Creating the transaction root, private generation or gateway state directory
also fsyncs its checked parent immediately; syncing a later journal inside a
new directory does not substitute for making that directory link durable.
Rollback fsyncs the parent after removing an empty, initially created gateway
directory. Existing private directories are only checked, with no creation or
sync effect.

`commit` requires its own fresh `plan → review → commit` sequence, an applied
transaction, current new bytes, healthy paired services, unchanged protected
state and idle dashboard. It marks package completion only. It does not start
the dashboard or claim selected browser acceptance.

## Recovery and rollback

Recovery never resumes a partially installed generation. `plan --operation
recover`, interactive `review`, then `recover --plan-sha256 <hash>` restore the
verified old package for `prepared`, `stopped`, `replacing` or `restoring`
transactions. Rollback uses the same separately reviewed flow with operation
`rollback` for an applied or committed transaction.

Before any stop or target write, both staged new bytes and old backups must
match their exact private pins, and installed files must be exactly recognized
old or new bytes/absence. The journal must name this fixed25-file contract.
Foreign backups, root/mode/inode drift, symlinks/hardlinks, source identity,
host/key/fence/policy/config drift, active work and unit override/enablement
changes refuse. Backups are generated UUID-generation files, never caller paths.

A host reboot can be recovered only with a new root review binding the current
boot ID; machine, VM/configuration, policy, fence and key identity must still
match. Recovery stops all paired services, restores all recognized old bytes,
removes only files that were absent before initial install, and removes the
initially created gateway directory only if it remains empty. Gateway history
or latch data are never deleted to make a rollback fit. Whole-package old
readback and serving health precede the `rolled_back` phase. A crash during
restore is recovered through the same recognized old/new proof and a fresh
review. No run, request, model call or uncertain reservation is replayed.

Automatic rollback deliberately refuses if business ledgers changed since the
transaction. This preserves current history and prevents old code from being
activated against unreviewed newer state. Rolling back after newly executed
work or a schema/protocol change requires a separate compatibility design;
restoring historical runtime journals is never the remedy.

## Verification and remaining installed proof

Temporary tests exercise the actual expanded bytes and unit strings, real
Ed25519 keys, a real certificate/key pair, exact A8 wiring, read-only SQLite
admission, initial install, future update/commit/rollback, every owned-file
interruption and recovery, reboot re-review, one-time/expired reviews, source
and installed drift, private key/config/ledger/unit drift, symlink/hardlink/root
swap defenses, bounded reads and lock contention. Service/VM/network effects
are mocked. Tests do not generate usable installed acceptance evidence.
An fsync/rename spy verifies that new directory links, private staged files and
the transaction journal are durable before the first mocked service stop.

An independently reviewed target still must prove actual Incus identity,
effective nft/cgroups, Chromium policy, before-contact gateway checks,
restart/recovery/cleanup, live spectator/controller privacy, private chooser
workspace and decoder isolation. The separate root-owned acceptance marker and
each private artifact/decoder boundary must come from that actual proof. This
package contract supplies reviewable installation/update/rollback behavior;
it leaves those installed acceptance requirements intact.
