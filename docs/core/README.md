# ProxyPilot Core Infrastructure Docs

This directory holds the ProxyPilot core infrastructure upgrade documentation,
split into small per-section files so a Claude Code session can load only the
parts it needs without hanging on the full 2,200-line originals.

The original monolithic files are still kept at the repository root as a
single-file reference:

- [`proxypilot-core-infrastructure-prompt.md`](../../proxypilot-core-infrastructure-prompt.md) — full technical spec (1,461 lines)
- [`proxypilot-core-phased-plan.md`](../../proxypilot-core-phased-plan.md) — 19-phase implementation plan (737 lines)

## Layout

```
docs/core/
├── README.md          (this file)
├── prompt/            Split from the technical spec
│   ├── README.md      Section index
│   ├── 00-overview.md
│   ├── 01-design-principles.md
│   └── ...            (one file per top-level section)
└── plan/              Split from the phased plan
    ├── README.md      Phase index
    ├── 00-how-to-use.md
    ├── 01-phase-overview.md
    ├── phase-01-foundation.md
    ├── phase-02-postgres-pgbouncer.md
    └── ...            (one file per phase)
```

## How the two directories relate

- `plan/` tells you **what to build and in what order.** Each phase file lists
  deliverables, verification checklist, commit message, and a placeholder
  "Function-by-Function Checklist" section that a later planning session will
  populate (one function at a time until it works, then move on to the next).
- `prompt/` tells you **how to build it.** SQLite schemas, config file
  contents, CLI command signatures, exact systemd unit templates — the
  reference material each phase file cites.

A typical session loads:

1. The `plan/phase-NN-...md` file for the phase you're working on.
2. One or two `prompt/` section files that the phase references (e.g.,
   `prompt/06-postgresql-architecture.md` for phase 2).

Nothing else. The rest of the docs can stay on disk, unread, until needed.

## Current status

The docs are the **reference material only** — nothing in this directory has
been implemented yet. The implementation proceeds phase by phase, starting
with `plan/phase-01-foundation.md`, once a later session crafts the
function-level checklists.
