# Automatic browser runtime maintenance

An installed browser supervisor is already persistent: its reviewed systemd unit
is enabled at boot, orders startup after the fence/proxy and restarts on failure.
An isolated browser attempt still requires an explicit authorized task.

The default-off maintenance preference lets an administrator keep an already
committed selected runtime package current with reviewed source delivered by
ordinary application updates. It never fetches code, follows a branch, provisions
a VM, enrolls an absent/legacy/unknown installation, refreshes acceptance or starts
a browser task. Initial runtime installation retains its existing explicit action.

GET /api/user/version/browser-runtime/maintenance is administrator-only.
PATCH the same endpoint with exactly { "enabled": true|false } requires the
existing administrator, sudo and CSRF boundary, records an audit event and queues
a fixed authenticated root-runner preference operation. Track that returned
request ID through ordinary update status. The preference is mode0600, root-owned
host state. A passive five-minute systemd timer is installed with the application;
without the preference it has no runtime effect. A preference change waits for
the next check and does not stop the dashboard itself.

The public status schema is browser-runtime-maintenance.v1, with enabled,
status (disabled, up_to_date, deferred, updating, needs_repair), reason (null,
waiting_for_check, browser_work_active, previous_attempt_failed, host_checks_failed),
checked_at, installed_generation, delivered_generation, delivered_revision,
operation_id and runtime_accepted:false. Digests describe the installed/delivered
code and unit generation. An automatic operation ID belongs to the private host
operation, not an ordinary update-status request. Never infer browser capability
readiness from up_to_date: existing capability checks remain authoritative.
Replacing helpers can make the retained acceptance proof stale.

Each check serializes with ordinary updates and manual runtime operations using
the update lock, and with certificate/runtime changes using the existing fence
lock. It authenticates installed code/units against retained committed generation
bytes and installer journals, checks serving identity and compares exact candidate
code/units. Unchanged generations do not reinstall or restart anything.

Before a changed generation can stop the dashboard, a short SQLite BEGIN IMMEDIATE
writer barrier excludes new durable reservations while recognized terminal-state
admission and runtime ledgers are checked. The barrier is rolled back and released
immediately after the exact existing dashboard container has stopped; it writes
no rows/schema and restores no database. The existing package transaction then
remeasures its plan, applies the exact25-file boundary, verifies health, commits
and restarts that same container. Actual busy work defers before stop. NULL,
unknown states, missing/foreign transactions, source/host/configuration or retained
byte drift refuse. No protected key, config, acceptance, ledger or history is
cleared to satisfy admission.

A private failure latch is fsynced before effects. Failure, interruption, reboot,
a preference toggle or another delivered version cannot replay that operation.
The existing stop hook/boot recovery can restore the interrupted package/dashboard;
the latch still requires inspection and a distinct successful explicit install.
A completed unchanged generation is recognized without another transaction.
Manual recovery alone does not grant a retry of the failed generation.

Verification lives in test_browser_runtime_maintenance.py (actual temporary
package bytes, SQLite writer contention and admission race, no-effect busy/default,
exactly-once generation update, retained acceptance/history and failure latching),
plus the existing operation/package, Go request/projection and backend driver tests.
Host effects are simulated in CI. Actual reboot and timer/update journeys remain
target verification; source tests never create installed acceptance.
