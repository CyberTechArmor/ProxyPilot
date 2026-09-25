# Next session prompt — close the A1 pilot review only

> Historical handoff executed on 2026-09-25. The live website review and
> [pilot contract](fractionate-agents-a1-pilot-contract.md) are recorded; the
> user will create the first Operations project and specify its final site.
> A1 remains in review pending its guide and authority decisions. The later
> user request separately authorized committing/merging the reviewed work;
> [A2's next-section prompt](fractionate-agents-a2-prompt.md) remains the
> implementation handoff, not an instruction to start A2 here.

Workspace: `C:/Users/thoma/Fractionate/OpenAI/Fractionate/ProxyPilot-batch-03`.

Continue the Fractionate first supervised agent plan. **Complete A1 review and
handoff only. Do not begin A2 implementation.** Preserve all existing work,
including uncommitted A1 documentation and the standalone demo site. Read
applicable `CLAUDE.md`/`AGENTS.md`, current Git status and diff, the official
[A1–A8 plan](fractionate-agents-a1-a8.md), [A1 architecture](fractionate-agents-a1-architecture.md),
[acceptance matrix](fractionate-agents-a1-acceptance.md), [source register](fractionate-agents-a1-sources.md),
[A2 prompt](fractionate-agents-a2-prompt.md), `../../../FINISH.md`, both adjacent
trackers and `../../../agents-a1-evidence/`. Do not assume the branch is clean or
that historical verification applies to the current source.

The selected first workflow is browser navigation and sign-in at
`https://demo.fractionate.ai`. The standalone React/Vite demo has a landing
page, login dialog, workspace and protected sample CSV. The fixture account
`demo@fractionate.ai` / `welcome-demo` is intentionally public sample data.
In the previous session, ProxyPilot deployed it to LXC `fractionate-demo`
(`pp-fractionate-demo` in Incus), installed it under `/opt/app`, registered the
`fractionate-demo.service` systemd service and routed the hostname over HTTPS
to reserved guest address `10.185.17.210:4179`. ProxyPilot's route probe
returned 200 for `/` and `/api/session`, 401 for an unsigned file download;
the public browser completed sign-in and began the CSV download. The service
was active and the TLS certificate valid. Verify the current state afresh.
This deployed **demo website is not an agent worker or agent runtime**.

First reconcile the A1 architecture, acceptance matrix, A1–A8 tracker, A2
prompt, adjacent trackers and evidence with the live deployment. Replace
stale claims that the target is only local or undeployed. Record current route,
service, TLS, public login/download evidence and exact source/build identity;
be honest if the deployed archive cannot be tied to a commit because the
source is uncommitted. Keep the demo-only deployment distinct from A8 agent
deployment acceptance and from the unresolved SEC/INF findings.

Then prepare one concrete, reviewable pilot contract for the user: the exact
Operations project and approved guide version/hash, who may configure a
profile and start/stop/take over a run, who may approve any sensitive action,
how the fixture credential is bound and revoked, permitted origins/actions,
login-attempt and time/tool/cost/resource ceilings, success/failure evidence,
and the human handoff for an unexpected challenge. Use source-grounded defaults
where possible; identify each remaining decision that requires the user's
choice. Treat optional PDF/CSV delivery into an Operations project as a
separate action grant with project-scoped local or S3 storage, not part of the
initial sign-in success criterion unless the user selects it.

Update the A1 documents, evidence and trackers to match verified facts. Mark
A1 complete only when the pilot contract and required authority are actually
approved and its acceptance gate is met; otherwise leave it in review with a
short decision list. Keep the bounded A2 prompt ready, but do not execute it.
Run documentation/evidence checks relevant to edits, record exact results and
stop for review. Do not implement or activate an agent, use real credentials,
change the live host/site, deploy agent code, commit, push or merge unless the
user separately requests that work.
