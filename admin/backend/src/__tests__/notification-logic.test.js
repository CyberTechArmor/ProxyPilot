// Pure notification-channel logic: recipient parsing, SMTP/SMS config
// validation, the secret-free public shape, the SMS body template renderer, and
// the finished-build notification copy. No DB / network here — this exercises
// lib/notification-logic.js in isolation (the DB + send paths are wired in
// notification-channels.js / notification-dispatch.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRecipients, validateSmtpConfig, validateSmsConfig, validateChannelConfig,
  publicChannelShape, renderSmsBody, buildCycleNotification, CHANNEL_KINDS,
} from '../lib/notification-logic.js';

test('CHANNEL_KINDS is smtp + sms', () => {
  assert.deepEqual(CHANNEL_KINDS, ['smtp', 'sms']);
});

test('parseRecipients splits on comma / space / semicolon / newline and trims', () => {
  assert.deepEqual(parseRecipients('a@x.com, b@x.com;c@x.com\n d@x.com'), ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
  assert.deepEqual(parseRecipients(['  x ', 'y', '']), ['x', 'y']);
  assert.deepEqual(parseRecipients(null), []);
  assert.deepEqual(parseRecipients(''), []);
});

test('validateSmtpConfig rejects missing/invalid fields', () => {
  assert.equal(validateSmtpConfig({}).ok, false);
  assert.equal(validateSmtpConfig({ host: 'smtp.x.com', port: 0, from: 'a@x.com', to: 'b@x.com' }).ok, false);
  assert.equal(validateSmtpConfig({ host: 'smtp.x.com', port: 587, to: 'b@x.com' }).ok, false); // no from
  assert.equal(validateSmtpConfig({ host: 'smtp.x.com', port: 587, from: 'a@x.com', to: '' }).ok, false); // no recipients
});

test('validateSmtpConfig normalises a valid config', () => {
  const r = validateSmtpConfig({ host: ' smtp.x.com ', port: '465', secure: 1, from: 'a@x.com', to: 'b@x.com, c@x.com', user: 'u' });
  assert.equal(r.ok, true);
  assert.equal(r.config.host, 'smtp.x.com');
  assert.equal(r.config.port, 465);
  assert.equal(r.config.secure, true);
  assert.deepEqual(r.config.to, ['b@x.com', 'c@x.com']);
  assert.equal(r.config.user, 'u');
});

test('validateSmtpConfig defaults an empty user to null', () => {
  const r = validateSmtpConfig({ host: 'smtp.x.com', port: 25, from: 'a@x.com', to: 'b@x.com' });
  assert.equal(r.ok, true);
  assert.equal(r.config.user, null);
});

test('validateSmsConfig requires an http(s) URL and recipients, and applies defaults', () => {
  assert.equal(validateSmsConfig({}).ok, false);
  assert.equal(validateSmsConfig({ url: 'ftp://x', to: '+1555' }).ok, false);
  assert.equal(validateSmsConfig({ url: 'https://g/send', to: '' }).ok, false);
  assert.equal(validateSmsConfig({ url: 'https://g/send', to: '+1555', method: 'DELETE' }).ok, false);

  const r = validateSmsConfig({ url: 'https://g/send', to: '+1555, +1666' });
  assert.equal(r.ok, true);
  assert.equal(r.config.method, 'POST');
  assert.equal(r.config.auth_scheme, 'bearer');
  assert.deepEqual(r.config.to, ['+1555', '+1666']);
  assert.equal(r.config.body_template, '{"to":"{{to}}","message":"{{text}}"}');
});

test('validateChannelConfig routes by kind and rejects unknown kinds', () => {
  assert.equal(validateChannelConfig('smtp', { host: 'h', port: 25, from: 'a@x', to: 'b@x' }).ok, true);
  assert.equal(validateChannelConfig('sms', { url: 'https://g', to: '+1' }).ok, true);
  assert.equal(validateChannelConfig('carrier-pigeon', {}).ok, false);
});

test('publicChannelShape never leaks the secret and reports has_secret', () => {
  const none = publicChannelShape('smtp', null);
  assert.equal(none.configured, false);
  assert.equal(none.has_secret, false);
  assert.equal(none.enabled, false);

  const row = { enabled: 1, config_json: '{"host":"smtp.x.com"}', secret_enc: 'enc:v1:...', test_status: 'ok' };
  const shaped = publicChannelShape('smtp', row);
  assert.equal(shaped.configured, true);
  assert.equal(shaped.has_secret, true);
  assert.equal(shaped.enabled, true);
  assert.equal(shaped.config.host, 'smtp.x.com');
  assert.equal(shaped.test_status, 'ok');
  assert.ok(!('secret' in shaped) && !('secret_enc' in shaped));
});

test('publicChannelShape tolerates malformed config_json', () => {
  const shaped = publicChannelShape('sms', { enabled: 0, config_json: 'not json', secret_enc: null });
  assert.deepEqual(shaped.config, {});
  assert.equal(shaped.has_secret, false);
});

test('renderSmsBody substitutes to/text/token placeholders', () => {
  const out = renderSmsBody('{"to":"{{to}}","msg":"{{text}}","k":"{{token}}"}', { to: '+1', text: 'hi', token: 'tok' });
  assert.equal(out, '{"to":"+1","msg":"hi","k":"tok"}');
});

test('buildCycleNotification: succeeded + deployed says the app is live', () => {
  const m = buildCycleNotification({
    project: { id: 1, name: 'Fly', url: 'https://fly.example.com' },
    cycle: { instruction: 'Add /health', deploy_status: 'serving' },
    outcome: 'succeeded',
  });
  assert.equal(m.level, 'info');
  assert.match(m.title, /Build finished — Fly/);
  assert.match(m.body, /live on its URL/);
  assert.match(m.body, /Add \/health/);
  assert.match(m.body, /fly\.example\.com/);
  assert.match(m.sms, /Fly/);
});

test('buildCycleNotification: succeeded without deploy says checkpointed', () => {
  const m = buildCycleNotification({ project: { name: 'Fly' }, cycle: { deploy_status: null }, outcome: 'succeeded' });
  assert.match(m.body, /checkpointed/);
});

test('buildCycleNotification: deploy_failed and failed are warnings', () => {
  const df = buildCycleNotification({ project: { name: 'Fly' }, cycle: { deploy_status: 'deploy_failed' }, outcome: 'deploy_failed' });
  assert.equal(df.level, 'warning');
  assert.match(df.title, /Deploy failed/);

  const f = buildCycleNotification({ project: { name: 'Fly' }, cycle: { error: 'boom' }, outcome: 'failed' });
  assert.equal(f.level, 'warning');
  assert.match(f.title, /Build failed/);
  assert.match(f.text, /boom/);
});

test('buildCycleNotification: paused is an info-level resumable message', () => {
  const m = buildCycleNotification({
    project: { name: 'Fly' },
    cycle: { error: 'Paused — token budget reached (~1000k tokens this run).' },
    outcome: 'paused',
  });
  assert.equal(m.level, 'info');
  assert.match(m.title, /Build paused/);
  assert.match(m.text, /Resume it to continue/);
  assert.match(m.sms, /resume/i);
});

test('buildCycleNotification truncates a very long instruction', () => {
  const long = 'x'.repeat(400);
  const m = buildCycleNotification({ project: { name: 'Fly' }, cycle: { instruction: long, deploy_status: 'serving' }, outcome: 'succeeded' });
  assert.ok(m.body.includes('…'));
});

test('buildCycleNotification: pending_verification is a calm completion, never "failed" (P48)', () => {
  const m = buildCycleNotification({
    project: { id: 48, name: 'Noteme', url: 'https://noteme.example' },
    cycle: { instruction: 'Build the working application from the approved design inventory', deploy_status: 'serving' },
    outcome: 'pending_verification',
  });
  assert.equal(m.level, 'info');
  assert.match(m.title, /Build complete — verify when ready/);
  assert.doesNotMatch(m.title, /failed/i);
  assert.match(m.body, /deployed and live/);
  assert.match(m.body, /not failed/);
  assert.match(m.sms, /await your confirmation/);
});
