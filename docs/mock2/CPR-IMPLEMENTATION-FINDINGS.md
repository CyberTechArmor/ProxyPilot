# CPR v1.1 — implementation findings ledger

CPR §20: v1.1 is frozen; findings are recorded here and evaluated for a later
revision, never folded into the standard silently. One row per finding:
observed behavior · current rule · proposed adjustment · reason · impact ·
disposition.

| # | Date | Observed | Rule | Proposed adjustment | Reason | Impact | Disposition |
|---|---|---|---|---|---|---|---|
| F-001 | 2026-09-05 | ProxyPilot deploys one dev slot per project; blue/green, Release Registry and no-build rollback are not implemented. Constitution §6 stage 5 says so explicitly. | §12 | Treat the dev URL as the *candidate* environment and the operator's verification as private review; implement slots in the CPR Base Platform starter, not in ProxyPilot. | Application lifecycle travels with the application (§3). | Promotion = operator marks the shipped build verified; rollback = redeploy of the previous commit (a rebuild, which §12.3 says is not a rollback). | open |
| F-002 | 2026-09-05 | The reference host leaves `auth`, `identity`, `secrets` unbound (throw by name). | §5.1 | Ship a binding to the ProxyPilot auth component inside the `cpr-host` component once one project has exercised it. | Bind after reuse is demonstrated (§6.2). | Features needing auth call through the app's own middleware until bound. | open |
| F-003 | 2026-09-05 | `@cpr/*` are 0.1.0; the internal registry has no published packages; the component vendors sources. | §8 | Publish 0.1.0 to the registry from `cpr-starter` and switch the component's imports to the packages. | One canonical source per package (§9). | Two copies of the contract until then; the component README says which wins. | open |
| F-004 | 2026-09-05 | The battery has no boundary/manifest analysis (declared vs actual dependencies). | §10.1 | Add a `manifest-boundary` check: every `src/features/*/feature.manifest.json` validates; imports outside `src/cpr/host-sdk.ts` + declared feature dependencies are reported. | Boundaries are executable (§3). | Report-only first (rule 0), promotion-blocking later by decision. | open |
