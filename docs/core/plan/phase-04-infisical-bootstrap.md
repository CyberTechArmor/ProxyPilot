<!-- Split from proxypilot-core-phased-plan.md (lines 142-172) -->
<!-- Index: docs/core/plan/README.md -->

## Phase 4: Infisical + Credential Bootstrap

**Goal:** Secrets management with zero-plaintext credential lifecycle.

**Files to create:**
```
src/core/infisical.ts        # Infisical REST API client, project/environment/secret CRUD
src/core/bootstrap.ts        # Credential generation, bootstrap sequence, rotation
```

**Deliverables:**
- `bootstrap.ts`: Generate all credentials (`crypto.randomBytes`), write to `/root/.proxypilot-bootstrap.json` (mode 0600). Orchestrate: start Postgres → PgBouncer → Valkey → configure Infisical → start Infisical → wait for health → create project/environments → store all credentials in Infisical → verify retrieval → delete bootstrap file.
- `infisical.ts`: REST API client for Infisical. Create project, create environments (core, databases, workloads), create/read/update/delete secrets. No dependency on Infisical CLI for programmatic ops.
- Infisical Agent template generation (`pgbouncer-userlist.tmpl`, `valkey.tmpl`). Generate and install `proxypilot-infisical.service` and `proxypilot-infisical-agent.service`.
- After this phase, no credentials exist in plaintext on disk.

**Spec references:** "Infisical Integration" section, "Bootstrap Sequence" steps 3-8, credential rotation details, Infisical project structure.

**Verification:**
- [ ] Bootstrap generates credentials file, configures all services, starts Infisical
- [ ] Infisical API responds to health check
- [ ] All credentials stored in Infisical (core environment)
- [ ] Bootstrap file deleted after rotation
- [ ] Infisical Agent renders PgBouncer userlist and Valkey config from templates
- [ ] PgBouncer still works after switching to agent-rendered userlist
- [ ] Can retrieve any secret via Infisical API

**Commit:** `phase-04: infisical - secrets management with credential bootstrap`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
