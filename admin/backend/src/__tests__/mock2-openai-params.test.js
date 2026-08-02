// The OpenAI output-cap parameter split (live-build failure: "openai HTTP
// 400: Unsupported parameter: 'max_tokens' is not supported with this model.
// Use 'max_completion_tokens' instead." — retries exhausted, build blocked).
//
// api.openai.com's gpt-5.x models take max_completion_tokens; operator-hosted
// OpenAI-compatible endpoints mostly still take max_tokens. The client picks
// per provider and swap-retries once on a rejection in EITHER direction.
//
// Stub-first (risk R9): imports only model-client.js (native-free).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  openAiTokenParamForProvider,
  isTokenParamRejection,
  swapOpenAiTokenParam,
  adaptOpenAiBodyForError,
} from '../mock2/model-client.js';

test('api.openai.com gets max_completion_tokens; compatible/ollama keep max_tokens', () => {
  assert.equal(openAiTokenParamForProvider('openai'), 'max_completion_tokens');
  assert.equal(openAiTokenParamForProvider('openai_compatible'), 'max_tokens');
  assert.equal(openAiTokenParamForProvider('ollama'), 'max_tokens');
});

test('the exact live-build 400 is recognized as a token-param rejection', () => {
  const body = JSON.stringify({
    error: {
      message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter',
    },
  });
  assert.equal(isTokenParamRejection(400, body), true);
  // The reverse direction (an endpoint that only knows max_tokens) too.
  assert.equal(isTokenParamRejection(400, '{"error":{"message":"Unknown parameter: max_completion_tokens"}}'), true);
});

test('unrelated errors never trigger the swap-retry', () => {
  assert.equal(isTokenParamRejection(400, '{"error":{"message":"invalid model id"}}'), false);
  assert.equal(isTokenParamRejection(401, "Unsupported parameter: 'max_tokens'"), false); // auth, not params
  assert.equal(isTokenParamRejection(500, 'max_tokens exploded'), false);
  assert.equal(isTokenParamRejection(400, ''), false);
});

test('swapOpenAiTokenParam flips the spelling both ways, preserving the cap and the rest', () => {
  const a = swapOpenAiTokenParam({ model: 'gpt-5.6-luna', max_tokens: 64000, messages: [1] });
  assert.deepEqual(a, { model: 'gpt-5.6-luna', max_completion_tokens: 64000, messages: [1] });
  const b = swapOpenAiTokenParam(a);
  assert.deepEqual(b, { model: 'gpt-5.6-luna', max_tokens: 64000, messages: [1] });
  // No cap present → untouched.
  const c = { model: 'x' };
  assert.deepEqual(swapOpenAiTokenParam(c), c);
});

// ---- the tools + default-reasoning conflict (second live-build failure) ----

const REASONING_TOOLS_400 = JSON.stringify({
  error: {
    message: "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
    type: 'invalid_request_error', param: 'reasoning_effort', code: null,
  },
});

test("the exact live 400 adapts to reasoning_effort:'none' (server default, request never set it)", () => {
  const body = { model: 'gpt-5.6-luna', max_completion_tokens: 64000, tools: [{}], messages: [] };
  const adapted = adaptOpenAiBodyForError(body, 400, REASONING_TOOLS_400);
  assert.ok(adapted, 'must adapt');
  assert.equal(adapted.body.reasoning_effort, 'none');
  assert.equal(adapted.body.max_completion_tokens, 64000); // everything else untouched
});

test("reasoning_effort itself unsupported → stripped; already-'none' does not loop", () => {
  const unsupported = '{"error":{"message":"Unsupported parameter: reasoning_effort","code":"unsupported_parameter"}}';
  const stripped = adaptOpenAiBodyForError({ model: 'x', reasoning_effort: 'none', max_tokens: 1 }, 400, unsupported);
  assert.ok(stripped);
  assert.ok(!('reasoning_effort' in stripped.body));
  // A body ALREADY at 'none' hitting the tools-conflict text again must not
  // re-adapt to the same body forever — with 'none' set and no unsupported-
  // parameter wording match on 'in' check path, the strip branch handles it.
  const again = adaptOpenAiBodyForError({ model: 'x', reasoning_effort: 'none', tools: [{}] }, 400, REASONING_TOOLS_400);
  // The tools-conflict branch is skipped (already 'none'); the strip branch
  // fires because the message says "not supported" and names the param.
  assert.ok(again && !('reasoning_effort' in again.body));
});

test('adaptOpenAiBodyForError: token-param class first, unrelated errors → null', () => {
  const tokenErr = "{\"error\":{\"message\":\"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.\",\"code\":\"unsupported_parameter\"}}";
  const a = adaptOpenAiBodyForError({ model: 'x', max_tokens: 5 }, 400, tokenErr);
  assert.deepEqual(a.body, { model: 'x', max_completion_tokens: 5 });
  assert.equal(adaptOpenAiBodyForError({ model: 'x' }, 400, '{"error":{"message":"invalid model"}}'), null);
  assert.equal(adaptOpenAiBodyForError({ model: 'x' }, 429, REASONING_TOOLS_400), null);
});
