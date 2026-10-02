# UI/UX reference and acceptance map

All references were materialized and inspected on Duo on 2026-10-02. Images live in `C:/Users/thoma/Documents/Codex/2026-10-02/task/references`; originals live in `C:/Users/thoma/Fractionate/OpenAI/outputs/agent-platform-setup`. Library identity and version metadata remain associated with each local image.

## Approved references

| Image / Library identity | Canvas | UI mapping and approved treatment |
| --- | --- | --- |
| Projects-mockup.png · libfile_c96a3e6010988191af809a8b06756ce0 | 1586×992 | /operational-projects and /operational-projects/:id?section=Overview: left search/filter/project rows, right selected detail/tabs, training/guide/readiness/recent runs/access cards. Status must describe actual API state; no invented project/agent toggle. |
| Projects-setup.png · libfile_d07dc7835d7081918672153ebcca5d1e | 1536×1024 | /operational-projects/:id?section=Agents: Work/Connections/Controls/Review. Connections has bounded provider/application cards and narrow assignment summary; controls stay compact. |
| Projects-add-connection.png · libfile_96dd9056bb9c8191a6c69d4028158f1c | 1536×1024 | Add dialog within setup and /connections catalogue: centered ~600px desktop dialog, title/description, aligned label/control rows, availability, assignment intent, advanced disclosure, footer. Trusted external credential intake replaces the concept token field; no secret accepted in dashboard. |
| agent-flightdeck.png · libfile_4091199d337881918624245b334e8f36 | 1585×992 | /operational-projects/:id?section=Agent%20runs&run=:runId: dominant browser panel with compact title/status toolbar; right review/activity/guide/details rail. Direct-agent message and arbitrary browser work are concepts without implemented contracts. |
| agent;s-mockup.png · libfile_c23e5715ae1c8191b6d1c54bec3bb554 | 1586×992 | Agent run/inbox cards: clear state, purpose, progress and review entry. Current API has typed counts/history; live thumbnails only when actually available. No fabricated active sessions or screenshots. |
| image(2).png · libfile_09c0ea2658888191aa268c788d0fe14a | 2048×1145 | Palette reference only: Midnight/Latte/Office remain color-only; typography/layout identical. No Nodus name/logo. |
| agent-connections.png (original local) | 1536×1024 | Same screen family as setup, directly inspected; original local JSON preserves source title/thread id. |
| add-connection.png (original local) | 1536×1024 | Same modal screen family, directly inspected. |

The reference ratio is about 35–40% project list and 60–65% selected detail after the navigation rail. Adapt reference proportions to available width; do not copy fixed desktop dimensions to phones. Sans typography hierarchy: large page title, ~24px selected title, ~20–22px section headers, 14px controls/body and 12px metadata. Spacing uses 4px multiples, compact ~6px corners, restrained borders and consistent Lucide icons.

## Current-state evidence

| Image / Library identity | Canvas | Observed issue |
| --- | --- | --- |
| image(6).png · libfile_b39ed4f9286c81918fac16b2e0a3091d | 2048×1236 | Global Connections catalogue; not evidence of wizard appearance. |
| image(7).png · libfile_e80229cdb6f4819192b44187191c7a69 | 1102×1363 | Existing Add dialog grouping/density. |
| image(8).png · libfile_e171d9f989cc8191af8a1fdd6fb2db41 | 2048×1297 | Operations dominated by inbox and open creation form. |
| image(9).png · libfile_efedb8e3b09481919739512d3acc49d5 | 2048×1218 | Overview dominated by edit/archive form rather than summary hierarchy. |
| image(20261002-120832).png · libfile_0a4127ccdbe881918c46749512e14cbd | 2048×1233 | Ended Latte run shows large empty black browser and reconciliation above deck. |
| image(20261002-133234).png · libfile_f96b564e9cdc819184ea510b566b29d2 | 2048×1203 | Generic Researcher cannot start: unsupported site, no guide/binding. Early capability explanation and concrete next actions needed. |
| image(20261002-133235).png · libfile_ec32b6ade5cc81918a79c20b90caeeac | 1486×1234 | Pending TAG Armor guide cannot be self-approved under prior policy. Thomas explicitly superseded that guide-only policy; G01 adds authorized Save and approve. |

## Route/state journeys

| Surface | States and journeys to verify | Evidence needed |
| --- | --- | --- |
| Operations index / creation | Loading, disabled feature/admin settings, empty/filter/search, discoverable/request pending, pagination, open/cancel/reopen/create, private default, permission loss | Real browser screenshot, no horizontal overflow; creation payload has no fabricated people IDs; named lookup deferred to owner Access route |
| Selected project / Overview / Settings | Owner/editor/viewer, active/archive, long names, list switching, direct-link/back, summary guide/readiness/agents/activity/access, separately opened edit/archive settings | Cards visible without dominant form; desktop list and detail share row; no inaccessible infrastructure routes |
| Guide / Versions | Empty/valid save, published revision, stale concurrent save, pending explicit approval, withdrawn/historical guide, permission denial | Backend atomic tests plus browser actions: no review blocker, author/time/hash/version retained, existing pins unchanged; save creates no run |
| API agent setup | Work/Connections/Controls/Review, back/section jump/cancel/reopen, save draft per step, incomplete registration/readiness, selection narrowing/expired assignment, repeated/stale save | No assignment or run on draft save; precise typed-adapter capability shown early; desktop narrow summary, mobile stacking |
| Connections picker/dialog/catalogue | Loading/empty/error, assign/use/manage rights, revoked/policy-revalidation/unavailable, selected scope, Add cancel/back/trusted-intake metadata request, remove assignment/global revoke distinction | UI fixture payload/permission checks; no dashboard secret field; keyboard/focus return; typed unsupported browser/OAuth status |
| Agent profiles / start/practice readiness | Demo-only synthetic sign-in, no guide, stale guide/site, binding absent, execution unavailable, eligible profile | Every disabled reason paired with a real destination/action or honest operator-managed boundary; no arbitrary research implied |
| Open run | Prepared/running/approval/help/takeover/reconcile/ended/history, activity/guide/details/review, expanded browser frame, stop/resume, unavailable live view | Existing A6/A7 browser suites against real disposable router/store/coordinator + scripted supervisor; preserve digest, sudo, exact approval and fencing |

## Viewports, colors and evidence discipline

Check 360×640, 375×812, 390×844, 768×1000, 1280×1000, 1536×1024 and 1920×1080. Disable global overflow guards for audits. Phone dialogs are full screen below sm; primary actions at least 44px. Default Tailwind breakpoints only. Repeat identical frozen state in Midnight/Latte/Office before geometry comparison; await actual catalogue data. Include keyboard/focus and cancellation/repeated/interrupted request journeys.

Acceptance compares actual browser screenshots to reference pixels and documented current contracts. Concept content/types without runtime support are not acceptance criteria for adding those capabilities. No exact pixel-fidelity or completion claim is made before rendered review. See [tracker](fractionate-ui-ux-tracker.md) for final evidence and commit ledger.

## Reference checksums

- Projects-add-connection: `96c42c6bf99afab07b7bf444f5926198a8080015db12ec25321b81f6a0ee1e30`
- Projects-setup: `9db5ea9bc99711ce51a17a31957ab4866fe7df3f151bfd27a68a5e14eb9cf764`
- agent-flightdeck: `bb07278b834a51c9ecf7e3a3669c740a526020de299f92fa6ff9d08b8a7eba2b`
- agent;s-mockup: `506ab3f00a39b91a10cfd37671bd608133b8ccc91ca95d2115edc96cb6f26ea3`
- Projects-mockup: `a7d9415fc2dc114aa97abb8d99fb8c7120a4f2247590d42920c099c936a6f7b8`

Original Duo design-and-prompts.json identifies the source title "Fractionate Agent Vison Plan and Review" and thread `01a0d3b8-06f8-7fb2-9c6f-02ad48e753a9`. No chat URL was supplied or invented.
