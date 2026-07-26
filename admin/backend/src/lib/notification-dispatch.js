// Notification dispatch — the network side of out-of-band notifications.
//
// Turns a notification message into actual email (SMTP via nodemailer) and SMS
// (a POST to a provider-agnostic webhook). Everything here is best-effort: a
// channel failure is logged + recorded against the channel's test verdict but
// never throws into the caller (a build finishing must not be derailed by a bad
// SMTP password). The pure copy comes from notification-logic.js; the in-app
// bell row is written by lib/notifications.js.

import { postNotification } from './notifications.js';
import { enabledChannels, resolveChannel, recordChannelTest } from './notification-channels.js';
import { renderSmsBody, buildCycleNotification } from './notification-logic.js';
import { sendPushToAll, pushConfigured } from './web-push.js';

// Send one email through an SMTP channel. `channel` is a resolved channel
// (config + decrypted secret). nodemailer is imported lazily so the module loads
// even where the dependency is absent (the send then reports a clean error).
export async function sendEmail(channel, { subject, text }) {
  const cfg = channel.config || {};
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    return { ok: false, error: 'nodemailer is not installed on this host' };
  }
  try {
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: !!cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: channel.secret || '' } : undefined,
      // Keep a finished-build notification from hanging the worker on a dead host.
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    const info = await transport.sendMail({
      from: cfg.from,
      to: (cfg.to || []).join(', '),
      subject,
      text,
    });
    return { ok: true, id: info?.messageId || null };
  } catch (err) {
    return { ok: false, error: err?.message || 'email send failed' };
  }
}

// Send an SMS by POSTing a rendered body to the configured webhook, once per
// recipient. Provider-agnostic: the body template + optional bearer auth cover
// the common gateway shapes. Any non-2xx response fails the whole send.
export async function sendSms(channel, { text }) {
  const cfg = channel.config || {};
  const recipients = cfg.to || [];
  const headers = { 'Content-Type': 'application/json', ...(cfg.headers || {}) };
  if (cfg.auth_scheme === 'bearer' && channel.secret) {
    headers.Authorization = `Bearer ${channel.secret}`;
  }
  try {
    for (const to of recipients) {
      const body = renderSmsBody(cfg.body_template, { to, text, token: channel.secret || '' });
      const res = await fetch(cfg.url, { method: cfg.method || 'POST', headers, body });
      if (!res.ok) {
        return { ok: false, error: `gateway responded ${res.status} for ${to}` };
      }
    }
    return { ok: true, count: recipients.length };
  } catch (err) {
    return { ok: false, error: err?.message || 'sms send failed' };
  }
}

async function sendVia(channel, message) {
  if (channel.kind === 'smtp') return sendEmail(channel, message);
  if (channel.kind === 'sms') return sendSms(channel, { text: message.sms || message.text });
  return { ok: false, error: `unknown channel kind ${channel.kind}` };
}

// Fan a message out to every enabled channel. Returns per-channel results and
// records each verdict so the admin UI reflects real delivery health.
export async function dispatchToChannels(message) {
  const results = [];
  // Web Push is not a configured "channel" like SMTP/SMS — there is no shared
  // account to set up. It is per-BROWSER: whoever opted in gets it, and it is
  // on as soon as the VAPID keys exist. Sent first because it is the one that
  // actually reaches a phone in a pocket, and it costs nothing per message.
  if (pushConfigured()) {
    try {
      const r = await sendPushToAll({
        title: message.title,
        body: message.body,
        url: message.link || '/',
        level: message.level || 'info',
        tag: message.dedupe_key || null,
      });
      results.push({ kind: 'push', ok: r.sent > 0 || (r.sent === 0 && r.failed === 0), ...r });
    } catch (err) {
      console.warn('[notify] push delivery failed:', err?.message);
      results.push({ kind: 'push', ok: false, error: err?.message });
    }
  }
  for (const channel of enabledChannels()) {
    // eslint-disable-next-line no-await-in-loop
    const r = await sendVia(channel, message);
    recordChannelTest(channel.kind, r);
    if (!r.ok) console.warn(`[notify] ${channel.kind} delivery failed: ${r.error}`);
    results.push({ kind: channel.kind, ...r });
  }
  return results;
}

// Send a one-off test through a single channel (the admin "Send test" button).
export async function testChannel(kind) {
  const channel = resolveChannel(kind);
  if (!channel) return { ok: false, error: 'channel is not configured' };
  const message = {
    subject: 'ProxyPilot test notification',
    text: 'This is a test notification from ProxyPilot. Your notification channel is working.',
    sms: 'ProxyPilot test notification — this channel is working.',
  };
  const r = await sendVia(channel, message);
  recordChannelTest(kind, r);
  return r;
}

// The producer: a build cycle reached a terminal state. Always writes the in-app
// bell row (deduped per project+outcome so a retry loop doesn't spam it), then
// fans out to the configured email/SMS channels. Best-effort and never throws.
export async function notifyCycleComplete({ project, cycle, outcome }) {
  try {
    const message = buildCycleNotification({ project, cycle, outcome });
    postNotification({
      level: message.level,
      title: message.title,
      body: message.body,
      source: 'mock2-build',
      source_id: String(project?.id ?? ''),
      dedupe_key: `mock2-build:${project?.id}:${cycle?.id}:${outcome}`,
    });
    await dispatchToChannels(message);
  } catch (err) {
    console.warn('[notify] notifyCycleComplete failed:', err?.message);
  }
}
