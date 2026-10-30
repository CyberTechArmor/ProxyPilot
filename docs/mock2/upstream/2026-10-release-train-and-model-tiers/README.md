# mock2-core 1.40.0 → 1.42.0 → 1.43.0: release-train lessons, then provider-scoped model tiers (upstream candidates)

*Built 2026-10-29/30 in a ProxyPilot cloud session from the developer's two-part prompt. **Not published.** The
developer asked to stop at smoke-tested candidates; publication follows the procedure below, on the developer's
decision, 1.42.0 first.*

## Baseline and numbering

- Base: the **published 1.40.0** site. Every file was downloaded from https://mock2.fractionate.ai on 2026-10-29 and
  each of the 289 managed files matched its `release.json` sha256. `release.json` sha256
  `5cd30470d296c0d5173d9b5ace6b7bcab416e7399d39f313b6803b4c3f774f4c`, `manifest.json` sha256
  `56bab93619d02d243d873194439e0c43c82afbeedd1170ef1de58f0f257578d8`. Both still matched the live site at packaging.
- **1.41.0 has not landed.** It is the pending "lessons from one host's night" prompt, which was not available here.
  The version numbers 1.42.0 and 1.43.0 are kept, so 1.41.0 stays free.
- The proposals that built on 1.41.0 are self-contained:
  - the release queue keeps its own record in the git common directory;
  - `port.mjs --write` takes the port explicitly;
  - the local git adapter's 1 MiB buffer is raised to 64 MiB in place;
  - `migrate` converts a version-1 `fallback` field only when one is present.
- If 1.41.0 lands first, rebase both patches on it, re-anchor the items above, and renumber nothing.

## What is in this folder

- `mock2-core-1.42.0.patch` — `git diff --binary --full-index` from the 1.40.0 tree to the 1.42.0 candidate.
  - Applied with `git apply --index` to a clean 1.40.0 tree, it reproduces the tested tree exactly (git tree
    `96e0a63e84ef81ae7eb513dc8dd3ce4a2921fd6a`).
  - sha256 `642a70cc97df932ef1d860238d12a4179a8ba4ade75ca6d3e1a0311e907ee581`.
- `mock2-core-1.43.0.patch` — from the 1.42.0 candidate to the 1.43.0 candidate.
  - It reproduces the tested tree exactly (git tree `f00f0ff550035fad6717fa28a6d8a0d3251e98f6`).
  - sha256 `8a39eec6cbeadb8b425a35ed62577b90cdbd7c9c773d6427745b19717ec3c79c`.

Both patches include the generated files, so a regeneration on the publisher is a no-op check rather than a source of
difference. To see only the canonical change, exclude these paths:
- `release.json`
- `core/mock2/history.json`
- `core/mock2/templates/repo/.mock2/template-manifest.json`
- `core/mock2/templates/repo/.mock2/standards/`

The canonical change is 72 paths for 1.42.0 and 79 for 1.43.0.

| Candidate | `release.json` sha256 | `manifest.json` sha256 | managed files / template identities |
| --- | --- | --- | --- |
| 1.42.0 | `ebb5ae77bd2214dfd49be372b353270c146635566be95888d521a25e3a38b04f` | `bf281f95775406f2fc439f3db8a5b79b0c2215d00d9e788fd71aa5a9783e31b2` | 307 / 255 |
| 1.43.0 | `0b112179ff3c9358c9273ec486c26eb1dc7930ca951d91826a546614ae0114c3` | `53701c9df3b862622ffdd73fe6b5152511909409bad4969c4f9261f82479e721` | 325 / 266 |

**Both releases change `core/mock2/bin/generate-artifacts.py`.** The publisher's own copy must be replaced with each
release's copy before regenerating (000-READ-FIRST.md, Releasing). The changes are:
- OWNERSHIP: `.mock2/templates/` is framework-owned.
- Titles and executable bits for `port.mjs`, `queue.mjs`, `gates.mjs` and `records.mjs`.
- 1.43.0: the schemas and samples are copied into `.mock2/standards/`.

| Candidate | `generate-artifacts.py` sha256 |
| --- | --- |
| 1.42.0 | `d5e2a8d3ff5ebe9f223905121109972c1b7f765c86599105a2a62c7a3f8ebd58` |
| 1.43.0 | `65e16b7af8ba38929a7f9d4fed7fb176e378563d35ba2233882bbf0759c080ba` |

## 1.42.0 — lessons from one application's release train

Full record: `state/change-records/2026-10-30-lessons-2026-10-29.md` inside the patch.

- **Final batteries:**
  - A build declares an `identity`. A consumer with `reuse.buildInputs` is reused without the artifact, and the build
    is recorded as not applicable. A dependant that executes, directly or through other checks, makes the build run.
  - Runner-owned variables leave the environment fingerprint.
  - `battery.cleanEnv` gives the clone a clean environment.
  - A passed battery writes its cache back to the worktree and its queue entry. `--seed-cache-from worktree|queue`
    seeds the next clone with fingerprint-verified entries.
  - A file that dominates its check three runs running is named for repair.
- **Runner:** an early stop after each heavy check names the first changed path (`--no-early-stop`). A repeat failure
  with no known-failures entry prints a WARNING.
- **Briefs:** the `Checks:` default is no full run before review. `doctor --brief` lints briefs. `port.mjs` fails
  closed.
- **Release tools:**
  - `gates.mjs`: saved values, a safe character set unless `raw-saved: true`, placeholder refusal, read-only dry runs.
  - `records.mjs`.
  - `queue.mjs`: `base`, `withdraw`, `absorb`, slots.
  - The release-prompt template and `gen.mjs release-prompt`.
- **Generator templates:**
  - `migration-guard`: refuses every form it does not recognise; checked on real PostgreSQL.
  - `readonly-query`: a host-side helper.
  - `non-app-paths`.
- **Worktree closeout:** `worktree-lifecycle archive-evidence`.
- **PRO text:** §E, §F, §K.3, §K.6, §M.4, §M.5, §M.10, §M.11, §N.1, §N.5, §N.7, §N.8, §N.11, §P.1–§P.6 and a new §P.8.
- **Also fixed** (repository tools and tests, not shipped):
  - `scripts/release-smoke.sh` no longer fails on 1.40.0's second `BASE=` line in `install.sh`.
  - The names fixture allows the stack table's three documentation hosts, published since 1.39.0.
  - The §K.2 test reads the 1.32.0 amendment as the previous one.

  These were the 10 failures on the published 1.40.0 tree.

## 1.43.0 — provider-scoped model tiers, agent workflow, attribution and delivery evidence

Full record: `state/change-records/2026-10-30-model-tiers.md` inside the patch.

**Routing**
- Roles (coordinator, investigator, builder, reviewer, and the new release-helper) bind to qualified tiers
  `provider/tier` through a host-owned, versioned registry. An unqualified tier never dispatches.
- Settings schema version 2. `orchestrate.mjs migrate` keeps every effective route. A shipped compatibility registry
  carries the 1.40.0 table as data; it is the only place the old model ids remain.
- With no settings, routing equals 1.40.0. A differential test of about 32,000 random cases found 0 mismatches.
- One resolution loop checks every replacement route.
- No silent provider switch. A cross-provider move happens only by a configured, permitted route, and it is recorded.
- Budgets have on-exhaust `wait`, `ask` or `route`. A route only relieves limits it can relieve.

**Records and contracts**
- Unknown usage or price is unknown, never 0. Totals are kept per currency.
- Execution record `mock2.execution/1` with identity evidence levels.
- `cost-compare` (same-usage counterfactual).
- `Model-Routing.md`, `Work-Lifecycle.md`, two JSON schemas, non-normative samples and the illustrative 24-hour story.
- Relay 1.3.0 schema-3 lifecycle observations, off by default.

**Text**
- PRO current §M.12 rewritten, a new §AA, and cross-references in §F, §I, §M.11, §P, §U and §R.
- `orchestration.md` rewritten. The run ledger gains an optional `route` column.

**Breaking for routing configuration, with migration.** Release-note line: a version-1 pin that 1.40.0 refused as a
provider/model mismatch now converts as written, because provider identity is no longer inferred from model names.

## Evidence

Linux, Node 24.22.2 (Node 22 lacks `crypto.argon2`), Python 3. No network calls and no paid model calls in any test.

| Check | 1.40.0 base | 1.42.0 candidate | 1.43.0 candidate |
| --- | --- | --- | --- |
| Full suite (`node --test core/mock2/tests/*.test.mjs`) | 470 tests: 452 pass, 10 fail, 8 skipped | 574: 565 pass, **0 fail**, 9 skipped | 640: 631 pass, **0 fail**, 9 skipped |
| `secrets-coverage.mjs` | — | 31/31 | 31/31 |
| `install-binary.py`, `relay-upgrade.py` | — | PASS, PASS | PASS, PASS |
| Generator second run | — | no change | no change |
| Outgoing secret scan | — | 24,869 lines, nothing found | 51,693 lines, nothing found |
| Release smoke, candidate served locally | — | 4/4 (earlier release: the live 1.40.0 site) | 4/4 (earlier release: the 1.42.0 candidate) |

The 9 skips are compiler-bridge cases, PowerShell 7 (no `pwsh`), one battery case, and the real-database helper case
without `MOCK2_TEST_PG`.

**Measured against targets**
- The early-stop recheck on 60,000 tracked files took a median of 0.87–1.09 s, against a target under 2 s: PASS.
- The read-only helper's real-database case ran on PostgreSQL 16.15.

**Review.** Independent reviewers in separate contexts built none of the work.
- **1.42.0:**
  - Round 1: 1 HIGH, 4 MEDIUM, 7 LOW.
  - A re-review then found 1 HIGH: migration-guard bypasses through quoted names, casts and domains, reproduced on
    PostgreSQL.
  - A third confirmation left 1 LOW and 1 NIT, both fixed with tests.
- **1.43.0:**
  - Round 1: 3 HIGH, 9 MEDIUM, 7 LOW.
  - Confirmation rounds found one MEDIUM each time: the budget re-check after an on-exhaust hop, then limits a route
    cannot relieve. Both are fixed.
  - The last round left one conservative NIT, recorded as a FOLLOW-UP: a replacement route keeps the bound tier's
    output cap, so a job can wait when a cheaper route would have fitted. It never exceeds a limit.

## Not done here (before publishing)

- The names check with the private list (`MOCK2_PRIVATE_NAMES`). 1.43.0's prose names the provider ids `openai` and
  `anthropic`, as the 1.40.0 tool already did.
- Release smoke with the real publisher, Windows (`release-smoke.ps1`) and macOS.
- The Relay package's own tests and type check (no installed dependencies here).
- The read-only helper's real-database case on PostgreSQL 18.
- An OpenAI documentation recheck. `developers.openai.com` is outside this session's network policy. The Anthropic
  pages were rechecked on 2026-10-30 and match the prompt.

## Publishing (the developer's decision)

Follow `000-READ-FIRST.md`, Releasing, once for 1.42.0 and then once for 1.43.0:
1. Take a guest snapshot of `mock2`.
2. Apply the patch to the publisher's seed and replace the publisher's generator copy.
3. Regenerate. It should be a no-op against the patch.
4. Run the suite, the names check with the private list, and the release smoke with real bytes, with `--earlier` the
   live site.
5. Publish.
6. Verify the public files over HTTPS against `release.json`, and name the core and template commits in each change
   record's closeout.

ProxyPilot's framework seed still pins 1.39.0. Adopting 1.42.0/1.43.0 guidance in ProxyPilot is separate, reviewed
work (`docs/mock2/standards-and-cpr.md` §3).
