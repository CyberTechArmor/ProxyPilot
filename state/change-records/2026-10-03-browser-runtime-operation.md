# Fixed authenticated browser runtime installation

The 2026-10-03 owner instruction supersedes terminal-only installation and whole-feature acceptance gating. This increment implements installation, recovery and rollback through the root systemd runner; it does not certify navigation. Baseline: repository-pinned Mock2 1.14.0 and existing stack. No dependency-line upgrade, database migration, Incus upgrade or other application change.

Dedicated strict Go RPC, shared writer serialization, empty-flags dispatch and fixed helper attest delivered source before stopping only the retained dashboard container. Fresh authenticated authority binds the paired package transaction. The same container restarts and its HTTP health is checked. Private plans and operation metadata remain root-only. Pre-transaction staging is archived intact after validating original installed state; published transactions retain existing recovery checks.

Independent stop and boot hooks recover without a dashboard session. The journal binds the exact root-runner request ID; recovery finalizes only that interrupted request. UI/API/MCP expose a dedicated authenticated operation, never an unrelated shell wrapper. Existing admin/sudo/CSRF and MCP host-control permissions remain. The UI retains its queued ID when status temporarily returns a preceding run.

Independent reviewer in a separate context has shell/tools and instructions not to modify application code. Initial findings: receipt clock drift, pre-transaction residue, missing independent recovery, stale UI operation adoption. Corrected and rechecked; final review found no remaining blocking issues.

Local checks: Go suite passed; frontend build passed; real component rendered at 360/375/768/1280/1920 without horizontal overflow. Eleven temporary-file operation tests pass; Docker/services simulated. Existing 27 package tests passed with temporary Unix sockets permitted. Focused backend/update/MCP tests initially passed 77/78; the sole failure was the expected tool count +1. That expectation was corrected and all 20 MCP tests passed on rerun. No installed acceptance produced.

All three PR732 exact-head workflows passed for 838957a60ef569c5d5dd1131a9bf75445389fe13. Merged as 829944a8ec4bdaa9e6bdd4663f276cae77a6e439. Initial deployment 116d5a68-4e5d-4225-8bae-0cd4e7ac9e93 exited 75 at the service-lifetime transition; follow-up rebuild 62fbe678-8f9a-4c8b-87f3-70cda056492d succeeded at 18:16:36Z. Running dashboard and host agent both identify 829944a8ec. Recovery unit is loaded and existing A3/A4/A7 services remain active. No Incus-upgrade flag was used.

Installation remains unverified and uninvoked: this conversation's MCP catalog does not expose the new manage_browser_runtime operation and its cloud browser is signed out. Last runtime result remains separate_runtime_package_required. Public navigation/model/auth/files/internal and UI batches remain incomplete in state/browser-delivery-20261003.md.
