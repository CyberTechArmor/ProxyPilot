<!-- Split from proxypilot-core-phased-plan.md (lines 52-85) -->
<!-- Index: docs/core/plan/README.md -->

## Phase 1: Foundation

**Goal:** Build the infrastructure that every subsequent phase depends on — state store, configuration, and systemd management.

**Files to create:**
```
src/db/schema.ts             # SQLite schema + migrations + WAL mode
src/db/queries.ts            # Typed query helpers
src/db/index.ts
src/core/config.ts           # YAML config loader (~/.proxypilot/config.yaml)
src/core/systemd.ts          # Generate .service/.timer units, daemon-reload, enable/start/stop
src/core/index.ts
```

**Deliverables:**
- SQLite database initialization with full schema from spec (all tables — routes, containers, databases, vpn_peers, etc.). Tables for features not yet implemented are created empty — this avoids schema migrations later.
- Config loader that reads `~/.proxypilot/config.yaml` with defaults for every value. Environment variable overrides.
- Systemd unit generator: function that takes a unit definition (name, exec, after, type) and writes a `.service` or `.timer` file to `/etc/systemd/system/`, runs `daemon-reload`.
- Helper functions: enable, start, stop, restart, status, is-active for any unit.
- `instance_meta` table seeded with `instance_uuid` (generated) and `install_profile` (empty until Phase 19).

**Spec references:** "State Store: SQLite" section, "Config File" section, all `CREATE TABLE` statements in "Full SQLite Schema Additions", "Implementation Constraints" items 1 and 11.

**Verification:**
- [ ] `proxypilot` runs without error (no new commands yet, just infrastructure)
- [ ] SQLite database created at configured path with all tables
- [ ] Config loader reads YAML, applies defaults, respects env overrides
- [ ] Systemd generator can create a test unit, start it, check status, stop it, remove it
- [ ] Unit tests pass for schema initialization, config loading, systemd generation

**Commit:** `phase-01: foundation - sqlite schema, config loader, systemd generator`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
