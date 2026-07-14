// Notification-channel logic (pure — no DB, no network, no nodemailer).
//
// The admin can wire two "standard connections" for out-of-band alerts on top of
// the in-app bell: an SMTP email channel and a provider-agnostic SMS-over-HTTP
// channel. This module owns the shapes, validation, the public (secret-free)
// projection, and the message rendered for a finished build cycle — everything
// that must be unit-testable without a database or a socket.

export const CHANNEL_KINDS = ['smtp', 'sms'];

// A comma / newline / space separated recipient string → a clean array. Used for
// both email addresses and phone numbers (the split rules are identical).
export function parseRecipients(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value == null) return [];
  return String(value)
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Validate the non-secret SMTP config. The password is a secret and validated
// separately (present-or-already-stored is enforced at the route/DB layer).
export function validateSmtpConfig(config = {}) {
  if (!isPlainObject(config)) return { ok: false, error: 'config must be an object' };
  const host = String(config.host || '').trim();
  if (!host) return { ok: false, error: 'SMTP host is required' };
  const port = Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'SMTP port must be a number between 1 and 65535' };
  }
  const from = String(config.from || '').trim();
  if (!from) return { ok: false, error: 'a From address is required' };
  const to = parseRecipients(config.to);
  if (to.length === 0) return { ok: false, error: 'at least one recipient (To) address is required' };
  return {
    ok: true,
    config: {
      host,
      port,
      secure: !!config.secure,
      user: String(config.user || '').trim() || null,
      from,
      to,
    },
  };
}

// Validate the non-secret SMS config. Provider-agnostic: the channel POSTs a
// rendered body to a webhook URL. The auth token is a secret, added as a Bearer
// header (or referenced via the {{token}} placeholder in the body template).
export function validateSmsConfig(config = {}) {
  if (!isPlainObject(config)) return { ok: false, error: 'config must be an object' };
  const url = String(config.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'a webhook URL (http/https) is required' };
  const method = String(config.method || 'POST').trim().toUpperCase();
  if (!['POST', 'PUT'].includes(method)) return { ok: false, error: 'method must be POST or PUT' };
  const to = parseRecipients(config.to);
  if (to.length === 0) return { ok: false, error: 'at least one recipient phone number is required' };
  const bodyTemplate = String(config.body_template || '').trim()
    || '{"to":"{{to}}","message":"{{text}}"}';
  return {
    ok: true,
    config: {
      url,
      method,
      to,
      body_template: bodyTemplate,
      // Optional non-secret headers (e.g. a content type override). The auth
      // token is applied separately from the encrypted secret.
      headers: isPlainObject(config.headers) ? config.headers : {},
      auth_scheme: String(config.auth_scheme || 'bearer').trim().toLowerCase(), // 'bearer' | 'none'
    },
  };
}

export function validateChannelConfig(kind, config) {
  if (kind === 'smtp') return validateSmtpConfig(config);
  if (kind === 'sms') return validateSmsConfig(config);
  return { ok: false, error: `unknown channel kind ${JSON.stringify(kind)}` };
}

// The secret-free view of a channel row for the admin UI. Never returns the
// stored secret — only whether one is set (so the form can show "configured"
// without echoing it back).
export function publicChannelShape(kind, row) {
  let config = {};
  if (row?.config_json) {
    try { config = JSON.parse(row.config_json); } catch { config = {}; }
  }
  return {
    kind,
    enabled: row ? Number(row.enabled) === 1 : false,
    configured: !!row,
    has_secret: !!(row && row.secret_enc),
    config,
    test_status: row?.test_status || null,
    test_error: row?.test_error || null,
    test_at: row?.test_at || null,
    updated_at: row?.updated_at || null,
  };
}

// Render the {{to}} / {{text}} / {{token}} placeholders in an SMS body template.
export function renderSmsBody(template, { to, text, token }) {
  return String(template || '')
    .replace(/\{\{\s*to\s*\}\}/g, String(to ?? ''))
    .replace(/\{\{\s*text\s*\}\}/g, String(text ?? ''))
    .replace(/\{\{\s*token\s*\}\}/g, String(token ?? ''));
}

// The one place that turns a finished build cycle into the notification copy
// used across every channel (in-app bell, email subject/body, SMS text). Pure so
// the wording is unit-tested. `outcome` is 'succeeded' | 'failed' | 'deploy_failed'.
export function buildCycleNotification({ project = {}, cycle = {}, outcome }) {
  const name = project.name || `project ${project.id ?? ''}`.trim();
  const url = project.url || null;
  const instruction = (cycle.instruction || '').trim();
  const short = instruction.length > 120 ? `${instruction.slice(0, 117)}…` : instruction;

  if (outcome === 'succeeded') {
    const deployed = cycle.deploy_status === 'serving';
    const title = `Build finished — ${name}`;
    const line = deployed
      ? 'Gates passed and the app is live on its URL.'
      : 'Gates passed and the change was checkpointed into the repo.';
    const body = [short ? `Change: ${short}` : null, line, url ? url : null]
      .filter(Boolean).join('\n');
    return {
      level: 'info',
      title,
      body,
      subject: title,
      text: `${line}${short ? `\n\nChange: ${short}` : ''}${url ? `\n\n${url}` : ''}`,
      sms: `ProxyPilot: build finished for ${name}. ${deployed ? 'Live now.' : 'Checkpointed.'}`,
    };
  }

  if (outcome === 'paused') {
    const title = `Build paused — ${name}`;
    const line = `The build was checkpointed and paused${cycle.error ? `: ${String(cycle.error).slice(0, 160)}` : '.'} Resume it to continue where it stopped.`;
    const body = [short ? `Change: ${short}` : null, line, url ? url : null].filter(Boolean).join('\n');
    return {
      level: 'info',
      title,
      body,
      subject: title,
      text: `${line}${short ? `\n\nChange: ${short}` : ''}`,
      sms: `ProxyPilot: build paused for ${name} — resume to continue.`,
    };
  }

  if (outcome === 'blocked') {
    const title = `Build blocked — ${name}`;
    const line = `The build stopped without finishing and needs attention${cycle.error ? `: ${String(cycle.error).slice(0, 160)}` : '.'} Resume it once the blocker is cleared.`;
    const body = [short ? `Change: ${short}` : null, line, url ? url : null].filter(Boolean).join('\n');
    return {
      level: 'warning',
      title,
      body,
      subject: title,
      text: `${line}${short ? `\n\nChange: ${short}` : ''}`,
      sms: `ProxyPilot: build blocked for ${name} — needs attention.`,
    };
  }

  const failedDeploy = outcome === 'deploy_failed';
  const title = failedDeploy
    ? `Deploy failed — ${name}`
    : `Build failed — ${name}`;
  const line = failedDeploy
    ? 'The change passed its gates but the app did not deploy.'
    : `The build did not complete${cycle.error ? `: ${String(cycle.error).slice(0, 160)}` : '.'}`;
  const body = [short ? `Change: ${short}` : null, line, url ? url : null]
    .filter(Boolean).join('\n');
  return {
    level: 'warning',
    title,
    body,
    subject: title,
    text: `${line}${short ? `\n\nChange: ${short}` : ''}`,
    sms: `ProxyPilot: ${failedDeploy ? 'deploy' : 'build'} failed for ${name}.`,
  };
}
