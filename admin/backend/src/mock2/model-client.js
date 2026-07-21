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
//   { role:'user', text, images?:[{ media_type, data(base64) }] }
//   { role:'assistant', text, toolCalls:[{ id, name, input }] }
//   { role:'tool', toolCallId, name, content }
// User-turn images (multi-modal chat) map to each provider's native block:
// Anthropic image blocks, OpenAI image_url data URIs, Gemini inlineData. Images
// precede the text block (the recommended order for vision prompts).
// callModelTurn returns:
//   { ok, text, toolCalls:[{ id, name, input }], usage:{ inputTokens, outputTokens }, stopReason, error }
//
// Terminology (risk R7): the slot is build_runner; nothing here is named "agent".

import { anthropicTuning } from './routing-logic.js';

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
// `serverTools` are provider-executed tool entries passed RAW (e.g. Anthropic's
// {type:'web_search_20250305', name:'web_search', max_uses}) — the provider runs
// them inside the API call itself, so they need no local execution, no fence
// egress, and no toolCalls handling here. Only the Anthropic path supports them;
// other providers ignore the parameter (callers gate on connector.provider via
// ask-logic.webSearchServerTools, so nothing is silently dropped in practice).
// `effort` ('low'|'medium'|'high'|'xhigh'|'max' or null) tunes reasoning depth
// and token spend. Anthropic path only: routing-logic.anthropicTuning gates it
// per model id — capable models also get adaptive thinking switched ON (they
// otherwise run WITHOUT thinking on Opus 4.7/4.8, where omitting the parameter
// means off). Unrecognized/older models and other providers get neither field,
// so behavior there is byte-identical to before.
// `onDelta(textChunk)` opts into STREAMING where the provider path supports it
// (Anthropic today): visible text is delivered incrementally as it generates,
// and the final return value is byte-identical in shape to the non-streaming
// call (including the replayable `raw` content array). Providers without a
// streaming path here simply ignore the callback — same result, one delivery.
// isTransientModelError — network/stream-level failures and provider-side
// overload that a fresh attempt genuinely can fix. NOT timeouts (the caller
// owns those), NOT 4xx (the request itself is wrong). "terminated" is the
// undici error for a connection dropped mid-response — a live chat turn died
// on exactly that with no retry (operator report).
export function isTransientModelError(message) {
  const m = String(message || '');
  if (/timed out|aborted/i.test(m)) return false;
  return /terminated|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|other side closed|UND_ERR|premature close|network error|HTTP (?:429|5\d\d)\b|overloaded/i.test(m);
}

export async function callModelTurn(args) {
  // One automatic retry on TRANSIENT failures (dropped connection, provider
  // overload) — every lane shares this, so a network blip no longer kills a
  // whole turn. A retried STREAMING call restarts its deltas from the top;
  // callers' partial previews may briefly show stale text, but the returned
  // result is always the successful attempt's alone.
  for (let attempt = 1; ; attempt++) {
    const res = await callModelOnce(args);
    if (res.ok || res.timedOut || attempt >= 2 || !isTransientModelError(res.error)) return res;
    console.warn(`[mock2] transient model error — retrying once: ${String(res.error).slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function callModelOnce({
  connector, apiKey = null, model, system, tools = [], transcript = [], maxTokens = 8000, timeoutMs = null, serverTools = [], effort = null, onDelta = null, thinking = null,
}) {
  const provider = connector?.provider;
  // The abort deadline scales with the REQUESTED OUTPUT unless the caller pins
  // one: a 16k-token mockup legitimately streams for several minutes, and the
  // old flat 2-minute timeout aborted it mid-generation ("This operation was
  // aborted") — a large ask needs a proportionate window (~50ms/token floor).
  const effectiveTimeoutMs = timeoutMs != null ? timeoutMs : Math.max(DEFAULT_TIMEOUT_MS, Number(maxTokens || 0) * 50);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  try {
    switch (provider) {
      case 'anthropic':
        return await callAnthropic({ apiKey, baseUrl: connector.base_url, model, system, tools, transcript, maxTokens, signal: controller.signal, serverTools, effort, onDelta, thinking });
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
    // Name a timeout as what it is — "This operation was aborted" reads like a
    // user action when it was our own deadline firing.
    const msg = err?.name === 'AbortError' || /abort/i.test(String(err?.message || ''))
      ? `timed out after ${Math.round(effectiveTimeoutMs / 1000)}s waiting for the model response (the request was cancelled server-side)`
      : (err?.message || String(err));
    return { ok: false, timedOut: err?.name === 'AbortError' || /abort/i.test(String(err?.message || '')), error: `model call failed: ${msg}`, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Anthropic Messages API (tool use) ----
async function callAnthropic({ apiKey, baseUrl, model, system, tools, transcript, maxTokens, signal, serverTools = [], effort = null, onDelta = null, thinking = null }) {
  const url = `${String(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;
  const messages = withMessageCacheBreakpoint(anthropicMessages(transcript));
  // Stream when the caller wants deltas OR the request is HEAVY: images in the
  // transcript, or a large output budget. A heavy non-streaming request can
  // take minutes to first byte (image processing + adaptive thinking), and
  // Node's undici transport drops the socket at its ~5-min headers timeout —
  // surfacing as a bare "fetch failed". Streaming keeps bytes flowing so the
  // timeout never trips (Anthropic's own guidance for long output / large
  // max_tokens / image input). onDelta still only fires when the caller
  // provided one — heavy internal calls stream transparently.
  const hasImages = (transcript || []).some((t) => t?.role === 'user' && Array.isArray(t.images) && t.images.length);
  const HEAVY_MAX_TOKENS = 12000;
  const streaming = typeof onDelta === 'function' || hasImages || Number(maxTokens) >= HEAVY_MAX_TOKENS;
  const emitDelta = typeof onDelta === 'function' ? onDelta : null;
  const body = {
    model,
    max_tokens: maxTokens,
    ...(streaming ? { stream: true } : {}),
    // Adaptive thinking + effort, gated per model id (see routing-logic).
    // thinking:'off' suppresses adaptive thinking (pure-output tasks like the
    // mockup render, where thinking would just consume the output budget).
    ...anthropicTuning({ model, effort, thinking }),
    // Prompt caching (rate-limit mitigation): the framework constitution / design
    // system / rules are large and STABLE across a conversation, and so is the
    // growing message history — reprocessing them every back-and-forth burns ITPM
    // (cache_read tokens don't count against the input-tokens-per-minute limit;
    // only uncached input + cache writes do). Render order is tools → system →
    // messages, so a breakpoint on the last system block caches tools + system
    // together, and one on the last message block caches the whole conversation
    // prefix — each new turn then only pays for the new turns. Below the model's
    // minimum cacheable size it silently no-ops, which is fine.
    ...(system ? { system: [{ type: 'text', text: String(system), cache_control: { type: 'ephemeral' } }] } : {}),
    // Function tools first, then provider-executed server tools verbatim (e.g.
    // web_search — Anthropic runs the search server-side during this call; the
    // response's server_tool_use / web_search_tool_result blocks are informational
    // and fall through the block loop below, which only lifts text + tool_use).
    tools: [
      ...tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      ...(Array.isArray(serverTools) ? serverTools : []),
    ],
    messages,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `anthropic HTTP ${res.status}: ${text.slice(0, 300)}`, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
  // Streaming path: accumulate SSE events back into the exact non-streaming
  // response shape (a proxy that strips SSE falls through to the JSON path).
  if (streaming && String(res.headers.get('content-type') || '').includes('text/event-stream')) {
    return anthropicAccumulateStream(res, emitDelta);
  }
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { return { ok: false, error: 'anthropic: non-JSON response', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }; }
  let outText = '';
  const toolCalls = [];
  for (const block of j.content || []) {
    if (block.type === 'text') outText += block.text || '';
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
  }
  return {
    // `raw` is the verbatim Anthropic content array. With adaptive thinking on,
    // thinking blocks MUST be replayed unchanged on the same model (stripping
    // them can 400 on signature/ordering), and server-tool blocks round-trip
    // the same way — so callers store `raw` on the assistant turn and
    // anthropicMessages replays it verbatim. Other providers ignore it.
    ok: true, text: outText, toolCalls, raw: Array.isArray(j.content) ? j.content : null,
    stopReason: j.stop_reason || null,
    usage: {
      inputTokens: j.usage?.input_tokens || 0,
      outputTokens: j.usage?.output_tokens || 0,
      // Surfaced for observability; cache_read is free on ITPM, cache_creation is
      // charged like input. Callers that only read input/output tokens still work.
      cacheReadInputTokens: j.usage?.cache_read_input_tokens || 0,
      cacheCreationInputTokens: j.usage?.cache_creation_input_tokens || 0,
    },
  };
}

// anthropicAccumulateStream — reassemble the SSE event stream into the exact
// non-streaming response shape. The reconstruction follows the documented
// rules: content_block_start seeds each block; text_delta / thinking_delta
// append text; input_json_delta accumulates the tool input as a string,
// parsed at content_block_stop; signature_delta stamps the thinking-block
// signature. The resulting `raw` array is therefore replay-safe (thinking
// blocks return unchanged, signatures intact). Only visible text-block deltas
// reach onDelta — thinking and tool-input JSON never leak to the UI.
async function anthropicAccumulateStream(res, onDelta) {
  const blocks = [];
  const jsonAcc = new Map(); // block index → accumulating partial_json string
  let stopReason = null;
  let streamError = null;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  const handleEvent = (data) => {
    let ev; try { ev = JSON.parse(data); } catch { return; }
    switch (ev.type) {
      case 'message_start': {
        const u = ev.message?.usage || {};
        usage.input = u.input_tokens || 0;
        usage.cacheRead = u.cache_read_input_tokens || 0;
        usage.cacheCreation = u.cache_creation_input_tokens || 0;
        break;
      }
      case 'content_block_start': {
        blocks[ev.index] = { ...(ev.content_block || {}) };
        const t = ev.content_block?.type;
        if (t === 'tool_use' || t === 'server_tool_use' || t === 'mcp_tool_use') jsonAcc.set(ev.index, '');
        break;
      }
      case 'content_block_delta': {
        const b = blocks[ev.index];
        const d = ev.delta || {};
        if (!b) break;
        if (d.type === 'text_delta') {
          b.text = (b.text || '') + (d.text || '');
          if (onDelta && b.type === 'text' && d.text) { try { onDelta(d.text); } catch { /* UI callback must never kill the call */ } }
        } else if (d.type === 'input_json_delta') {
          jsonAcc.set(ev.index, (jsonAcc.get(ev.index) || '') + (d.partial_json || ''));
        } else if (d.type === 'thinking_delta') {
          b.thinking = (b.thinking || '') + (d.thinking || '');
        } else if (d.type === 'signature_delta') {
          b.signature = d.signature;
        }
        break;
      }
      case 'content_block_stop': {
        const b = blocks[ev.index];
        if (b && jsonAcc.has(ev.index)) {
          const s = jsonAcc.get(ev.index);
          jsonAcc.delete(ev.index);
          if (s) { try { b.input = JSON.parse(s); } catch { b.input = {}; } }
          else if (b.input == null) b.input = {};
        }
        break;
      }
      case 'message_delta': {
        stopReason = ev.delta?.stop_reason || stopReason;
        if (ev.usage?.output_tokens != null) usage.output = ev.usage.output_tokens;
        break;
      }
      case 'error': {
        streamError = ev.error?.message || 'stream error';
        break;
      }
      default: break; // ping, message_stop
    }
  };

  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const rawEvent = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
      }
    }
    if (streamError) break;
  }
  if (streamError) {
    return { ok: false, error: `anthropic stream: ${streamError}`, toolCalls: [], usage: { inputTokens: usage.input, outputTokens: usage.output } };
  }

  const content = blocks.filter(Boolean);
  let outText = '';
  const toolCalls = [];
  for (const block of content) {
    if (block.type === 'text') outText += block.text || '';
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
  }
  return {
    ok: true, text: outText, toolCalls, raw: content.length ? content : null,
    stopReason,
    usage: {
      inputTokens: usage.input, outputTokens: usage.output,
      cacheReadInputTokens: usage.cacheRead, cacheCreationInputTokens: usage.cacheCreation,
    },
  };
}

// Put a single cache breakpoint on the last content block of the last message so
// the entire conversation prefix caches; the next turn reads it back instead of
// reprocessing every prior turn. Non-mutating (clones the touched message +
// block). anthropicMessages always emits object blocks, so there's a block to
// mark; a request with no messages is left untouched.
function withMessageCacheBreakpoint(messages) {
  if (!messages.length) return messages;
  const out = messages.slice();
  const lastIdx = out.length - 1;
  const last = out[lastIdx];
  if (Array.isArray(last.content) && last.content.length) {
    const content = last.content.map((b) => ({ ...b }));
    const tail = content[content.length - 1];
    // Anthropic 400s on cache_control over an EMPTY text block ("cache_control
    // cannot be set for empty text blocks") — skip the breakpoint rather than
    // reject the whole request when the last block carries no text.
    if (!(tail.type === 'text' && !String(tail.text || '').length)) {
      content[content.length - 1] = { ...tail, cache_control: { type: 'ephemeral' } };
      out[lastIdx] = { ...last, content };
    }
  }
  return out;
}

function anthropicMessages(transcript) {
  const out = [];
  for (const turn of transcript) {
    if (turn.role === 'user') {
      const content = (turn.images || []).map((img) => ({
        type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data },
      }));
      content.push({ type: 'text', text: turn.text || '' });
      out.push({ role: 'user', content });
    } else if (turn.role === 'assistant') {
      // Verbatim replay when the raw Anthropic blocks were captured — REQUIRED
      // once adaptive thinking is on (thinking blocks must return unchanged,
      // in their original interleaved order, on the same model).
      if (Array.isArray(turn.raw) && turn.raw.length) {
        out.push({ role: 'assistant', content: turn.raw });
        continue;
      }
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
      if (turn.images?.length) {
        out.push({
          role: 'user',
          content: [
            ...turn.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.media_type};base64,${img.data}` } })),
            { type: 'text', text: turn.text || '' },
          ],
        });
      } else {
        out.push({ role: 'user', content: turn.text || '' });
      }
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
      const parts = (turn.images || []).map((img) => ({ inlineData: { mimeType: img.media_type, data: img.data } }));
      parts.push({ text: turn.text || '' });
      out.push({ role: 'user', parts });
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
