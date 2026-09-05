# CPR — Continuous Production Readiness v1.1 (vendored)

This directory carries the operator's **CPR v1.1** standard and the pieces of it
ProxyPilot ships to projects. CPR is the development-first engineering standard
the Mock2 framework builds on: production readiness governs *promotion*, never
whether a capability may be built or tested (CPR §3.1, §11.3; Mock2 constitution
rule 0).

| File | What it is |
|---|---|
| `CPR-v1.1.md` | The full standard, rendered from the operator's `Continuous_Production_Readiness_v1.1.docx`. Text unchanged; formatting converted. The same file is published on the Mock2 standards site (`core/cpr/CPR-v1.1.md` in `mock2/mock2-core`) and installed to developer machines as `~/.mock2/standards/CPR-v1.1.md`. |
| `feature.manifest.example.json` | A worked `feature.manifest.json` (CPR §7, Appendix B) validated by the manifest schema in the component below. |
| `../cpr-host.component.json` | The **CPR Host** ProxyPilot component: the Host Contract (§5.2), the Host SDK seam (§5.3), the feature-manifest schema + validator (§7/Appendix B), and a reference host adapter (db, config, jobs with advisory locks, outbound with SSRF guard, structured log, audit) for a Mock2 project. Seeded into the component library at boot (`component-seed.js`) so a build can adopt it with `materialize_component`. |

Source of the code: the `cpr-starter` reference host (`starter.fractionate.ai`,
`@cpr/host-contract` / `@cpr/host-sdk` / `@cpr/manifest-schema` **0.1.0**, published
to the internal registry at `10.185.17.239:4873`). The component vendors the three
libraries as single modules under `src/cpr/` so a project carries one copy of the
contract; when the `@cpr/*` packages are consumed from the registry instead, the
import paths are the only change.

## How CPR relates to the Mock2 framework here

- **Constitution §0 / §13** — rule 0 (no invented gates; classify production-policy
  questions) and the CPR section (features consume host capabilities, declare a
  manifest, never read `process.env`, namespaced permissions, expand → migrate →
  contract, decisions are durable).
- **Gate battery** — the deterministic battery is the automated half of the
  production checklist (CPR §10.1). `security-scan` treats a committed secret as a
  hard stop (CPR §11.2 non-waivable) and the dependency audit as a recorded
  WARNING (CPR §10.2), never as a reason to refuse a build.
- **Change records** — the hash-chained record is the Change Evidence report
  (Appendix C); the review skill is the independent AI reviewer (§10.3).
- **Release control** — ProxyPilot deploys a project's *dev* URL. Blue/green
  candidate slots, the Release Registry and no-build rollback (§12) are the CPR
  Base Platform's job and are **not** implemented by ProxyPilot; the constitution
  says so rather than pretending.

## Versioning

CPR v1.1 is frozen (CPR §20). Implementation findings go to
`docs/mock2/CPR-IMPLEMENTATION-FINDINGS.md`, not into this file. A new CPR revision
lands here as a new file (`CPR-v1.2.md`) plus a framework-seed change, which
`upgradeFrameworkFromSeed` publishes as a new framework version on the next boot.
