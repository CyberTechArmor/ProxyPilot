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
