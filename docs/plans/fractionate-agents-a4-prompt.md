# Next section prompt — A4 credential and provider broker, gated by A3

Do not execute merely by reading this file. **A4 is gated on A3 acceptance.**
As of 2026-09-28 the host-owned A3 supervisor, guest runner and typed backend
client are implemented, but the target proof has not run. The
[A3 acceptance prompt](fractionate-agents-a3-acceptance-prompt.md) must first
record A3 as accepted from observed evidence on the proof VM; start from the
[A3 reference](fractionate-agents-a3-reference.md). A configuration assertion
or a local test is insufficient. Keep A2/A3 feature gates off.

The A4 credential broker must use the A3 path, not bypass it. Sign-in
submission belongs to `submit_bound_fixture`, which the supervisor refuses
today (`CREDENTIAL_BROKER_UNAVAILABLE`). A4 must deliver the bound fixture
through a host-side broker without putting the value in the model context, the
guest runner's command channel, page-visible logs or supervisor receipts. It
must also extend the origin proxy's reviewed path policy for `/api/login`
itself, with the matching proof. Do not widen any other A3 method, socket or
allowlist.

Then read the official A1–A8 plan, A1 architecture, pilot contract, acceptance
matrix and source register, A2 and A3 evidence and exact diff, current
Operations schema/store/routes, host-boundary inventory, `CLAUDE.md`, adjacent
`FINISH.md` and both trackers. Capture branch, HEAD, full status and pre-edit
hashes. Preserve B1–B4, D1–D4, migrations 1100–1109 and immutable history.

Scope A4 to one synthetic sign-in credential binding and one allowlisted
provider/model route. Use an operator-authorized project/profile/binding UUID
and revision; never infer access from display names, Operations membership or
the existing Infisical agent identity. Design a broker outside model, guide,
page, logs and progress contexts. Test current account/grant/guide/site/policy
and binding revision at every use, with rotation, revocation, logout and
cookie-jar disposal. Prove actual secret and management-network separation on
the A3 target. An Infisical project Admin or OpenBao AppRole can read assigned
values; do not claim those mechanisms hide a secret from that identity.

Read the current project-owned token and spending policy, which defaults to
unset/unbounded, and pin its revision to the run. Enforce any configured
limit with reservation and actual provider usage accounting. Unknown model
price, usage, authority, scope or network boundary fails closed even when
project spending is unbounded. Record provider response IDs and redacted
outcomes. Do not build the A5 loop, approvals, A6 UI, A7 recovery practice,
A8 release, optional Operations document delivery, D5 or shared Knowledge.
Use only disposable synthetic account and provider fixtures until separate
live authorization. Do not activate flags, deploy, mutate a live host/site,
commit, push or create/merge a PR unless separately requested.

Run native SQLite/HTTP and broker tests, target isolation/revocation/egress
tests, frontend build if touched, host inventory without suppression and
required Security CI for any submitted head. Record commands, results,
hashes, diff, observed target proof, rollback and older-writer limits in
adjacent A4 evidence. Write the bounded A5 prompt and stop for review.
