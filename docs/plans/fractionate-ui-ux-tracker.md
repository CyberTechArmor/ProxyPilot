# Fractionate UI/UX alignment tracker

Owner: Thomas · implementation on Duo · started 2026-10-02.
Branch: `ui/mockup-alignment-20261002`. Publication/merge remains pending explicit instruction.

## Verified baseline and backlog

- GitHub main verified by remote Git read on 2026-10-02: `0f1b48f33fe31723100b8c758c717899bb7b3f1d`; fetched into the isolated local repository.
- Original backlog commit `ac62d45dba876b248b687679268a8d165ed221fd` is preserved unchanged as an ancestor of this branch. Original clean worktree remains at `C:/Users/thoma/Documents/Codex/2026-10-01/task-3/proxypilot-backlog-docs`.
- [CB01–08 backlog](fractionate-project-credentials-backlog.md) and [F8/F9 follow-on backlog](fractionate-follow-on-plan.md) own broker/custody confirmation, activation, isolation, real adapters/pilot, browser/OAuth, credential migration, text/image/document ingestion with originals and AI drafts plus human approval, and relational/S3/optional vector/event-ledger architecture. These items remain unaccepted planning; no stack or trust decision is made here.
- Updater PR718 and preservation PR719 are already in main and are excluded.

## Milestones and acceptance

| ID | Deliverable | Current state | Independently verifiable acceptance/evidence | Implementation commit |
| --- | --- | --- | --- | --- |
| UX01 | Reference inventory, route/state/viewport mapping and contract gaps | Mapping recorded; visual acceptance pending | Actual reference pixels inspected on Duo; see reference map; all supplied Library bytes now readable | c4cc81a8 (tracker start) |
| UX02 | Shared type, icons, spacing, controls, border/radius tokens | Implemented; browser verification pending | Same geometry in Midnight/Latte/Office; 44px mobile actions; no Nodus brand; screenshot measurements | bf9b241e |
| UX03 | Operations shell, persistent project list and overview cards; short creation | Pending | Desktop list/detail proportions; mobile disclosure; guide/readiness/agents/activity/access cards; settings separated; safe people picker or exact API gap | Pending |
| UX04 | Work/Connections/Controls/Review agent setup | Pending | Bounded cards, narrow assignment summary; cancel/back/reopen/repeated save; draft never starts a run | Pending |
| UX05 | Connection picker, centered Add dialog, catalogue/readiness actions | Pending | Accurate supported types/availability; optional assignment; permission/revoked/unavailable states; remove assignment distinct from global revoke | Pending |
| UX06 | Run hierarchy and browser/activity balance | Pending | Historical states, approvals, takeover and reconcile preserved; desktop/mobile screenshots | Pending |
| UX07 | Final aggregate checks, browser journeys and visual review | Pending | Required checks/build; 360/375/390/768/1280/1536/1920 viewports, overflow guard disabled; keyboard/focus; local screenshots compared to references; accessibility gate | Pending |
| G01 | User-directed authorized guide save/approval policy | In progress; separate local worktree | Authorized edit saves publish immutable approved version atomically; explicit pending Save and approve; revisions, provenance and run pins retained; no run or credential-write approval on save | Pending |

No completion percentage is assigned. A milestone is accepted only when its evidence is linked and limitations are stated.

## Reference inventory and route mapping

Initial confirmed local references:
- `C:/Users/thoma/Fractionate/OpenAI/outputs/agent-platform-setup/agent-connections.png`: inspected; Operations project list/detail, Agents setup Connections state, narrow assignment summary.
- `C:/Users/thoma/Fractionate/OpenAI/outputs/agent-platform-setup/add-connection.png`: inspected; centered credential dialog over the same setup route.
- `design-and-prompts.json`: source title “Fractionate Agent Vison Plan and Review”, thread `01a0d3b8-06f8-7fb2-9c6f-02ad48e753a9`; no chat URL supplied.
- Library approved references: Projects-add-connection, Projects-setup, agent-flightdeck, agent;s-mockup, Projects-mockup, palette. Current comparison images: Connections, Add dialog, Operations, Overview, Latte ended run. All materialized to the local Duo `references` folder with the current unmodified helper and a Windows named-metadata-stream adapter; byte sizes and Library identity/version streams verified. Actual Projects, setup, Flightdeck, agents catalogue, current Operations/Overview/ended-run and new approval-blocker pixels inspected. Do not infer setup appearance from global Connections.
- Additional usability evidence: `libfile_f96b564e9cdc819184ea510b566b29d2` and `libfile_ec32b6ade5cc81918a79c20b90caeeac`, inspected locally. TAG Armor's generic Researcher configuration has no guide/binding and a demo-only execution workflow; guide pending state showed the now-superseded independent reviewer blocker.

The route/state map is in [fractionate-ui-ux-reference-map.md](fractionate-ui-ux-reference-map.md). Reference canvases differ; exact dimensions and checksums are recorded there. Phone adaptations follow MOBILE_FIRST.md rather than copy desktop widths.

## Contracts and exclusions

Keep explicit run/action approvals, CSRF/sudo flow, permissions, secret non-disclosure, agent draft/readiness/run separation and no execution side effects on save unchanged. Existing infrastructure routes remain accessible. UI changes do not establish runtime capabilities shown only in concepts.

### Explicit policy scope change — 2026-10-02

Thomas requested: “Please remove the restrictions. By adding and saving, it should be approved.” This supersedes independent-review separation **only for authorized guide save/publication**. An owner/editor save validates and publishes an immutable approved version with author/time/version/hash/provenance. Existing pending submissions require an explicit Save and approve action using their saved snapshot; no migration bulk-approves them. Stale saves must fail revision checks. Existing approved versions and run pins remain unchanged. Saving a guide does not start a run, approve a credential write, grant access, enable an adapter, or widen the synthetic `https://demo.fractionate.ai` browser pilot. Historical backlog text describes the earlier policy; G01 owns this explicit change.

Excluded: production shell/SSH/MCP mutation, deployment, credential enrollment, broker activation, trust acceptance, stack selection, updater/preservation work, push/merge/un-draft and rewriting pushed history. Local disposable browser fixtures may simulate responses; evidence must identify fixtures rather than imply production proof.

## Evidence log

- Baseline and original backlog ancestry verified; no remote mutation.
- Local mockup pixels inspected using image viewer.
- AGENTS.md and .agents/skills are absent from current repository; CLAUDE.md, LEARNINGS.md, MOBILE_FIRST.md and available relevant repository skills are being inspected.
- Build/browser evidence and final commit ledger: pending implementation.

## Blockers and decisions

- Library helper Windows metadata incompatibility resolved with NTFS named streams while keeping the current helper unchanged; all requested references readable with identity/version preserved.
- Precreation user-picker contract gap: `GET /:id/access/candidate` requires an existing project and owner access; the global user directory is administrative. The short creation flow defaults private, then directs the owner to named existing-user lookup in Access. No new account-enumeration endpoint is introduced.
- Browser execution remains the synthetic sign-in pilot at `https://demo.fractionate.ai`; configured generic work is not general research capability. Typed API configuration remains limited to supported adapters. Surface those constraints before setup and beside readiness actions.
- Required aggregate selection/build and broker/agent browser suites identified from repository CI; dependency installation and local validation in progress. Linux host/root tests can only use disposable local WSL fixtures, never production.
