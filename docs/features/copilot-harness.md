# Copilot harness — the default build engine

ProxyPilot's build runner is pluggable: a **harness** is the engine that drives one
build cycle. There are three, selected per project (Project → Build harness) and
resolved by `runner-logic.resolveHarness`:

| Harness | Engine | Notes |
|---|---|---|
| **`copilot`** | `runner.runCycle` + the Copilot tool profile | **The install-wide default.** Native JS port of the reference harness bundle (Copilot-grade file editing). |
| `proxypilot` | `runner.runCycle` (no profile) | The original hand-rolled loop, byte-identical to before. |
| `claude` | `runner-sdk.runCycleSdk` | The Claude Agent SDK loop (Anthropic only). Opt-in; needs an Anthropic key. |

A project with no explicit choice uses `copilot`, unless the legacy
`BUILD_RUNNER=sdk` env flag is set (that still opts a whole install into `claude`,
unchanged).

## What the Copilot harness is

It is **not** a new agent loop. It reuses the *same* fenced-container cycle engine as
the ProxyPilot harness — the same events, gates, `finish`/deploy, breakers, cost
accounting, prompt caching, and the provider-neutral model client (so it drives
**Anthropic and OpenAI** models identically). The harness only swaps the cycle's
**personality** via a profile (`harness-copilot.COPILOT_PROFILE`):

1. **The tool set** (ported from the bundle's `tools.ts`, executed against the
   container in `runner.executeTool`):
   - `search_workspace` — ranked keyword/regex search (ripgrep, `.gitignore`-aware,
     grep fallback) so the model finds code instead of guessing paths.
   - `read_file` — now accepts `start_line`/`end_line`; large whole-file reads are
     truncated with a "request a range" nudge (token economy).
   - `list_dir` — one level, or a bounded recursive listing.
   - `apply_edit` — the anchored, byte-exact edit primitive (shared verbatim with the
     ProxyPilot harness; see `apply-edit-logic.js`).
   - `create_file` — create a new file; fails if it exists (use `apply_edit` to modify).
   - `run_terminal` — a shell command, gated by a **denylist** (`rm -rf /`, `git push`,
     `curl`/`wget`, `sudo`, disk ops) with **secret redaction** on the output.
   - `get_diagnostics` — a scoped TypeScript typecheck of the working tree, for the
     read → edit → **verify** loop.

   The shared control/component tools (`finish`, `halt`, `pending_verification`,
   `run_gates`, `request_authorization`, `get_component`, `materialize_component`) are
   carried over unchanged, so the whole cycle machinery still works. `exec_in_container`
   is replaced by `run_terminal` (adds the denylist); `write_file` by
   `create_file` + `apply_edit`.

2. **The system prompt** — the bundle's coding-agent workflow (understand → minimal
   anchored edits → verify with `get_diagnostics`/`run_gates` → stop when clean)
   prepended to the full runner prompt, so all of ProxyPilot's completion discipline
   (gates, integration honesty, design fidelity) is preserved.

## Safety (Part E)

- **Path safety** — every file tool resolves under the app dir via `runner.safeRel`
  (no traversal, no absolute escape); the container is network-fenced regardless.
- **Command policy** — `harness-safety.commandAllowed` denylist, defence-in-depth on
  top of the fence.
- **Secret redaction** — `harness-safety.redactSecrets` masks key-shaped strings before
  tool output reaches the model or the durable transcript.

## Files

- `admin/backend/src/mock2/harness-copilot.js` — the profile: tool set, prompt, and the
  pure read/search formatters (tested: `src/__tests__/mock2-copilot-harness.test.js`).
- `admin/backend/src/mock2/harness-safety.js` — command policy + secret redaction.
- `admin/backend/src/mock2/harness.js` — `CopilotHarness` + the factory.
- `admin/backend/src/mock2/runner.js` — the Copilot tool executors (container I/O) and
  the `harnessProfile` seam in `runCycle`.
- `admin/backend/src/mock2/apply-edit-logic.js` — the shared anchored-edit primitive.
- `admin/frontend/src/pages/ProjectDetail.jsx` — the three-way harness selector.

## Not yet wired

- **Edit-time syntax rejection** — `apply_edit` has an optional `validate` hook
  (`PARSE_FAIL`); the harness leaves it unset and verifies via `get_diagnostics` /
  `run_gates` instead.
- **Cross-provider fallback** — the Anthropic↔OpenAI equivalence map
  (`model-equivalence.js`) is in place; retrying the mapped-equivalent model on the
  other provider is a future flag-gated wiring.
