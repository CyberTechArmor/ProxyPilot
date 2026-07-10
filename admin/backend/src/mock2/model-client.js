// Mock2 provider-agnostic model client (Phase M6). The RUNNER drives the
// build_runner slot through one neutral turn API here; this module translates a
// neutral transcript into each provider's tool-calling request and normalizes the
// response back. Providers: anthropic, openai, gemini, ollama, openai_compatible
// (the last three share the OpenAI chat-completions shape).
//
// The default model id is NEVER hardcoded — the runner passes the per-slot `model`
// string the admin assigned (connectors.js getSlot). When the admin needs a
// sensible default, the docs point at the latest Claude models (Opus 4.8 /
// Sonnet 5 / Haiku 4.5); this module just calls whatever id it's given.
//
// The plaintext key is read ORCHESTRATOR-SIDE only (decryptConnectorKey) and
// never enters a container. Outbound requests go through the agent proxy like
// every other outbound call (see connectors.js testConnector).
//
// Neutral transcript turn shapes:
//   { role:'user', text }
//   { role:'assistant', text, toolCalls:[{ id, name, input }] }
//   { role:'tool', toolCallId, name, content }
// callModelTurn returns:
//   { ok, text, toolCalls:[{ id, name, input }], usage:{ inputTokens, outputTokens }, stopReason, error }
//
// Terminology (risk R7): the slot is build_runner; nothing here is named "agent".

const DEFAULT_TIMEOUT_MS = 120000;

function openAiBase(provider, baseUrl) {
  if (provider === 'openai') return 'https://api.openai.com/v1';
  const b = String(baseUrl || '').replace(/\/+$/, '');
  // Operator base_urls sometimes already end in /v1; don't double it.
  return /\/v1$/.test(b) ? b : `${b}/v1`;
}

// The single entry point. connector is the mock2_model_connectors row; apiKey is
// the decrypted key (orchestrator-side, may be null for a local ollama); model is
// the per-slot id; tools are the neutral RUNNER_TOOLS; system is the assembled
// prompt; transcript is the neutral turn list.
export async function callModelTurn({
  connector, apiKey = null, model, system, tools = [], transcript = [], maxTokens = 8000, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const provider = connector?.provider;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    switch (provider) {
      case 'anthropic':
        return await callAnthropic({ apiKey, baseUrl: connector.base_url, model, system, tools, transcript, maxTokens, signal: controller.signal });
      case 'gemini':
        return await callGemini({ apiKey, baseUrl: connector.base_url, model, system, tools, transcript, maxTokens, signal: controller.signal });
      case 'openai':
      case 'openai_compatible':
      case 'ollama':
        return await callOpenAiCompatible({ provider, apiKey, baseUrl: connector.base_url, model, system, tools, transcript, maxTokens, signal: controller.signal });
      default:
        return { ok: false, error: `unsupported provider "${provider}"`, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
    }
  } catch (err) {
    return { ok: false, error: `model call failed: ${err?.message || String(err)}`, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Anthropic Messages API (tool use) ----
async function callAnthropic({ apiKey, baseUrl, model, system, tools, transcript, maxTokens, signal }) {
  const url = `${String(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;
  const messages = anthropicMessages(transcript);
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    messages,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `anthropic HTTP ${res.status}: ${text.slice(0, 300)}`, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  let j; try { j = JSON.parse(text); } catch { return { ok: false, error: 'anthropic: non-JSON response', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }; }
  let outText = '';
  const toolCalls = [];
  for (const block of j.content || []) {
    if (block.type === 'text') outText += block.text || '';
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
  }
  return {
    ok: true, text: outText, toolCalls, stopReason: j.stop_reason || null,
    usage: { inputTokens: j.usage?.input_tokens || 0, outputTokens: j.usage?.output_tokens || 0 },
  };
}

function anthropicMessages(transcript) {
  const out = [];
  for (const turn of transcript) {
    if (turn.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: turn.text || '' }] });
    } else if (turn.role === 'assistant') {
      const content = [];
      if (turn.text) content.push({ type: 'text', text: turn.text });
      for (const tc of turn.toolCalls || []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input || {} });
      // Skip an empty assistant turn — Anthropic rejects content: [].
      if (content.length) out.push({ role: 'assistant', content });
    } else if (turn.role === 'tool') {
      // Group consecutive tool results into a single user message (Anthropic
      // requires all tool_result blocks for one assistant turn together).
      const block = { type: 'tool_result', tool_use_id: turn.toolCallId, content: String(turn.content ?? '') };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content.every((b) => b.type === 'tool_result')) {
        prev.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}

// ---- OpenAI-compatible chat completions (openai / openai_compatible / ollama) ----
async function callOpenAiCompatible({ provider, apiKey, baseUrl, model, system, tools, transcript, maxTokens, signal }) {
  const url = `${openAiBase(provider, baseUrl)}/chat/completions`;
  const messages = [{ role: 'system', content: system }, ...openAiMessages(transcript)];
  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    tool_choice: 'auto',
  };
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `${provider} HTTP ${res.status}: ${text.slice(0, 300)}`, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  let j; try { j = JSON.parse(text); } catch { return { ok: false, error: `${provider}: non-JSON response`, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }; }
  const msg = j.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
    return { id: tc.id, name: tc.function?.name, input };
  });
  return {
    ok: true, text: msg.content || '', toolCalls, stopReason: j.choices?.[0]?.finish_reason || null,
    usage: { inputTokens: j.usage?.prompt_tokens || 0, outputTokens: j.usage?.completion_tokens || 0 },
  };
}

function openAiMessages(transcript) {
  const out = [];
  for (const turn of transcript) {
    if (turn.role === 'user') {
      out.push({ role: 'user', content: turn.text || '' });
    } else if (turn.role === 'assistant') {
      const m = { role: 'assistant', content: turn.text || null };
      if (turn.toolCalls?.length) {
        m.tool_calls = turn.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) } }));
      }
      // Skip an empty assistant turn — OpenAI rejects content: null with no tool_calls.
      if (m.content != null || m.tool_calls) out.push(m);
    } else if (turn.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: turn.toolCallId, content: String(turn.content ?? '') });
    }
  }
  return out;
}

// ---- Gemini generateContent (function calling) — best effort ----
async function callGemini({ apiKey, baseUrl, model, system, tools, transcript, maxTokens, signal }) {
  const base = String(baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: geminiContents(transcript),
    tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }],
    generationConfig: { maxOutputTokens: maxTokens },
  };
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `gemini HTTP ${res.status}: ${text.slice(0, 300)}`, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  let j; try { j = JSON.parse(text); } catch { return { ok: false, error: 'gemini: non-JSON response', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }; }
  const parts = j.candidates?.[0]?.content?.parts || [];
  let outText = '';
  const toolCalls = [];
  let n = 0;
  for (const p of parts) {
    if (p.text) outText += p.text;
    else if (p.functionCall) toolCalls.push({ id: `gemini-${n++}`, name: p.functionCall.name, input: p.functionCall.args || {} });
  }
  return {
    ok: true, text: outText, toolCalls, stopReason: j.candidates?.[0]?.finishReason || null,
    usage: { inputTokens: j.usageMetadata?.promptTokenCount || 0, outputTokens: j.usageMetadata?.candidatesTokenCount || 0 },
  };
}

function geminiContents(transcript) {
  const out = [];
  for (const turn of transcript) {
    if (turn.role === 'user') {
      out.push({ role: 'user', parts: [{ text: turn.text || '' }] });
    } else if (turn.role === 'assistant') {
      const parts = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const tc of turn.toolCalls || []) parts.push({ functionCall: { name: tc.name, args: tc.input || {} } });
      out.push({ role: 'model', parts });
    } else if (turn.role === 'tool') {
      out.push({ role: 'user', parts: [{ functionResponse: { name: turn.name, response: { content: String(turn.content ?? '') } } }] });
    }
  }
  return out;
}
