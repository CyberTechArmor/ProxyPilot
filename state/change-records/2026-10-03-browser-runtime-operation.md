# Fixed authenticated browser runtime installation

The 2026-10-03 owner instruction supersedes terminal-only installation and whole-feature acceptance gating. This increment implements installation, recovery and rollback through the root systemd runner; it does not certify navigation. Baseline: repository-pinned Mock2 1.14.0 and existing stack. No dependency-line upgrade, database migration, Incus upgrade or other application change.

Dedicated strict Go RPC, shared writer serialization, empty-flags dispatch and fixed helper attest delivered source before stopping only the retained dashboard container. Fresh authenticated authority binds the paired package transaction. The same container restarts and its HTTP health is checked. Private plans and operation metadata remain root-only. Pre-transaction staging is archived intact after validating original installed state; published transactions retain existing recovery checks.

Independent stop and boot hooks recover without a dashboard session. The journal binds the exact root-runner request ID; recovery finalizes only that interrupted request. UI/API/MCP expose a dedicated authenticated operation, never an unrelated shell wrapper. Existing admin/sudo/CSRF and MCP host-control permissions remain. The UI retains its queued ID when status temporarily returns a preceding run.

Independent reviewer in a separate context has shell/tools and instructions not to modify application code. Initial findings: receipt clock drift, pre-transaction residue, missing independent recovery, stale UI operation adoption. Corrected; final review pending.

Local checks: Go suite passed; frontend build passed; real component rendered at 360/375/768/1280/1920 without horizontal overflow. Eleven temporary-file operation tests pass; Docker/services simulated. Existing 27 package tests passed with temporary Unix sockets permitted. Focused backend/update/MCP tests: 77/78 passed; sole failure was expected tool count +1, now adjusted and being rechecked. No installed acceptance produced.

Live baseline remains 18f75acddf with expanded runtime absent. CI, final review, merge/deployment and real installation verification follow. Public navigation/model/auth/files/internal and UI batches remain incomplete in state/browser-delivery-20261003.md.
