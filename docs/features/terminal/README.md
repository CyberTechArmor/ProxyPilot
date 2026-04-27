# Interactive Streaming Terminal

The `ContainerTerminal` (request-response) component currently mounted under the
"Terminal" tab in `LxcContainers.jsx` is a stop-gap. The "Terminal Beta" tab
(`LxcContainers.jsx:1979`) hosts a placeholder for the real PTY-backed
WebSocket terminal that supports `vim`, `htop`, `tmux`, ANSI colors, resize,
and tab completion driven by the actual shell.

This directory plans that work in two phases — **MVP** first, then
**production hardening** after operator hands-on use.

## Files

| File | Purpose |
|---|---|
| `terminal-mvp.md` | Spec for the MVP slice (LXC + host shell, no recording, no Docker, no mobile polish). Includes file list, deliverables, verification checklist, function-by-function breakdown. |
| `terminal-mvp-prompt.md` | Copy-paste prompt for the next Claude Code session. Self-contained kickoff that branches off the hardening branch and walks the MVP checklist. |
| `terminal-production.md` | Spec for production hardening (Docker, asciinema recording, replay UI, reconnect grace, mobile, ACL, settings UI). Contains a `## Post-MVP Use Notes` section the operator fills in BEFORE the next session runs. |
| `terminal-production-prompt.md` | Copy-paste prompt for the production session. Reads operator feedback first, refuses to proceed if the feedback section is empty. |

## Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Operator pastes terminal-mvp-prompt.md into new session     │
│     → Claude builds the MVP, ticks verification, marks complete │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│  2. Operator uses the MVP for ~1 week against real workloads    │
│     → Open terminals, run interactive programs, try mobile,     │
│       intentionally close tabs, let idle sessions expire,       │
│       check the audit log                                       │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│  3. Operator fills in `## Post-MVP Use Notes` in                │
│     terminal-production.md with concrete observations:          │
│     what worked, what broke, what's missing, priorities         │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│  4. Operator pastes terminal-production-prompt.md into new      │
│     session                                                     │
│     → Claude reads the notes, confirms understanding, populates │
│       the function-by-function checklist, waits for sign-off,   │
│       then executes one item at a time                          │
└─────────────────────────────────────────────────────────────────┘
```

The hard separation between MVP and production is deliberate. The MVP scope is
narrow enough to land in 3-4 days of focused work; the production-hardening
scope is wide enough that planning it before any real-world use produces a plan
that misses the point. The `Post-MVP Use Notes` section is the bridge: it forces
the operator to commit observations to writing before the planning resumes, and
it lets the next Claude Code session adjust the default plan to what the
operator actually needs rather than what the spec writer guessed at.

## Branch base

Both phases branch from `claude/proxypilot-progress-review-E6iNc` (the 15-commit
hardening branch) — every prerequisite (cookie + CSRF auth, encrypted secrets,
versioned migrations, tightened CSP, rate limiting, body limits, B1 cap-drop,
deploy validation) is already in place there. The terminal feature does not
require any of the planned phases (Phase 2c, Phase 22, Phase 3+) and does not
block them either.
