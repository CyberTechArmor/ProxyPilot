# Continuous Production Readiness (CPR) — v1.1

**AI-Assisted Software Development, Packaging, and Delivery Standard**
Version 1.1 • Development Freedom and Release Registry Revision

> Build rapidly. Stay production-ready.
> A standard for fast, cohesive, AI-assisted development with production-parity staging, portable features, automated assurance, and controlled release.

Status: v1.1 operational baseline for review, implementation, and measured refinement.

> Source: the operator's *Continuous Production Readiness v1.1* document (Fractionate, 2026). Rendered to Markdown for the Mock2 standards site and ProxyPilot's vendored framework seed; the document text is unchanged, only the formatting was converted. Companion Mock2 rule: `mock2-cpr.md`.

# 1. Executive Summary

> **30-second overview** Continuous Production Readiness (CPR) is an AI-assisted software engineering standard designed to let teams move quickly without leaving production readiness behind. It combines a reusable base platform, consistent technology choices, portable feature packages, automated assurance, production-parity blue/green staging, explicit promotion, and fast no-build rollback. The result is faster development, less integration friction, virtually no application downtime during routine releases, and a familiar experience that carries learning from one project to the next.

CPR is intentionally development-first. Developers and AI agents are expected to implement, execute, integrate, and test complete functionality early, including real execution paths when intentionally invoked. Production readiness controls unrestricted production operation and promotion; it does not determine whether a capability may be built or tested. Unresolved production-specific requirements are captured as readiness items rather than turned into unapproved gates. Production control happens through automated evidence, standardized architecture, blue/green candidate testing, risk-based governance, and an explicit promotion decision.

## Major benefits

- Virtually no downtime during normal code releases through candidate-first blue/green deployment and atomic promotion.
- A real staging experience with production parity, allowing test users to validate the exact candidate before public promotion.
- **Fast rollback to the previous known-good release without rebuilding source.**
- Defined guardrails for AI-assisted development, including architecture rules, automated assurance, independent AI review, and evidence generation.
- Developer testing cannot be disabled by inferred production policy; unknown policy questions remain configurable recommendations or Production Readiness Checklist items until explicitly approved.
- Portable, versioned feature packages that can be moved across compatible servers and applications.
- A reusable Base Platform that prevents every project from rebuilding authentication, authorization, database access, jobs, observability, deployment, and other foundational capabilities.
- A consistent technology baseline so developers work in a cohesive environment, integrate more easily, and carry knowledge and familiar user patterns from project to project.
- A scalable model for multiple developers or AI agents to work on different servers without continuously editing the same application core.

## v1.1 status

Version 1.1 is the current operational baseline. It materially strengthens CPR's development-first rule: production-readiness concerns may not be converted into unapproved development or testing gates. It also formalizes a user-visible Release Registry for exact artifact rollback and development from historical release commits. Future implementation findings should be recorded separately and evaluated for later revisions rather than silently changing v1.1 during rollout.

# Contents

1. Executive Summary
2. Purpose, Scope, and Normative Language
3. Core CPR Principles
4. Reference Architecture and Technology Baseline
5. Base Platform, Host Contract, and Host SDK
6. Feature and Extension Architecture
7. Feature Packaging Standard
8. Versioning and Compatibility
9. Multi-Server and Multi-Developer Integration Model
10. Automated Assurance and AI Review
11. Production Readiness and Exceptions
12. Blue/Green Release and Promotion Standard
13. Database Standard
14. Security Standard
15. Recovery and Rollback Standard
16. Incident and Hotfix Standard
17. Governance and Roles
18. Greenfield Adoption Standard
19. Existing-System Migration Standard
20. Standard Versioning and Implementation Review
A. Appendix A — Required Repository Artifacts
B. Appendix B — Feature Manifest Minimum Schema
C. Appendix C — Change Evidence Template
D. Appendix D — Production Readiness Template
E. Appendix E — Exception Template
F. Appendix F — Risk Classification
G. Appendix G — Architectural Decision Record Template

# 2. Purpose, Scope, and Normative Language

## 2.1 Purpose

CPR establishes a repeatable method for designing, building, validating, packaging, integrating, staging, releasing, and recovering software in an AI-assisted development environment. It is intended to make safe engineering the default path while preserving rapid iteration.

## 2.2 Scope

- **Greenfield web applications built from the approved Base Platform.**
- **Existing applications progressively migrated into the CPR architecture.**
- AI-assisted development performed directly on development servers or workspaces.
- Feature development performed by multiple developers or AI agents on separate servers.
- **Portable feature packages and shared platform extensions.**
- Candidate-first blue/green deployment with private review before production promotion.
- Shared-database environments where active, candidate, and rollback releases may temporarily use the same schema.

## 2.3 Normative language

| **MUST / MUST NOT** | Mandatory for CPR compliance unless an explicit exception process applies. |
|---|---|
| **SHOULD / SHOULD NOT** | Strong default. Deviation requires a documented reason. |
| **MAY** | Permitted but optional. |
| **BLOCK** | May stop only the specifically stated integration, destructive operation, candidate promotion, or unrestricted production action until resolved or, where permitted, excepted. It must not be generalized into disabling unrelated development/test execution. |
| **WARNING** | May continue at the current stage. The item remains visible and may become a blocker for a later production/release decision; it does not disable intentional developer testing. |

## 2.4 Primary lifecycle

1. Develop
2. Analyze
3. Validate
4. AI Review
5. Build Candidate
6. Private Review
7. Promote
8. Verify

# 3. Core CPR Principles

Development first; production readiness second: The requested capability MUST remain implementable and intentionally testable even when production policy, configuration, approvals, or operating rules are unresolved. Production-readiness concerns control production operation and promotion, not developer access to the feature's real execution path.
**Production readiness is continuous:** Architecture, testing, compatibility, security, packaging, deployment safety, and recoverability are maintained throughout development rather than added only at the end.
**Commit is not release:** A commit or push creates source history. Promotion of a validated candidate is the production release decision.
**Automation verifies; humans govern:** Tooling and AI perform code-level assurance. Humans govern intent, risk, exceptions, architecture boundaries, and high-risk production decisions.
**The tested artifact is the promoted artifact:** The exact immutable candidate that passed validation and private review must be the artifact promoted to production.
**Features consume capabilities; they do not recreate the platform:** Authentication, authorization, database access, jobs, audit, storage, configuration, deployment, and other common services are host responsibilities.
**Boundaries are executable:** Architecture rules should be enforced through project boundaries, manifests, dependency constraints, tests, and tooling wherever practical.
**Released artifacts are immutable:** Released package versions, migrations, and application images may not silently change after publication.
**Expand → migrate → contract:** Breaking database, API, and platform capability changes should preserve backward compatibility during transition and remove old behavior later.
**The standard path should be the easiest path:** Generators, SDKs, package tooling, and AI instructions should make compliant development easier than bypassing the standard.
Application lifecycle travels with the application: Blue/green slot control, candidate review, promotion, rollback, migration sequencing, package lifecycle, and active-release job ownership belong to the CPR Base Platform/application, not to the infrastructure provider. A CPR application SHOULD retain these capabilities when moved to another compatible host.
Decisions are durable: Material architectural decisions MUST be recorded in a repository decision ledger or ADR mechanism. Current runtime evidence describes what exists; it MUST NOT silently supersede an active architectural decision.

## 3.1 Development Freedom and No Invented Gates

- AI planners, implementation agents, generated contracts, and downstream prompts MUST NOT invent business-policy gates, recipient restrictions, environment restrictions, approval requirements, feature flags, allowlists, disabled execution paths, or other controls merely because they appear prudent.
- A development or testing restriction may be mandatory only when it is explicitly required by the user or an approved decision record, technically required by the external system, or necessary to prevent the exact requested action from causing an immediate destructive effect outside the intended test scope. The reason MUST be specific and evidenced; broad inferred notions of "unsafe" are not sufficient.
- Unknown production-policy questions MUST be classified as one of: IMPLEMENTATION REQUIREMENT, CONFIGURABLE CAPABILITY, PRODUCTION READINESS ITEM, or RECOMMENDATION. Only an explicitly approved IMPLEMENTATION REQUIREMENT may block completion of the requested feature.
- A RECOMMENDATION or PRODUCTION READINESS ITEM MUST NOT silently become a requirement in a later prompt, contract, implementation phase, or AI session. Graduation to a requirement requires an explicit recorded decision.
- Where a production control may be desirable, the preferred default is to preserve the full capability and make the control configurable or record it on the Production Readiness Checklist. Do not disable the underlying feature solely because the policy decision is unresolved.
- Intentional testing in the production environment MAY be performed by an authorized operator when needed to validate the actual production path. Production policy MUST distinguish intentional bounded test execution from unrestricted automated production operation.

# 4. Reference Architecture and Technology Baseline

CPR standardizes the foundational environment so developers and AI agents are not solving the same infrastructure problem differently on every project. The v1.1 baseline is intentionally opinionated but may be revised through the platform change process.

| **Layer** | v1.1 baseline | **Purpose** |
|---|---|---|
| Frontend | React + TypeScript | Consistent component model, typing, reusable UI patterns, and shared developer experience. |
| Backend | Node.js + TypeScript + Express-compatible HTTP layer | Consistent API/runtime model and shared contracts. |
| Database | PostgreSQL | Transactional relational system with standardized migration, connection, and observability behavior. |
| Packaging / workspace | Nx + CPR tooling | Project graph, dependency boundaries, affected validation, generators, and release orchestration. |
| Containers | Docker / Compose-compatible deployment | Immutable runtime artifacts and repeatable environments. |
| Gateway | NGINX-compatible reverse proxy | Stable public entry, TLS/realtime proxying, and forwarding to the CPR application supervisor. The infrastructure gateway MUST NOT own application blue/green slot selection. |
| Realtime | WebSocket / SSE through host capability | Reconnectable, authenticated, lifecycle-aware realtime behavior. |
| Observability | Structured logs + metrics/traces capability | Release identity, runtime health, diagnostics, and candidate comparison. |

> **Technology consistency is a productivity feature** A shared stack is not intended to prohibit innovation. It is intended to preserve transferable knowledge, common tooling, predictable AI guidance, reusable UI and infrastructure, easier integration, and a familiar experience across projects. Exceptions should be deliberate rather than accidental.

# 5. Base Platform, Host Contract, and Host SDK

## 5.1 Base Platform

Every new CPR application SHOULD start from a versioned Base Platform rather than from an empty application. The Base Platform provides cross-project capabilities that should not be repeatedly rebuilt.
- Application shell, routing, navigation registry, loading/error behavior, and design-system primitives.
- **Authentication, session management, identity, and authorization/RBAC.**
- Database connections, transactions, migration execution, query timeouts, and database health.
- **Configuration and secret lookup.**
- **Structured logging, audit, request correlation, and redaction.**
- Background-job registration, singleton ownership, overlap prevention, retry policy, lifecycle drain, and telemetry.
- Realtime registration, authentication, reconnect/resume behavior, and shutdown handling.
- **Storage and upload abstraction.**
- **Outbound HTTP/integration capability with timeout and security controls.**
- **Health, readiness, release identity, and observability.**
- Package manager, capability registry, compatibility validation, and package catalog integration.
- **Blue/green release tooling and evidence generation.**

## 5.2 Host Contract

The Host Contract is the formal declaration of capabilities a feature may depend on. It is versioned independently from business features and SHOULD be machine-readable.

## 5.3 Host SDK

Features MUST consume host capabilities through stable Host SDK interfaces or other documented public contracts. Direct imports of host implementation internals are prohibited unless explicitly authorized as a platform change.

> **Example** A feature may call host.auth.currentUser(), host.audit.record(), host.jobs.register(), or host.storage.put(). It should not import private authentication controllers, create an unmanaged PostgreSQL pool, start an independent scheduler, or write directly into another feature’s internal storage.

# 6. Feature and Extension Architecture

## 6.1 Layered ownership model

| **Layer** | **Contains** | **May know about** |
|---|---|---|
| Infrastructure Substrate | Compute/guest lifecycle, host networking, storage substrate, and stable external routing | Infrastructure-specific operations and host-level concerns; never application slot state, feature behavior, package policy, or business concepts. |
| Base Platform | Universal infrastructure and host capabilities | Contracts, platform internals; never business-specific concepts. |
| Shared Extension | Reusable but non-universal capability such as communications, workflow runtime, document processing, or data connectors | Host capabilities, public contracts, explicitly declared extensions. |
| Feature Package | Business functionality such as Upload Doc, Flow Builder, Time Reconciliation, or List Builder | Host SDK, declared extensions, declared public feature dependencies. |

The infrastructure substrate is replaceable. It provides the environment in which CPR runs, while the Base Platform owns application lifecycle behavior. Infrastructure tooling MAY provision, invoke, or observe CPR operations, but MUST NOT duplicate or become the authoritative implementation of CPR package installation, candidate management, blue/green promotion, application rollback, migration sequencing, or active-release job ownership.

## 6.2 Upward Promotion Rule

A capability SHOULD begin inside a feature unless broad reuse is already established. When multiple features demonstrate the same business-neutral need, the capability may be promoted into a shared extension or Base Platform through the platform change process.

## 6.3 Downward Business Rule

Business-specific concepts MUST remain outside the Base Platform. The platform may expose generic permissions, data, job, event, and storage capabilities, but it must not know domain concepts merely for convenience.

## 6.4 Namespaces

- **Each feature MUST own a stable feature ID and namespace.**
- Routes, permissions, database objects, jobs, events, configuration keys, navigation IDs, and extension contributions SHOULD be namespaced.
- Namespace collisions MUST block package integration unless the relationship is an intentional declared extension.

## 6.5 Extension points

Packages SHOULD extend the application through defined contribution points rather than modifying the owning feature or application core. Examples include navigation entries, workflow node types, settings panels, provider adapters, jobs, event handlers, dashboards, and API routes.

# 7. Feature Packaging Standard

## 7.1 Dependency classification

| **PACKAGE** | Code, migrations, assets, tests, and contracts that belong specifically to the feature and travel with it. |
|---|---|
| **HOST** | Capabilities supplied by the Base Platform or Host SDK. They are declared, not copied. |
| **EXTERNAL** | Third-party libraries, APIs, providers, or infrastructure outside the host. |

## 7.2 Required package artifacts

- **feature.manifest.json**
- **Feature source/payload limited to package-owned content.**
- **Feature requirements or acceptance criteria where material.**
- **Feature migrations and database ownership metadata.**
- **Public contracts and declared extension points.**
- **Tests and package validation targets.**
- Build provenance, checksums, migration hashes, SBOM for released packages, and change evidence.
- Readme/operational notes sufficient to understand the feature without reading private host implementation.

## 7.3 Package analysis

Before extraction or release, tooling/AI MUST analyze the feature dependency graph. The objective is not to recursively copy every import. The objective is to identify the boundary between feature implementation, host capability, shared extension, and external dependency.

## 7.4 Package lifecycle

1. Create
2. Develop
3. Analyze
4. Validate
5. Build
6. Publish
7. Import
8. Integrate
9. Candidate
10. Promote

Released package versions are immutable. Modifying released behavior requires a new version. Package removal is asymmetric: runtime/code may be removed or disabled, but feature data is retained unless an explicit data cleanup process authorizes destruction.

## 7.5 Website and CLI integration

CPR supports both developer/AI tooling and a web-based package manager. Both interfaces MUST use the same underlying package engine. The browser is a control plane; it must not receive unrestricted filesystem, database, or shell authority.

# 8. Versioning and Compatibility

CPR uses explicit versioning across Base Platform, Host capabilities, shared extensions, and feature packages. Compatibility must be declared and tested rather than assumed.

| **Change** | **Meaning** | **Default expectation** |
|---|---|---|
| PATCH | Backward-compatible defect correction | Existing consumers continue to work. |
| MINOR | Backward-compatible capability addition | Existing consumers continue to work; new consumers may use the new capability. |
| MAJOR | Breaking contract or behavior change | Consumers may require migration or upgraded dependencies. |

- **Released versions MUST be immutable.**
- Packages MUST declare supported Base Platform/Host capability ranges; wildcard compatibility is prohibited for release packages.
- Candidates MUST record exact resolved package versions in a lock/composition record.
- Minor and patch Host releases SHOULD preserve compatibility inside the same major version.
- Deprecated APIs SHOULD provide a migration period before removal in a later major version.
- Compatibility analysis MUST run before Base Platform or shared-extension upgrades.
- Pre-release/dev package versions MAY be exchanged during development but must be clearly marked as non-release artifacts.

# 9. Multi-Server and Multi-Developer Integration Model

CPR is designed so multiple developers or AI agents can work on separate servers without repeatedly editing the same application core. Developers must agree on compatible Host Contracts and package standards rather than identical local application states.

1. Base Platform
2. Dev Server A
3. Feature A Package
4. Integration
5. Blue/Green Candidate
6. Production

Parallel servers may build different features independently. Integration occurs by importing versioned packages into a canonical composition, resolving compatibility and conflicts, running combined assurance, and building one exact candidate release.
- **Each feature has one canonical development source and package owner.**
- **Installed package copies are dependencies, not alternate sources of truth.**
- Feature-to-feature dependencies MUST be public and declared; hidden imports are prohibited.
- Platform changes are versioned platform changes, not silently bundled into feature packages.
- Integration MUST detect route, permission, schema, job, event, navigation, and dependency collisions.
- The exact integrated package set MUST be locked and recorded in the candidate release.

# 10. Automated Assurance and AI Review

Because CPR may operate without traditional senior line-by-line code review, assurance is evidence-driven. Automated checks and independent AI review provide the primary code-level verification; the System Steward governs architecture, risk, exceptions, and promotion.

## 10.1 Mandatory assurance categories

| **Category** | **Requirement** |
|---|---|
| Implementation/requirements | Verify requested behavior exists and material requirements are traceable. |
| Type/build | Compile/typecheck and produce the intended artifact. |
| Lint/static analysis | Detect rule violations, unsafe patterns, dead code, and boundary violations. |
| Unit/integration tests | Verify isolated logic and cross-component behavior. |
| Contract tests | Verify Host SDK and declared public interfaces. |
| Boundary/manifest | Compare actual dependencies with declared dependencies and block private cross-boundary imports. |
| Migration safety | Classify database changes and verify rollback compatibility. |
| Security | Secret scan, dependency scan, authorization/input/outbound/file handling review. |
| Install/upgrade/coexistence | Verify package lifecycle and compatibility with the target host and representative neighboring packages. |
| Candidate smoke/runtime | Verify the exact candidate starts, identifies itself, and satisfies critical runtime health checks. |
| Independent AI review | A separate review context challenges architecture, behavior, security, data, deployment, and compatibility. |
| Change evidence | Summarize the result in a steward-readable record. |

## 10.2 Outcomes

| **PASS** | Requirement satisfied. |
|---|---|
| **WARNING** | May continue at the current stage. The item remains visible and may become a blocker for a later production/release decision; it does not disable intentional developer testing. |
| **BLOCK** | May stop only the specifically stated integration, destructive operation, candidate promotion, or unrestricted production action until resolved or, where permitted, excepted. It must not be generalized into disabling unrelated development/test execution. |

## 10.3 Independent AI review

The implementation agent MUST NOT be the sole authority declaring its own work correct. A separate review context SHOULD receive requirements, relevant standards, changed files, manifest, dependency impact, and test results and be instructed to find failure modes rather than implement features. Findings are corrected and validation rerun.

## 10.4 Test integrity

AI MUST NOT resolve failures by weakening tests or requirements without making the change explicit. Material test changes must appear in the evidence record with a reason and impact assessment.

## 10.5 Planning and Prompt Inheritance

- When a flagship/planning AI creates a multi-phase plan, implementation contract, or series of downstream prompts, it MUST preserve CPR's development-first rule in every generated artifact.
- Uncertainties, recommendations, possible best practices, and risk observations MUST NOT be converted into mandatory gates unless an explicit approved decision authorizes the restriction.
- Each downstream prompt SHOULD distinguish: approved implementation requirements; configurable capabilities; Production Readiness items; optional recommendations; and explicit blockers that arise from verified technical incompatibility rather than inferred policy.
- A downstream prompt MUST NOT prohibit real feature execution merely because production configuration, governance, recipient policy, quiet hours, rate limits, retention rules, or similar operating decisions are pending.
- AI completion evidence SHOULD state whether any new execution gate was introduced and cite the explicit requirement or decision that authorized it.

# 11. Production Readiness and Exceptions

## 11.1 Readiness stages

| **Stage** | **Meaning** | **Typical gate** |
|---|---|---|
| Development Ready | Can be fully built, invoked, and exercised by the developer/AI, including intentional real execution paths. | Core implementation/test path works; unresolved production policy/configuration remains non-blocking. |
| Integration Ready | Can coexist safely with the host and other packages. | Boundaries, compatibility, tests, manifest, security, and migration classification pass. |
| Candidate Ready | Can be deployed to the inactive blue/green slot for production-like review/testing. | Immutable build, rollback artifact, evidence, host compatibility, and safe candidate startup. |
| Production Ready | Eligible for public promotion. | Production secrets/configuration, auth, DB safety, jobs, critical integrations, and blockers resolved. |
| Production Verified | Promoted release demonstrated healthy public/runtime behavior. | Post-switch health, release identity, jobs, DB, realtime, and critical workflows verified. |

## 11.2 Exceptions

- **No standard may be silently bypassed.**
- An exception MUST identify the rule, reason, scope, risk, mitigation, approver, evidence, expiration/review trigger, and follow-up item.
- **Exceptions SHOULD expire or be tied to a concrete condition.**
- The System Steward may approve permitted exceptions; AI may recommend but must not approve its own exception.
- Known credential exposure, unintentional auth bypass, unverifiable artifact identity, unsafe destructive data mutation without recovery, and similar foundational failures are non-waivable hard stops.
Production Readiness Checklists SHOULD be generated from the actual package capabilities. A UI-only package should not inherit irrelevant communications or job requirements; a package declaring database/jobs/communications receives those readiness checks automatically.

## 11.3 Production Readiness Does Not Gate Development Testing

- Production Readiness Checklists govern whether and how a capability is placed into unrestricted production operation. They MUST NOT be implemented as a mechanism that prevents developers from building, invoking, integrating, or testing the requested capability.
- A BLOCK outcome may prevent a specific integration, candidate promotion, destructive migration, or unrestricted production operation. It MUST NOT erase or disable the feature's intentional test path merely because a production policy decision is unresolved.
- Examples such as quiet hours, recipient policies, frequency limits, approval workflows, production provider configuration, retention periods, and alert thresholds SHOULD remain configurable or checklist items until explicitly approved.
- For externally effectful capabilities, CPR SHOULD support intentional bounded test execution using the real provider/path when requested and technically available. The fact that an action targets a healthcare, financial, customer, or other sensitive-domain workflow does not by itself authorize AI to infer that the developer's test action is prohibited.

# 12. Blue/Green Release and Promotion Standard

Blue/green deployment is the default production release mechanism for CPR applications. CPR does not require a separate permanent staging server. The inactive slot MAY serve as the staging/test candidate environment, allowing authorized test users to validate the exact release on the live production host without changing normal public traffic. Routine release design aims for service continuity and virtually no application downtime during code updates.

## 12.1 Application-owned release control

Blue/green is a CPR application capability. The infrastructure provider supplies a stable host, stable addressing, and stable routing to the CPR application supervisor. The supervisor owns the blue and green application slots and decides which slot receives normal traffic and which slot is the private candidate.
- Promotion MUST NOT require DNS changes, infrastructure route-table changes, guest IP changes, or infrastructure-provider knowledge of the active slot.
- Infrastructure tooling MAY invoke or observe a CPR-owned deployment API/command, but the deployment policy and state MUST remain owned by the CPR Base Platform.
- A CPR application SHOULD preserve its blue/green, candidate-review, promotion, and rollback behavior when moved to another compatible hosting environment.

## 12.2 Candidate and promotion rules

1. Commit / Push
2. Immutable Build
3. Inactive Slot
4. Private Test Users
5. Explicit Promotion
6. Public Verify

- **A push or successful build MUST NOT automatically change the public route.**
- **Only the inactive blue/green slot receives the new candidate.**
- The candidate MUST expose exact release identity and pass readiness/internal smoke checks before review.
- Private review SHOULD allow authenticated test users to validate the actual candidate against production-parity infrastructure, including intentional execution of real feature paths where authorized. Candidate controls SHOULD prevent accidental unrestricted production automation, not disable requested test execution.
- **Health is not approval; promotion is an explicit authorized action.**
- Promotion SHOULD use an atomic/validated application-supervisor switch with bounded drain of the previous web/realtime processes. The stable infrastructure route SHOULD remain unchanged.
- Post-switch verification MUST check public health, correct release identity, and critical runtime signals.
- If verification fails, the CPR application supervisor SHOULD revert to the retained known-good slot without rebuilding source.
- Candidate/private services MUST remain non-public except through explicitly controlled review access. Review routing MAY reach the same application guest, but candidate-slot selection remains application-owned.
- Jobs ownership MUST be coordinated separately so active and candidate web slots do not duplicate external side effects.

> **Production parity.** The staging value of blue/green is strongest when the candidate uses the same application architecture, configuration model, shared services, compatible database state, and CPR supervisor model as production. The infrastructure substrate may differ by environment, but it should expose the same required host conditions. The goal is to test the exact release in the environment it would actually run in, not a loosely similar build.

## 12.3 Release Registry and Frontend Release History

- The CPR Base Platform SHOULD maintain a durable Release Registry and expose a human-readable frontend release history. Operators and AI agents should be able to identify exactly what is running, what previously ran, and which retained artifacts remain eligible for rollback.
- Each release record SHOULD include: release ID/version; Git commit SHA; immutable artifact/image digest; date/time; concise human description; exact package composition/lock; migration identities; validation/evidence reference; creator/promoter identity; status (candidate/current/previous/retained/unavailable); and rollback compatibility/availability.
- The frontend SHOULD provide actions such as View Details, View Changes, Copy Commit SHA, and Roll Back to This Release where the retained artifact and current schema are compatible.
- Rollback is an artifact operation, not a source rebuild. Selecting a historical rollback target MUST reuse the retained immutable artifact when available; it MUST NOT silently rebuild the historical commit and call that a rollback.
- A historical release MAY also be used as a development baseline. The UI SHOULD expose or make easy to copy the source commit SHA so a developer/AI can intentionally create a new branch from that commit, make new changes, build a new candidate, and release it through the normal CPR lifecycle.
- Branching from a historical release MUST NOT alter production state. It creates new development history; any resulting release receives a new identity and must pass normal candidate validation and promotion.

# 13. Database Standard

## 13.1 Ownership

- The Base Platform owns database connectivity, pooling, transactions, timeouts, migration execution, health, and backup integration.
- Each feature owns its tables/data model, indexes, queries, migrations, and data semantics.
- Shared database objects MUST have explicit ownership and documented public contracts.

## 13.2 Migration rules

- Every schema change MUST be represented by a migration; undocumented production schema edits are prohibited.
- **Released/applied migrations are immutable and SHOULD have recorded hashes.**
- Every migration MUST be classified as additive/backward-compatible, transition/data migration, post-promotion contraction, or destructive/high-risk.
- Automatic candidate migrations SHOULD be additive and compatible with active, candidate, and rollback releases.
- **Breaking change is implemented using expand → migrate → contract.**
- Objects required by the active or rollback release MUST NOT be dropped during the shared-schema transition window.
- Historical migrations MUST NOT be blindly replayed against an existing system with uncertain migration history; establish a verified baseline instead.
- Large data backfills SHOULD be separated from startup migration when their duration or locking risk is material.
- High-risk migrations MUST verify preconditions and have recovery evidence before execution.
- **Package removal MUST NOT automatically drop feature data.**

## 13.3 Runtime data access

- Features MUST use the host database capability rather than unmanaged connections.
- **Queries and transactions MUST be bounded with appropriate timeouts.**
- **Sensitive values MUST be minimized/redacted in logs and evidence.**
- External connectors designated read-only MUST remain write-disabled at the platform and transaction level where practical.
- Arbitrary browser-provided SQL is prohibited unless it is an explicitly designed, authorized, and constrained capability.

# 14. Security Standard

Security is primarily inherited from the Base Platform. Features declare their needs and use protected host capabilities instead of independently inventing authentication, secret handling, logging, upload behavior, or outbound access.
- **Host-owned authentication and session management.**
- **Host-owned authorization/RBAC with namespaced feature permissions.**
- Least-privilege host capabilities, permissions, storage, database scope, and outbound access.
- Secrets remain server-side and must not appear in source, package payloads, client bundles, logs, screenshots, evidence, or generated documentation.
- Commits and release packages are scanned for secrets and restricted sensitive data.
- API inputs, uploads, configuration, provider payloads, and package manifests are validated.
- Outbound HTTP uses the host capability with timeouts, SSRF protections, authentication hooks, and safe logging.
- Uploads use standardized file-size/type validation, safe naming, storage isolation, permissions, and malware scanning when risk requires it.
- Dependencies are scanned for known vulnerabilities and prohibited/high-risk packages.
- Released packages include verifiable source identity, checksum/signature policy, manifest integrity, dependency lock, SBOM, and provenance as required by the release profile.
- Packages use declarative installation actions; unrestricted root-level installer scripts are prohibited by default.
- Administrative, data-export, configuration, permission, package, provider, and release actions are auditable.
- Structured redaction prevents credentials, tokens, protected data, and raw sensitive payloads from entering normal logs.
- Auth, permissions, secrets, storage, package runtime, deployment controls, and other sensitive changes receive explicit independent AI security review.
- Critical/high security findings normally block unrestricted production promotion; lower findings are risk-evaluated and tracked. Security findings MUST NOT be generalized into invented development/test prohibitions unrelated to the exact finding.

# 15. Recovery and Rollback Standard

CPR separates fast application rollback from deliberate data recovery. Routine release failure should normally be recoverable by routing back to a retained artifact, not by rebuilding source or restoring the entire database.
- **Retain the current and previous verified application/package compositions.**
- **Normal rollback is no-build: route back to the retained known-good release.**
- Candidate/release records MUST include exact Base Platform, extension, feature, source SHA, and image/package identities.
- Jobs MUST be restored/transferred to a release compatible with the active application/database state.
- Database schema evolution MUST preserve rollback compatibility through the defined rollback window.
- **Package rollback is a version rollback, not manual file deletion.**
- Feature disablement MAY be used as a bounded recovery mechanism while retaining data.
- Critical configuration changes SHOULD be versioned/audited sufficiently to reconstruct or revert them.
- Database backup restoration is an exceptional recovery operation, not the normal deployment rollback mechanism.
- Irreversible/destructive operations require explicit recovery evidence before execution.
- After rollback, verify public release identity, application health, jobs, database, realtime, and critical integrations.
- If normal rollback fails, stop improvising repeated production changes and enter incident mode.

> **Core recovery principle** Code rollback should be fast and routine. Data recovery should be rare, deliberate, and evidence-driven.

# 16. Incident and Hotfix Standard

Incident mode may shorten the path to recovery but must preserve traceability. Emergency work is not permission to abandon artifact identity, database safety, or the ability to understand what changed.
- **Declare the incident/hotfix context and affected system.**
- Stabilize first when possible: rollback routing, disable the failing feature, stop the problematic job, or restore the previous known-good release.
- Prefer rollback before writing new emergency code when a known-good artifact can restore service.
- Create the hotfix from the known production state, not from unrelated unfinished work.
- **Make the smallest bounded change that resolves the incident.**
- **Perform focused AI root-cause review before broad redesign.**
- Run all feasible relevant assurance: build/typecheck, focused tests, security checks, migration analysis, and artifact/package integrity.
- If urgency requires temporarily reducing test scope, record omitted checks and complete them after stabilization.
- **Build an immutable hotfix artifact with exact source identity.**
- Use the inactive blue/green slot and private candidate test whenever operationally feasible.
- Database hotfixes receive heightened scrutiny and destructive emergency migrations should be avoided.
- **All exceptions and skipped controls become explicit post-incident follow-up.**
- After stabilization, run full required validation and conduct a post-incident review.
- Where possible, convert lessons into automated tests, platform safeguards, or standard updates rather than relying on memory.

> **Incident principle** An emergency may shorten the path, but it must not destroy traceability.

# 17. Governance and Roles

CPR is designed for organizations that may not have a traditional senior engineer reviewing every line of code. Governance therefore separates code-level assurance from human system judgment.

| **Role** | **Primary responsibility** |
|---|---|
| Developer | Understands the requested outcome, functionally tests work, stays within assigned boundaries, and surfaces unclear requirements. Not expected to manually audit every implementation detail. |
| AI Implementer | Reads standards/Host Contract, implements requirements, uses Host SDK capabilities, maintains manifests/tests, and runs assurance. |
| AI Reviewer | Operates in an independent review context and challenges behavior, architecture, security, data, deployment, compatibility, and requirements coverage. |
| System Steward | Human system governor. Reviews scope, architecture placement, risk, evidence, exceptions, platform changes, and high-risk promotion decisions rather than line-by-line code. |
| Package Owner | Maintains the canonical source/version lineage for a feature or shared extension. |
| Production Approver | Confirms blockers, warnings/exceptions, candidate identity, rollback availability, and authorizes promotion. May be the System Steward in v1.1. |

## 17.1 Governance principles

- **Automation verifies; humans govern.**
- **Architecture decisions and exceptions are explicit and reviewable.**
- AI may recommend risk classifications and platform changes but must not silently approve its own exception or high-risk production action.
- High-impact actions such as destructive data changes, major authentication/security changes, and platform contract breaking changes require human authority.
- **Production promotion remains explicit.**
- **Standards themselves are versioned and changes require rationale.**

## 17.2 Architectural decision governance

Material architectural decisions MUST be durably recorded in the repository or a linked authoritative decision system. The record exists to prevent later implementation work, AI reasoning, or runtime evidence from silently re-opening a decision that was already closed.
- A decision record SHOULD include a stable ID, date, status, decision, rationale, what it supersedes, affected systems/artifacts, and revisit trigger where applicable.
- Active decisions MUST be checked before architecture design, platform changes, package-boundary changes, infrastructure ownership changes, or release-control changes.
- If new work conflicts with an active decision, AI or tooling MUST either follow the decision or explicitly propose that it be superseded. It MUST NOT silently replace it.
- Current code and runtime evidence are evidence of present state, not automatic authority for intended architecture.

## 17.3 Decision precedence for AI-assisted work

When sources conflict, CPR uses the following default precedence unless a higher-level policy states otherwise:
1. Current explicit decision record and approved standards/contracts.
2. Current task requirements and authorized change scope.
3. Repository implementation and tests.
4. Current runtime evidence and operational observations.
5. Historical conversation, prior prompts, and assumptions.
AI completion evidence SHOULD report relevant decisions followed, decisions affected, any proposed supersession, and unresolved contradictions.

# 18. Greenfield Adoption Standard

New applications SHOULD begin from the approved CPR Base Platform Starter rather than recreate architecture from scratch.
- **Assign a Base Platform/Host Contract version at project creation.**
- Provision environment-specific configuration, secrets references, database, storage, and stable infrastructure routing; install the CPR Base Platform so the application-owned supervisor, blue/green slots, jobs runtime, health, and observability are created consistently.
- Start with business features absent; install shared extensions only when required.
- Include the human standard, AI Implementer guide, AI Reviewer guide, package tooling, schemas, templates, and an architectural decision ledger/ADR mechanism in the repository.
- **Run a clean-platform baseline validation before business development begins.**
- **Create an initial immutable baseline release identity.**
- New features MUST follow CPR boundaries from inception; greenfield projects receive no automatic grandfathering for private cross-feature imports, unmanaged DB pools, ad hoc schedulers, hard-coded secrets, or undeclared routes/permissions.
- If a required host capability is missing, AI should create a platform capability request rather than silently modify platform internals as part of feature work. Missing production-policy decisions should likewise be recorded as configurable capabilities or readiness items rather than turned into execution gates.

> **Greenfield objective** A developer should receive server access, the starter repository, VS Code/AI access, and project requirements. Architecture, authentication, database patterns, deployment, testing, packaging, and AI guidance are platform responsibilities.

# 19. Existing-System Migration Standard

Existing systems such as NRN should move to CPR incrementally. The migration must not require a large rewrite or development freeze.
- **Adopt the standards and target boundaries before moving code.**
- **Add Nx/CPR tooling around the existing application as a legacy project.**
- Document the current Base Platform capabilities and establish the Host Contract.
- Introduce Host SDK facades over existing auth, database, jobs, storage, audit, realtime, and configuration implementations.
- Enforce new-code dependency rules while grandfathering legacy violations as migration debt.
- Add the package manifest schema and require manifests for new or actively modified features.
- Inventory logical features and classify dependencies as PACKAGE, HOST, EXTERNAL, or shared extension.
- **Choose one practical extraction candidate and prove the model.**
- **Define feature ownership/public interfaces before moving every file.**
- **Gradually replace direct host/private imports with Host SDK/public contracts.**
- **Promote truly reusable capabilities upward only after reuse is demonstrated.**
- **Add automated manifest-vs-actual dependency analysis and assurance.**
- **Build and move at least one real feature package between compatible servers.**
- **Introduce the package catalog and composition lock.**
- Convert legacy features opportunistically when touched or when coupling becomes a practical problem.
- Retire legacy deployment/migration/import paths only after their CPR replacements are proven.

> **Migration policy** New work follows the target architecture immediately; existing work migrates when touched or when its coupling becomes a practical problem.

- Migration analysis MUST distinguish infrastructure-substrate responsibilities from CPR application responsibilities. Existing infrastructure-owned application deployment logic SHOULD be treated as a portability gap and migrated behind CPR-owned application interfaces rather than copied into the target CPR architecture.

# 20. Standard Versioning and Implementation Review

CPR v1.1 is the current operational standard. Version 1.1 materially revises the development-first contract by prohibiting unapproved AI-generated execution gates and adds the Release Registry/frontend release-history standard. The purpose of the implementation cycle remains to prove or challenge the standard with real evidence, not to continuously rewrite the rules during rollout.
- Freeze v1.1 as the implementation baseline after this revision is reviewed and approved for implementation.
- Record implementation findings separately in a V1_IMPLEMENTATION_FINDINGS.md or equivalent ledger.
- Each finding should record the observed behavior, current rule, proposed adjustment, reason, impact, and disposition.
- Clarifications and backward-compatible improvements after this baseline normally become v1.2, v1.3, etc.
- Material philosophy, architecture, package-contract, or compatibility breaks require a major version such as v2.0.
- Do not silently edit a frozen/released standard. Maintain version history and rationale. Material changes such as the v1.1 no-invented-gates rule require an explicit version increment and decision record.
- After sufficient implementation evidence, conduct a structured review of developer usability, AI behavior, package portability, integration friction, blue/green behavior, database safety, assurance effectiveness, and governance burden.

## 20.1 v1.1 success criteria

- **At least one Base Platform starter can be provisioned reproducibly.**
- At least one feature can be created, validated, packaged, moved to another compatible server, and integrated without undocumented host coupling.
- At least one combined candidate can be built, privately reviewed, promoted, verified, and rolled back using exact immutable artifacts.
- The Change Evidence Report is understandable to a System Steward who does not perform line-by-line code review.
- Database migration classification prevents unsafe shared-schema promotion behavior.
- AI Implementer and AI Reviewer instructions produce repeatable behavior without relying on bespoke prompting.
- **Observed friction and gaps are captured for post-v1.1 revision.**
- At least one real feature with an external side effect can be fully implemented and intentionally tested without an AI-generated production-readiness gate blocking the execution path.
- A planning AI can generate multi-phase implementation prompts without converting recommendations or unresolved production policy into mandatory development blockers.
- The Release Registry can identify current and retained releases by description, commit SHA, artifact identity, and package composition; a compatible retained release can be selected for no-build rollback.
- A historical release commit can be used as a development baseline without altering production state, and the resulting changes proceed as a new candidate/release.

# A. Appendix A — Required Repository Artifacts

A CPR-compliant repository SHOULD contain or link to the following artifacts. Exact paths may differ, but responsibilities should remain explicit.

| **Area** | **Minimum artifacts** |
|---|---|
| Human standards | ENGINEERING_STANDARD.md, DEVELOPER_GUIDE.md, SYSTEM_STEWARD_GUIDE.md |
| Architecture | BASE_PLATFORM.md, HOST_CONTRACT, FEATURE_STANDARD.md, EXTENSION_STANDARD.md, DEPENDENCY_RULES.md |
| Development | DEVELOPMENT_FIRST.md, TESTING_STANDARD.md, PACKAGE_STANDARD.md, VERSIONING_STANDARD.md |
| Production | PRODUCTION_READINESS.md, RELEASE_STANDARD.md, BLUE_GREEN_STANDARD.md, DATABASE_STANDARD.md, RECOVERY_ROLLBACK.md, INCIDENT_HOTFIX.md |
| Security | SECURITY_BASELINE.md, PACKAGE_SECURITY.md, DATA_HANDLING.md |
| Governance | ROLES.md, RISK_LEVELS.md, EXCEPTIONS.md, CHANGE_EVIDENCE.md, DECISIONS.md or ADR/decision ledger |
| AI | AI_IMPLEMENTER.md, AI_REVIEWER.md, AI_PACKAGE_GUIDE.md, AI_PLATFORM_CHANGE_GUIDE.md |
| Schemas/templates | feature manifest, host contract, change evidence, requirements, exception, ADR templates |
| Tooling | create/analyze/validate/review/evidence/build/inspect/publish/install/upgrade/compatibility/candidate operations |

# B. Appendix B — Feature Manifest Minimum Schema

| **Identity** | Feature ID, display name, owner, version, namespace. |
|---|---|
| **Compatibility** | Supported Base Platform and Host capability versions. |
| **Entry points** | Frontend routes/pages, backend routes, extension contributions. |
| **Dependencies** | HOST capabilities, shared extensions, feature dependencies, EXTERNAL services/libraries. |
| **Database** | Owned objects, migrations, migration classification, retention/cleanup notes. |
| **Security** | Permissions, secrets/config requirements, outbound hosts/services, data sensitivity. |
| **Runtime** | Jobs, realtime, storage, uploads, events, provider integrations. |
| **Navigation/UI** | Navigation registrations, settings panels, design-system expectations. |
| **Tests** | Required validation targets and requirement traceability. |
| **Lifecycle** | Install, upgrade, disable, removal behavior; data cleanup kept separate. |
| **Provenance** | Source commit, build identity, checksum/signature, SBOM, migration hashes for releases. |
| **Portability** | Self-contained status, required host capabilities, known coupling or constraints. |

# C. Appendix C — Change Evidence Template

| **Feature / package** | Name and version |
|---|---|
| **Purpose** | What changed and why |
| **Source identity** | Commit SHA / repository / build identity |
| **Risk level** | 1–4 plus explanation |
| **Host/platform changes** | None or explicit list |
| **Capabilities used** | Auth, DB, jobs, storage, audit, realtime, etc. |
| **Dependencies changed** | External/shared package version changes |
| **Database** | Migrations and safety classification |
| **Permissions/security** | New permissions, secrets, outbound access, security findings |
| **Tests** | Counts/results and material test modifications |
| **AI review** | Findings by severity; resolved/unresolved |
| **Readiness** | Warnings, blockers, production checklist items |
| **Rollback** | Previous known-good artifact and compatibility status |
| **Recommendation** | Development valid / Integration valid / Candidate eligible / Production eligible |

# D. Appendix D — Production Readiness Template

- **☐ Exact candidate identity and package composition recorded.**
- **☐ Required authentication and permissions verified.**
- ☐ Critical/high security findings resolved or, where permitted, explicitly excepted.
- **☐ Production configuration and secrets present.**
- **☐ Database changes classified and compatible with active/rollback releases.**
- **☐ Jobs ownership/coordination verified.**
- **☐ Realtime/storage/integration requirements verified where used.**
- **☐ Critical user workflows validated in the private candidate environment.**
- **☐ Rollback artifact available and compatible.**
- **☐ Warnings and exceptions visible to the Production Approver.**
- **☐ Public post-promotion verification plan defined.**
☐ Confirm unresolved operating-policy questions (for example quiet hours, frequency limits, recipient policy, approval workflow, retention, or alert thresholds) are visible as decisions/checklist items rather than hidden execution gates.
☐ Confirm the feature's intentional test path remains executable and is not disabled by inferred production policy.
☐ Confirm any production-only operating controls that are enabled were explicitly approved and are configurable where appropriate.

# E. Appendix E — Exception Template

| **Rule / gate** | Exact CPR requirement being bypassed |
|---|---|
| **Reason** | Why proceeding is necessary |
| **Scope** | Feature, version, candidate, environment, or time window |
| **Risk** | What can go wrong because of the exception |
| **Mitigation** | Compensating control or feature limitation |
| **Evidence** | Relevant tests, AI review, diagnostics, or incident context |
| **Approver** | Authorized System Steward / Production Approver |
| **Expiration** | Date or concrete condition |
| **Follow-up** | Tracked remediation and owner |

# F. Appendix F — Risk Classification

| **Level** | **Typical scope** | **Additional assurance** |
|---|---|---|
| 1 — Feature local | UI, isolated logic, small local fix | Normal affected validation and standard AI review. |
| 2 — Integration/shared contract | API contract, shared extension, package dependency, cross-feature behavior | Contract tests, compatibility/dependency impact, package coexistence. |
| 3 — System sensitive | Auth, permissions, secrets, jobs, realtime, storage, Host SDK, deployment-sensitive behavior | Independent security/architecture review, stronger integration evidence, explicit Steward review. |
| 4 — Irreversible/high impact | Destructive DB change, major auth/security model, deployment-control change, irreversible data transformation | Recovery proof, explicit human authority, highest assurance and tightly bounded execution. |

# G. Appendix G — Architectural Decision Record Template

CPR repositories SHOULD maintain a durable decision record for material architecture and ownership choices. The exact file format may vary, but active decisions must be easy for humans and AI agents to locate before implementation.

| **Field** | **Required content** |
|---|---|
| **Decision ID** | Stable identifier, e.g., DEC-012. |
| **Date** | Date the decision was approved or clarified. |
| **Status** | PROPOSED, ACTIVE, SUPERSEDED, or RETIRED. |
| **Decision** | Concise statement of the architectural choice. |
| **Rationale** | Why this choice was made and what problem it solves. |
| **Ownership boundary** | Which layer/system owns the responsibility and which does not. |
| **Supersedes** | Prior decision(s) or proposal(s) explicitly replaced, if any. |
| **Affected artifacts** | Repositories, packages, standards, infrastructure, APIs, or prompts affected. |
| **Revisit trigger** | Condition that justifies reconsidering the decision, if applicable. |

AI agents MUST read active decision records relevant to their task before proposing architecture. A proposed contradiction must be surfaced explicitly; runtime evidence or current code MUST NOT silently supersede an active decision.
**Continuous Production Readiness (CPR) v1.1**
**Build rapidly. Stay production-ready.**
Operational baseline revised for development freedom, exact release history, and measured refinement.
