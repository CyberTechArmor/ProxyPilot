# Authentication readback endpoint privacy — 2026-10-04

## Problem and resulting behavior

The selected gateway already emits authentication path previews using a fixed
benign-word vocabulary and `[redacted]` for other segments. The backend's wire
schema previously accepted any bounded path string, which could let a validly
signed helper regression retain account IDs or token-bearing path segments in
human readback and immutable confirmation records. It now validates the existing
gateway format. Query/fragment, encoded tokens, user IDs and controls cannot
enter readback or create durable authentication confirmations.

This preserves the existing sign-in/MFA flow and exact consequential-action
approvals. It does not add authentication authority, change public-navigation
readiness, alter the legacy demo or claim protection from compromised host root.
No helper changed and no dedicated runtime Install is needed for this slice.

## Validation

- Auth schema tests cover benign/redacted paths and privacy violations.
- Runtime tests use valid signed host inventories carrying unredacted paths,
  refuse them, preserve manual capture suppression and release blocking, and
  prove no confirmation/request/event persistence or model/observe invocation.
- The 64-request large proof uses long redacted previews matching the real
  gateway, retaining the finite inventory proof and no-drop assertion.
- Initial invocation could not resolve `zod` in the new worktree; reused the
  existing cloud checkout's dependency directory without changing it.
- `node --test` on auth-contract, selected-browser service and selected-browser
  runtime suites: 239 passed, 0 failed, 0 skipped. These exercise injected host
  transport with real lifecycle/private-files code, not a live account.
- Exact review/CI/release evidence is recorded by the release coordinator after
  the candidate has been frozen.

## Scope and remaining acceptance

The existing manual takeover/readback/action flows need real account and live
input transport acceptance. Reusable credentials/OAuth remain separate adapter
work. The concrete interfaces, internal-destination plan and unresolved custody
choice are in `docs/plans/fractionate-browser-connections-delivery-20261004.md`.
That plan supersedes historical whole-feature/independent-terminal restrictions
while preserving truthful readiness, current grants and protected targets.

No production operation, real sign-in, upstream OAuth grant, internal route,
credential enrollment, merge, push, deployment or runtime installation was
performed by this implementation agent.
