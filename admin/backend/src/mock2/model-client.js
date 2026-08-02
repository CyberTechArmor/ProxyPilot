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
import { sniffImageMediaType } from './chat-image-logic.js';

const DEFAULT_TIMEOUT_MS = 120000;

// The declared media type checked against the image's magic bytes — the bytes
// win. Attachments stored before the upload gate sniffed types can carry a
// browser's lie (WebP bytes labeled image/png), and Anthropic rejects the
// whole request on the mismatch; the OpenAI and Gemini shapes get the
// corrected type too.
function imageMediaType(img) {
  return sniffImageMediaType(img?.data) || img?.media_type || 'image/png';
}

// Idle watchdog for STREAMING calls. The overall deadline below scales with the
// requested output (~50ms/token), so a 128k-token budget legitimately gets a
// ~106-minute window — but that window assumed bytes keep flowing. A connection
// that dies mid-stream WITHOUT an error (the observed "API hiccuped and the
// build stopped" wedge) otherwise sits silent for the whole deadline, which
// reads as a dead platform. If no bytes arrive for this long the request is
// aborted and surfaced as a stall (timedOut, so the cycle-level retry machinery
// owns recovery — not the blind in-call retry). MOCK2_MODEL_IDLE_TIMEOUT_MS
// overrides; "off"/"0" disables; floored so a typo can't abort every call.
const DEFAULT_IDLE_TIMEOUT_MS = 300000; // 5 minutes of silence = dead connection
const MIN_IDLE_TIMEOUT_MS = 30000;

export function modelIdleTimeoutMs(env = process.env) {
  const raw = String(env?.MOCK2_MODEL_IDLE_TIMEOUT_MS ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.max(MIN_IDLE_TIMEOUT_MS, Math.floor(n));
}

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
  connector, apiKey = null, model, system, tools = [], transcript = [], maxTokens = 8000, timeoutMs = null, serverTools = [], effort = null, onDelta = null, thinking = null, cacheTtl = null,
}) {
  const provider = connector?.provider;
  // The abort deadline scales with the REQUESTED OUTPUT unless the caller pins
  // one: a 16k-token mockup legitimately streams for several minutes, and the
  // old flat 2-minute timeout aborted it mid-generation ("This operation was
  // aborted") — a large ask needs a proportionate window (~50ms/token floor).
  const effectiveTimeoutMs = timeoutMs != null ? timeoutMs : Math.max(DEFAULT_TIMEOUT_MS, Number(maxTokens || 0) * 50);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  // Idle watchdog — armed by the stream reader (onActivity fires when headers
  // land and on every received chunk), so it only ever runs on a path that
  // streams. Non-streaming requests are already covered by undici's ~5-minute
  // headers timeout plus the overall deadline above.
  const idleMs = modelIdleTimeoutMs();
  let idleTimer = null;
  let idleFired = false;
  const onActivity = idleMs > 0 ? () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleFired = true; controller.abort(); }, idleMs);
  } : null;
  try {
    switch (provider) {
      case 'anthropic':
        return await callAnthropic({ apiKey, baseUrl: connector.base_url, model, system, tools, transcript, maxTokens, signal: controller.signal, serverTools, effort, onDelta, thinking, onActivity, cacheTtl });
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
    // Name a stall as a stall: the idle watchdog firing means the connection
    // went silent mid-response, which is a very different fact from "the model
    // legitimately used its whole window". Both count as timedOut (the caller
    // owns recovery), but the message must say what actually happened.
    if (idleFired) {
      return { ok: false, timedOut: true, stalled: true, error: `model call failed: the response stream went silent for ${Math.round(idleMs / 1000)}s (the connection likely dropped mid-response) — the request was cancelled server-side`, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
    }
    // Name a timeout as what it is — "This operation was aborted" reads like a
    // user action when it was our own deadline firing.
    const msg = err?.name === 'AbortError' || /abort/i.test(String(err?.message || ''))
      ? `timed out after ${Math.round(effectiveTimeoutMs / 1000)}s waiting for the model response (the request was cancelled server-side)`
      : (err?.message || String(err));
    return { ok: false, timedOut: err?.name === 'AbortError' || /abort/i.test(String(err?.message || '')), error: `model call failed: ${msg}`, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
  }
}

// ---- Anthropic Messages API (tool use) ----
async function callAnthropic({ apiKey, baseUrl, model, system, tools, transcript, maxTokens, signal, serverTools = [], effort = null, onDelta = null, thinking = null, onActivity = null, cacheTtl = null }) {
  const url = `${String(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;
  // cacheTtl:'1h' opts a lane into the 1-hour cache (2x write vs 1.25x for
  // the default 5-minute TTL, ~0.1x reads either way). Worth it for long
  // build cycles where slow gate batteries / tool runs stretch the gap
  // between turns past 5 minutes — without it every such gap re-writes the
  // whole transcript prefix at full write price. Break-even is ~3 reads per
  // write, which a multi-turn runner loop clears trivially; short chat lanes
  // stay on the default.
  const cacheControl = cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  const messages = withMessageCacheBreakpoint(anthropicMessages(transcript), cacheControl);
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
    ...(system ? { system: [{ type: 'text', text: String(system), cache_control: cacheControl }] } : {}),
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
  // Headers landed — the connection is alive; the stream reader keeps bumping
  // the idle watchdog from here (a silent death mid-stream is what it catches).
  if (onActivity) { try { onActivity(); } catch { /* watchdog must never kill the call */ } }
  // Streaming path: accumulate SSE events back into the exact non-streaming
  // response shape (a proxy that strips SSE falls through to the JSON path).
  if (streaming && String(res.headers.get('content-type') || '').includes('text/event-stream')) {
    return anthropicAccumulateStream(res, emitDelta, onActivity);
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
async function anthropicAccumulateStream(res, onDelta, onActivity = null) {
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
    // Every received chunk (including pings) proves the connection is alive —
    // bump the idle watchdog so only true silence trips it.
    if (onActivity) { try { onActivity(); } catch { /* watchdog must never kill the call */ } }
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
function withMessageCacheBreakpoint(messages, cacheControl = { type: 'ephemeral' }) {
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
      content[content.length - 1] = { ...tail, cache_control: { ...cacheControl } };
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
        type: 'image', source: { type: 'base64', media_type: imageMediaType(img), data: img.data },
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
// ---- OpenAI output-cap parameter (the max_tokens → max_completion_tokens split) ----
//
// api.openai.com's current models (the gpt-5.x family) REJECT `max_tokens`
// with HTTP 400 unsupported_parameter — they take `max_completion_tokens`.
// Operator-hosted OpenAI-compatible endpoints (ollama, llama.cpp, vLLM, older
// gateways) mostly still speak `max_tokens`. So: pick the right spelling per
// provider up front, and if the endpoint rejects whichever we sent, retry
// ONCE with the other spelling — both directions, so an old OpenAI model or a
// new-style compatible gateway also work. Pure helpers, unit-tested (the
// live-build failure mode: "Retries exhausted — openai HTTP 400: Unsupported
// parameter: 'max_tokens'… Use 'max_completion_tokens' instead").
export function openAiTokenParamForProvider(provider) {
  return provider === 'openai' ? 'max_completion_tokens' : 'max_tokens';
}

export function isTokenParamRejection(status, bodyText) {
  if (Number(status) !== 400) return false;
  const t = String(bodyText || '');
  return /max_(completion_)?tokens/i.test(t)
    && /(unsupported[_ ]parameter|not supported|unknown[_ ]parameter|unrecognized)/i.test(t);
}

export function swapOpenAiTokenParam(body = {}) {
  if ('max_tokens' in body) {
    const { max_tokens: cap, ...rest } = body;
    return { ...rest, max_completion_tokens: cap };
  }
  if ('max_completion_tokens' in body) {
    const { max_completion_tokens: cap, ...rest } = body;
    return { ...rest, max_tokens: cap };
  }
  return body;
}

// adaptOpenAiBodyForError — given a 400 response, the ONE body change that
// addresses it, or null when the error isn't an adaptable parameter shape.
// The adaptable classes (both observed on live builds):
//   * output-cap spelling (max_tokens ↔ max_completion_tokens);
//   * "Function tools with reasoning_effort are not supported for <model> in
//     /v1/chat/completions … set reasoning_effort to 'none'" — the server
//     applies a DEFAULT reasoning effort on gpt-5.x reasoning models, so a
//     request that never mentioned reasoning_effort still trips it; the fix
//     is to opt out explicitly;
//   * reasoning_effort itself unsupported on the model → strip it.
export function adaptOpenAiBodyForError(body = {}, status, bodyText) {
  if (Number(status) !== 400) return null;
  const t = String(bodyText || '');
  if (isTokenParamRejection(status, t)) {
    return { body: swapOpenAiTokenParam(body), reason: 'rejected the output-cap parameter spelling — swapping' };
  }
  if (/reasoning_effort/i.test(t) && /tools/i.test(t) && body.reasoning_effort !== 'none') {
    return { body: { ...body, reasoning_effort: 'none' }, reason: "tools + default reasoning conflict — setting reasoning_effort:'none'" };
  }
  if (/reasoning_effort/i.test(t) && /(unsupported[_ ]parameter|unknown[_ ]parameter|not supported|unrecognized)/i.test(t) && 'reasoning_effort' in body) {
    const { reasoning_effort: _drop, ...rest } = body;
    return { body: rest, reason: 'reasoning_effort unsupported here — removing it' };
  }
  return null;
}

// What an adaptation taught us about a model, remembered for the rest of the
// process so the runner's hundreds of calls don't each pay a wasted 400
// round-trip re-learning it. Keyed provider|model; values are body patches
// applied up front on later calls.
const openAiParamMemory = new Map();

function openAiMemoryKey(provider, model) { return `${provider}|${String(model || '').toLowerCase()}`; }

function rememberOpenAiParams(provider, model, body) {
  openAiParamMemory.set(openAiMemoryKey(provider, model), {
    tokenParam: 'max_completion_tokens' in body ? 'max_completion_tokens' : 'max_tokens',
    reasoningEffortNone: body.reasoning_effort === 'none',
  });
}

async function callOpenAiCompatible({ provider, apiKey, baseUrl, model, system, tools, transcript, maxTokens, signal }) {
  const url = `${openAiBase(provider, baseUrl)}/chat/completions`;
  const messages = [{ role: 'system', content: system }, ...openAiMessages(transcript)];
  const learned = openAiParamMemory.get(openAiMemoryKey(provider, model)) || null;
  let body = {
    model,
    [learned?.tokenParam || openAiTokenParamForProvider(provider)]: maxTokens,
    messages,
    // An EMPTY tools array is rejected by some OpenAI-compatible servers —
    // omit tools/tool_choice entirely on tool-free calls.
    ...(tools.length ? {
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: 'auto',
    } : {}),
  };
  // gpt-5.6-luna applies a DEFAULT reasoning effort, and /v1/chat/completions
  // rejects function tools under it ("… set reasoning_effort to 'none'" — the
  // live-build failure) — opt out explicitly on tool calls, up front for the
  // known model and remembered per model after an adaptive retry teaches us.
  // Deliberately NOT family-wide: if sol/terra DO support tools + reasoning,
  // a blanket 'none' would silently disable their reasoning; they learn via
  // one adaptation instead.
  if (tools.length && provider === 'openai' && (learned?.reasoningEffortNone || /gpt-5[.-]6-luna\b/.test(String(model).toLowerCase()))) {
    body.reasoning_effort = 'none';
  }
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  let text = await res.text();
  // Adaptive parameter retries: at most two, each applying the ONE change the
  // 400 asked for (output-cap spelling, reasoning_effort opt-out/strip). A
  // successful adaptation is remembered so later calls start correct.
  for (let i = 0; i < 2 && !res.ok; i++) {
    const adapted = adaptOpenAiBodyForError(body, res.status, text);
    if (!adapted) break;
    body = adapted.body;
    console.warn(`[mock2] ${provider}/${model}: ${adapted.reason} — retrying`);
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    text = await res.text();
  }
  if (res.ok) rememberOpenAiParams(provider, model, body);
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
    // OpenAI caches long prompt prefixes AUTOMATICALLY (no cache_control to send)
    // and reports the hit in prompt_tokens_details.cached_tokens. prompt_tokens
    // is the TOTAL, cached included — so bill the cached part at the cache-read
    // rate and only the remainder at full input rate, exactly like the Anthropic
    // path. Ignoring it (the old behavior) billed cache hits at 1× and reported
    // zero cache reads, overstating OpenAI cost in the ledger and quota ceilings.
    // There is no cache-write class here: OpenAI does not charge one.
    usage: (() => {
      const prompt = j.usage?.prompt_tokens || 0;
      const cached = j.usage?.prompt_tokens_details?.cached_tokens || 0;
      const cacheRead = Math.min(Math.max(cached, 0), prompt);
      return {
        inputTokens: prompt - cacheRead,
        outputTokens: j.usage?.completion_tokens || 0,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: 0,
      };
    })(),
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
            ...turn.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${imageMediaType(img)};base64,${img.data}` } })),
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
      const parts = (turn.images || []).map((img) => ({ inlineData: { mimeType: imageMediaType(img), data: img.data } }));
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
