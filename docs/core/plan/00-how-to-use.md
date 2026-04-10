<!-- Split from proxypilot-core-phased-plan.md (lines 1-25) -->
<!-- Index: docs/core/plan/README.md -->

# ProxyPilot Core Infrastructure — Phased Implementation Plan

## How to Use This Document

This is the implementation plan for the ProxyPilot core infrastructure upgrade. Each phase is self-contained, independently testable, and leaves the system in a working state. Work through phases sequentially: implement → test → commit → move on.

**For each phase**, hand Claude Code:
1. This document (for overall context and phase ordering)
2. The full specification: `proxypilot-core-infrastructure-prompt.md` (for detailed schemas, configs, and CLI definitions)
3. The specific phase number you're working on

**Workflow per phase:**
```
1. Read this phase's scope and deliverables
2. Read the relevant sections in the full spec
3. Implement
4. Run the verification checklist
5. Commit: git commit -m "phase-XX: <description>"
6. Move to next phase
```

**Reference document:** `proxypilot-core-infrastructure-prompt.md` contains the full technical specification — SQLite schemas, config files, CLI command definitions, Caddy/Incus/Postgres configurations, and implementation constraints. This plan tells you what to build and in what order. The spec tells you how.

---
