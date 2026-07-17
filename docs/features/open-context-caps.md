# Open context windows — cap sweep

Every token/character cap in the build system was audited and either raised to
a runaway-guard level (far above real working sizes, so nothing is silently
truncated in normal use) or made operator-tunable. Current Claude models carry
1M-token context windows and 64k–128k output ceilings; the old caps predated
that and were actively hurting builds (truncated file reads, content-less
`get_component` results, capped audit inputs).

## Per-turn output budgets

| Lane | Was | Now | Notes |
|---|---|---|---|
| Build runner turn | 8k → 32k (clamped 64k) | **64k default, uncapped override** | `MOCK2_RUNNER_MAX_TOKENS` (e.g. 128000 on an Opus/Sonnet slot; Haiku 4.5 maxes at 64k — a higher value 400s) |
| Audit (rule questions) | 6k | 16k | |
| Ask lane | 4k | 16k | |
| Consult (second opinion) | 4k out / 30k in | 16k out / 200k in | cost reservation scales accordingly (~$2.80) |
| Concept chat | 6k | 16k | |
| Inventory extraction | 16k | 32k | |
| Design-token extraction | 3k | 8k | |
| Explain-this | 1k | 4k | |
| Mockup render | 40k (+64k retry) | unchanged | already has truncation-retry; >64k would 400 on a Haiku-backed mockup slot |

## Context / input truncation caps

| Cap | Was | Now |
|---|---|---|
| Tool-result truncation (`MAX_TOOL_RESULT_CHARS`) | 12k chars — a large file read truncated mid-function | **200k chars (~50k tokens)**, override `MOCK2_MAX_TOOL_RESULT_CHARS` |
| gate stderr slice | 2k | 20k |
| `get_component` tool budget | 60k chars — any real component's contents were withheld (the request-37 failure) | **600k chars** — every component within the library ceiling renders with a full manifest; the 142KB auth-component shape now inlines whole (regression-tested) |
| Component library: per file / total | 200k / 600k | **1M / 4M** |
| Audit input (inventory + rules) | 120k chars | **1M chars** |
| Ask question length | 4k | 32k |
| Ask tool-result slice | 20k | 100k |
| Explain input / follow-up prior | 8k / 6k | 32k / 24k |
| Chat message ceiling options | 4k–32k, default 16k | **4k–128k, default 32k** (Admin queue setting) |

## Spend guards (kept, now tunable)

The soft-pause budgets are **cost guards, not context caps** — a pause
checkpoints the work and resumes in one click — so they stay on by default but
are now operator-tunable:

| Guard | Default | Override |
|---|---|---|
| Tokens per run | 1M | `MOCK2_SOFT_PAUSE_TOKENS` |
| Wall-clock per run | 45 min | `MOCK2_SOFT_PAUSE_MINUTES` |

`MAX_TURNS` (300) and the monthly quota buffer are unchanged — both are
pathological-loop backstops, not working limits.
