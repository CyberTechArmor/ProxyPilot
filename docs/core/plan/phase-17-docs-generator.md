<!-- Split from proxypilot-core-phased-plan.md (lines 582-624) -->
<!-- Index: docs/core/plan/README.md -->

## Phase 17: Documentation Generator

**Goal:** Auto-generate compliance documentation from live system state.

**Files to create:**
```
src/compliance/docs-generator.ts  # Document generation from live state
src/compliance/templates/         # Markdown templates with {{placeholders}}
  system-security-plan.md
  access-control-policy.md
  backup-recovery-plan.md
  audit-log-summary.md
  vulnerability-management.md
  network-security.md
  certificate-inventory.md
  incident-response-plan.md
  risk-assessment.md
  data-classification-policy.md
  baa-tracker.md
  breach-notification.md
```

**Deliverables:**
- `proxypilot compliance docs [--framework soc2|hipaa|all] [--format md|pdf|docx]`.
- 12 document templates filled from live queries (SQLite, Postgres audit, Caddy API, Incus API, system state).
- Markdown output always available. PDF via Pandoc + LaTeX/weasyprint. DOCX via Pandoc.
- Output to `/var/lib/proxypilot/compliance/YYYY-MM-DD/`. Previous generations retained.
- Graceful fallback: if Pandoc not installed and PDF/DOCX requested, print install instructions, generate Markdown.

**Spec references:** "Documentation Generator" section, document list table, output location.

**Verification:**
- [ ] `proxypilot compliance docs --format md` generates all 12 documents
- [ ] Documents contain actual data from the system (not just template placeholders)
- [ ] `--format pdf` generates PDFs (if Pandoc installed)
- [ ] `--format docx` generates DOCX files (if Pandoc installed)
- [ ] Previous generation directories are retained
- [ ] Missing Pandoc prints install instructions, falls back to Markdown

**Commit:** `phase-17: docs-generator - compliance documentation from live state`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
