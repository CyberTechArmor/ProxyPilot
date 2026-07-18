// Mock2 agent-harness abstraction — the seam between "which engine drives a
// build cycle" and everything else in the app.
//
// ## The Harness contract
//
// A harness is an object with:
//
//   name: 'proxypilot' | 'claude'
//   runTask(input): Promise<void>
//
// `input` is the runner argument bag startCycle assembles today:
//   { cycle, project, containerName, framework, gateScripts, ready, buildMode }
//
// runTask drives ONE build cycle end-to-end and owns its own error handling —
// it always lands the cycle in a terminal status, releases the checkout lock,
// and schedules job cleanup, exactly as runCycle/runCycleSdk do. Streaming is
// the app's EXISTING event model, unchanged: every harness writes the same
// normalized records into the durable per-cycle transcript
// (insertCycleEvent → mock2_cycle_events: task / ai_message / tool_call /
// tool_result / gate / guardrail / audit / note, each with token+cost meta) and
// the same live job phase (setJob). The frontend consumes those two surfaces
// today and needs no harness-specific rendering — that IS the normalized
// HarnessEvent shape, so a new harness plugs in by emitting the same records.
//
// ## The two implementations
//
// - ProxyPilotHarness — an ADAPTER over the existing hand-rolled loop
//   (runner.js runCycle). It wraps, it does not reimplement: a project on this
//   harness behaves byte-for-byte as before the abstraction existed.
// - ClaudeHarness — the Claude Agent SDK loop (runner-sdk.js runCycleSdk),
//   authenticated with a pay-as-you-go Anthropic API key resolved server-side
//   (connector secret or ANTHROPIC_API_KEY env — see resolveClaudeAuth). Ships
//   with the `search` (WebSearch) and `pull-website` (WebFetch) subagents.
//
// Both runner modules are imported DYNAMICALLY inside runTask: it keeps this
// module import-light (pure-testable without better-sqlite3), avoids an import
// cycle with runner.js, and means a ProxyPilot-only install never needs
// @anthropic-ai/claude-agent-sdk present.
//
// Terminology (risk R7): the product word stays "runner"; "harness" names the
// selectable engine, matching docs/agent-sdk-migration.md.

import { resolveHarness, resolveClaudeAuth } from './runner-logic.js';

export class ProxyPilotHarness {
  name = 'proxypilot';
  async runTask(input) {
    const { runCycle } = await import('./runner.js');
    return runCycle(input);
  }
}

export class ClaudeHarness {
  name = 'claude';
  async runTask(input) {
    const { runCycleSdk } = await import('./runner-sdk.js');
    return runCycleSdk(input);
  }
}

// harnessForProject(project, env) — the factory. The per-project choice wins;
// no choice falls back to the legacy global BUILD_RUNNER flag; the default is
// the ProxyPilot harness (resolveHarness owns that ordering, and is where the
// decision is unit-tested).
export function harnessForProject(project, env = process.env) {
  return resolveHarness(project, env) === 'claude' ? new ClaudeHarness() : new ProxyPilotHarness();
}

// claudeHarnessStatus({ ready, env }) — is the Claude harness usable on this
// install, and from which key source? `ready` is buildRunnerReady()'s result
// (or its { ok:false } shape when the slot isn't assigned). Returns ONLY
// booleans/labels — never key material — so routes can send it to the browser
// as-is for the toggle's disabled/warning state.
export function claudeHarnessStatus({ ready = null, env = process.env } = {}) {
  const auth = resolveClaudeAuth({
    provider: ready?.ok ? ready.connector?.provider : null,
    hasConnectorKey: !!(ready?.ok && ready.apiKey),
    hasEnvKey: !!String(env.ANTHROPIC_API_KEY || '').trim(),
  });
  return { configured: auth.ok, source: auth.source, reason: auth.ok ? null : auth.reason };
}
