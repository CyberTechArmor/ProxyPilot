import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { selectedAuthRequestSchema } from '../lib/operational-selected-browser-auth-contract.js';

const sha = 'a'.repeat(64);
const request = { request_ref: 'sign-in-1', binding_sha256: sha, request_sha256: sha,
  url_sha256: sha, body_sha256: sha, body_bytes: 42, origin: 'https://example.com',
  role: 'authentication', method: 'POST', approval_ref: { id: randomUUID(), sha256: sha },
  purpose_sha256: sha, human_context: 'Manual sign-in or MFA', ledger_send_ref: sha,
  ledger_response_ref: sha, transport_complete: true };

test('authentication endpoint context preserves fixed gateway words and redacted segments', () => {
  for (const path_preview of ['/', '/api/v1/authentication/login/[redacted]',
    '/OAuth2/authorize', '//account//session/', '/mfa/challenge/[redacted]/verify']) {
    assert.equal(selectedAuthRequestSchema.parse({ ...request, path_preview }).path_preview, path_preview);
  }
});

test('authentication endpoint context rejects secrets, user IDs, query/fragment, escapes and controls', () => {
  for (const path_preview of ['', 'login', '/login/alice', '/login/42', '/login/%61pi',
    '/login/%5Bredacted%5D', '/login?code=secret', '/login#secret', '/login\\token',
    '/login/../token', '/login/\n', '/login/\u0000', '/[REDACTED]', '/login/' + '[redacted]/'.repeat(100)]) {
    assert.equal(selectedAuthRequestSchema.safeParse({ ...request, path_preview }).success, false, path_preview);
  }
});
