# Official follow-on list — after the first supervised agent

User-selected sequencing, 2026-09-25. Complete A1–A8 first; then scope and complete
this list in order, one separately bounded section at a time. No item below is
silently dropped. Feature design may conclude an approach is infeasible; report
that outcome and an alternative rather than pretending implementation occurred.

| ID | Remaining original scope | Boundary and expected result | Status |
|---|---|---|---|
| F1 | D5 import/capture feasibility and bounded still import | Reinspect exact RecapShare export source; evaluate account/backend independence and bounded archive parsing; then separately implement selected stills/inert metadata import if feasible. Explicit private review/sharing, no execution or replay. | Deferred until after A8 |
| F2 | Explicit capture and additional modalities | Consent/excluded surfaces; explicit start/pause/resume/stop/cancel with no inherited auto-send/auto-resume. Expand screenshots, video, narration/audio, camera and DOM/event capture one at a time with privacy/storage limits. DOM replay/action verification requires its own authority review. Preserve RecapShare; do not assume reuse is safe. | Deferred until after F1 |
| F3 | Shared Knowledge library | Reusable approved guides/knowledge across permitted projects, version/provenance ownership, access-aware retrieval and revocation. The A1–A8 direct guide assignment remains sufficient for the first agent. | Deferred |
| F4 | Richer practice, critique and learning | Beyond A7's basic rehearsal/recovery: structured critique, richer practice scenarios and human-reviewed improvement proposals. Never self-approve guide changes or silently broaden authority. | Deferred |
| F5 | Multiple agents and concurrent work | Scheduling, multiple profiles/workers/runs, isolation between simultaneous tasks, queue fairness, budgets and per-run cancellation. No shared identity implies shared authority without review. | Deferred |
| F6 | Advanced Flightdeck and broader workflow support | Multi-run supervision, richer observation/takeover, more applications/integrations/providers and additional workflow types beyond the one A1 pilot. Preserve the minimal A6/A7 controls and Dev Studio's existing technical contracts. | Deferred |
| F7 | Remaining estate-wide operations and release work | Non-pilot privileged LXC-to-VM migration/cutover; wider deployment acceptance, remaining historical PR integration and credential rotation; evidence scheduling/erasure or verified Lean BEAF upload cleanup not needed for A8. Carry forward all unresolved original SEC/INF IDs. | Deferred only where not an A1–A8 dependency |

F1 preserves the former optional D5 as planned follow-on work rather than the next
section. Its existing D5 prompt is a feasibility prompt, not authorization for an
importer or capture. The old estimate of another 6–10 conversations was provisional;
F1–F7 are seven scope groups, not seven guaranteed implementation sessions.

Security, authentication, resource isolation and safe deployment required by the
first usable agent are in A1–A8. They cannot be deferred to F7 to claim A8 complete.
Broader infrastructure work is deferred only after A1 documents why the selected
pilot does not depend on it. No existing finding is closed by this reordering.

Completed foundation work (branding, naming, retirement preparation, Operations
B1–B4, Demonstrations D1–D4 and accessibility fixes) stays completed locally with
its recorded limits. It is not a new follow-on batch. Implementation review/CI
and actual deployment acceptance remain separate.

Canonical first list: [A1–A8](fractionate-agents-a1-a8.md).
