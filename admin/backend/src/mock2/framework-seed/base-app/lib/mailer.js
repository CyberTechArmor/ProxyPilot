'use strict';
// Minimal, dependency-free SMTP client: greeting -> EHLO -> (STARTTLS) ->
// AUTH LOGIN/PLAIN -> MAIL FROM -> RCPT TO -> DATA -> QUIT.
// Works with SendGrid (smtp.sendgrid.net, user "apikey"), Resend
// (smtp.resend.com, user "resend"), or any standard SMTP server.
const net = require('net');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');

const CRLF = '\r\n';

// Provider presets fill in host/port/secure/username so the admin only needs a key.
const PRESETS = {
  sendgrid: { host: 'smtp.sendgrid.net', port: 587, secure: false, username: 'apikey' },
  resend:   { host: 'smtp.resend.com',   port: 465, secure: true,  username: 'resend' },
};

function presetFor(provider) { return PRESETS[provider] || null; }

// ---- HTTPS Web API transports ----------------------------------------------
// Many hosts firewall outbound SMTP (25/465/587). SendGrid and Resend also
// offer HTTPS APIs on port 443, which is almost always reachable. When the
// configured provider has an API we send through it (unless cfg.transport is
// explicitly 'smtp'). For SendGrid/Resend the SMTP password IS the API key.
function apiProviderKey(cfg) {
  const p = String((cfg && cfg.provider) || '').toLowerCase();
  return p === 'sendgrid' || p === 'resend' ? p : null;
}

function clip(s) { return String(s || '').replace(/\s+/g, ' ').slice(0, 300); }

function apiConnError(r, host) {
  const e = r.error || {};
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return { ok: false, code: 'DNS_ERROR', reason: `Could not resolve ${host}.` };
  if (e.code === 'ETIMEDOUT') return { ok: false, code: 'CONN_TIMEOUT', reason: `Timed out reaching ${host} over HTTPS.` };
  return { ok: false, code: 'CONN_ERROR', reason: e.message || `Could not reach ${host}.` };
}

// Minimal HTTPS request helper. Resolves { status, body } or { status:0, error }.
function httpsRequest(opts, payload) {
  return new Promise((resolve) => {
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload), 'utf8');
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const req = https.request({
      host: opts.host, port: 443, path: opts.path, method: opts.method || 'GET', headers, timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })); });
    req.on('error', (e) => resolve({ status: 0, error: e }));
    if (body) req.write(body);
    req.end();
  });
}

async function sendViaSendgrid(cfg, msg) {
  const apiKey = String(cfg.password || '').trim();
  if (!apiKey) return { ok: false, code: 'NO_API_KEY', reason: 'Missing SendGrid API key.' };
  const fromEmail = String(cfg.fromEmail || '').trim();
  if (!fromEmail) return { ok: false, code: 'NO_FROM', reason: 'A verified From address is required.' };
  const content = [];
  if (msg.text) content.push({ type: 'text/plain', value: msg.text });
  if (msg.html) content.push({ type: 'text/html', value: msg.html });
  if (!content.length) content.push({ type: 'text/plain', value: '' });
  const from = { email: fromEmail };
  if (String(cfg.fromName || '').trim()) from.name = String(cfg.fromName).trim();
  const payload = {
    personalizations: [{ to: [{ email: String(msg.to).trim() }] }],
    from, subject: msg.subject || '', content,
  };
  const r = await httpsRequest({ host: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST', headers: { Authorization: 'Bearer ' + apiKey } }, payload);
  if (r.status === 202) return { ok: true, code: 'OK', reason: 'Message accepted for delivery.' };
  if (r.status === 0) return apiConnError(r, 'api.sendgrid.com');
  if (r.status === 401 || r.status === 403) return { ok: false, code: 'AUTH_FAILED', reason: 'SendGrid rejected the API key (check the key and that the sender/domain is verified).' };
  return { ok: false, code: 'SEND_REJECTED', reason: `SendGrid returned HTTP ${r.status}: ${clip(r.body)}` };
}

async function sendViaResend(cfg, msg) {
  const apiKey = String(cfg.password || '').trim();
  if (!apiKey) return { ok: false, code: 'NO_API_KEY', reason: 'Missing Resend API key.' };
  const fromEmail = String(cfg.fromEmail || '').trim();
  if (!fromEmail) return { ok: false, code: 'NO_FROM', reason: 'A verified From address is required.' };
  const fromName = String(cfg.fromName || '').trim();
  const payload = {
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    to: [String(msg.to).trim()],
    subject: msg.subject || '',
  };
  if (msg.html) payload.html = msg.html;
  if (msg.text) payload.text = msg.text;
  if (!msg.html && !msg.text) payload.text = '';
  const r = await httpsRequest({ host: 'api.resend.com', path: '/emails', method: 'POST', headers: { Authorization: 'Bearer ' + apiKey } }, payload);
  if (r.status >= 200 && r.status < 300) return { ok: true, code: 'OK', reason: 'Message accepted for delivery.' };
  if (r.status === 0) return apiConnError(r, 'api.resend.com');
  if (r.status === 401 || r.status === 403) return { ok: false, code: 'AUTH_FAILED', reason: 'Resend rejected the API key.' };
  return { ok: false, code: 'SEND_REJECTED', reason: `Resend returned HTTP ${r.status}: ${clip(r.body)}` };
}

// Verify the API key without sending an email (used by the admin Test button).
async function apiCredentialCheck(cfg) {
  const api = apiProviderKey(cfg);
  const apiKey = String(cfg.password || '').trim();
  if (!apiKey) return { ok: false, code: 'NO_API_KEY', reason: 'Enter the API key before testing.' };
  if (api === 'sendgrid') {
    const r = await httpsRequest({ host: 'api.sendgrid.com', path: '/v3/scopes', method: 'GET', headers: { Authorization: 'Bearer ' + apiKey } });
    if (r.status === 0) return apiConnError(r, 'api.sendgrid.com');
    if (r.status === 200) return { ok: true, reason: 'SendGrid API key verified over HTTPS.' };
    if (r.status === 401 || r.status === 403) return { ok: false, code: 'AUTH_FAILED', reason: 'SendGrid rejected the API key.' };
    return { ok: false, code: 'API_ERROR', reason: `SendGrid returned HTTP ${r.status}.` };
  }
  const r = await httpsRequest({ host: 'api.resend.com', path: '/domains', method: 'GET', headers: { Authorization: 'Bearer ' + apiKey } });
  if (r.status === 0) return apiConnError(r, 'api.resend.com');
  if (r.status >= 200 && r.status < 300) return { ok: true, reason: 'Resend API key verified over HTTPS.' };
  if (r.status === 401 || r.status === 403) return { ok: false, code: 'AUTH_FAILED', reason: 'Resend rejected the API key.' };
  return { ok: false, code: 'API_ERROR', reason: `Resend returned HTTP ${r.status}.` };
}

// A single SMTP conversation. Reads complete (possibly multiline) replies.
function smtpConverse(cfg, onReady) {
  return new Promise((resolve) => {
    const secure = !!cfg.secure;
    const port = +cfg.port || (secure ? 465 : 587);
    const host = String(cfg.host || '').trim();
    const rejectUnauthorized = cfg.tlsVerify !== false;
    let socket;
    let buf = '';
    let replyLines = [];    // accumulates the lines of a multiline reply
    let waiter = null;      // resolver for the next complete reply
    let done = false;
    let timer = null;
    let stage = 'connect';  // connect | greeting | session (for clearer errors)

    const fail = (code, reason) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { socket && socket.destroy(); } catch (_) {}
      resolve({ ok: false, code, reason });
    };
    const finish = (out) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { socket && socket.end(); } catch (_) {}
      resolve(out);
    };
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (stage === 'connect' || stage === 'greeting') {
          fail('CONN_TIMEOUT', `Could not reach ${host || 'the mail server'}:${port}. The host/port may be wrong or outbound SMTP is blocked by a firewall.`);
        } else {
          fail('TIMEOUT', 'The mail server did not respond in time.');
        }
      }, 20000);
    };

    // Resolve the next complete reply. Continuation lines look like "250-...",
    // the final line looks like "250 ..." (or bare "250").
    function onData(chunk) {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf(CRLF)) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
        if (!m) continue;
        replyLines.push(m[3]);
        if (m[2] !== '-') {
          const reply = { code: +m[1], text: line, lines: replyLines.slice() };
          replyLines = [];
          const w = waiter; waiter = null;
          if (w) w(reply);
        }
      }
    }
    // Send a command and wait for the server's reply.
    function cmd(text) {
      return new Promise((res) => {
        waiter = res;
        armTimeout();
        if (text != null) socket.write(text + CRLF);
      });
    }
    // Wait for a reply with no command (used for the initial greeting).
    function expect() { return new Promise((res) => { waiter = res; armTimeout(); }); }

    function bind(s) {
      socket = s;
      // Keep the socket in Buffer mode (no setEncoding) so a later STARTTLS
      // upgrade wraps a clean binary stream; onData decodes to text itself.
      socket.on('data', onData);
      socket.on('error', (e) => {
        const code = e && e.code;
        if (code === 'ECONNREFUSED') fail('CONN_REFUSED', `Connection refused by ${host}:${port}. Check the host and port.`);
        else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') fail('DNS_ERROR', `Could not resolve host "${host}".`);
        else if (code === 'ETIMEDOUT') fail('CONN_TIMEOUT', `Timed out connecting to ${host}:${port}. Outbound SMTP may be blocked by a firewall.`);
        else fail('CONN_ERROR', (e && e.message) || 'Connection error.');
      });
      socket.on('close', () => { if (!done) fail('CONN_CLOSED', 'Connection closed unexpectedly.'); });
    }

    const helloName = (String(cfg.fromEmail || '').split('@')[1] || 'localhost').trim() || 'localhost';

    // Authenticate using whatever mechanism the server advertises. Prefers the
    // advertised one, then falls back to the other, but stops on bad credentials.
    async function authenticate(caps) {
      const user = String(cfg.username);
      const pass = String(cfg.password || '');
      const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
      const advertised = (caps || '').toUpperCase();
      const hasLogin = advertised.includes('LOGIN');
      const hasPlain = advertised.includes('PLAIN');

      async function viaLogin() {
        const a = await cmd('AUTH LOGIN');
        if (a.code !== 334) return a;           // mechanism unsupported / rejected
        const u = await cmd(b64(user));
        if (u.code !== 334) return u;
        return cmd(b64(pass));
      }
      async function viaPlain() {
        const token = b64('\u0000' + user + '\u0000' + pass);
        const r = await cmd('AUTH PLAIN ' + token);
        if (r.code === 334) return cmd(token);  // server wants the token separately
        return r;
      }

      // Try advertised mechanism first; default order LOGIN then PLAIN.
      const order = hasLogin && !hasPlain ? ['login']
        : hasPlain && !hasLogin ? ['plain']
          : hasLogin ? ['login', 'plain'] : ['plain', 'login'];
      let last = null;
      for (const mech of order) {
        const r = mech === 'login' ? await viaLogin() : await viaPlain();
        last = r;
        if (r.code === 235) return { ok: true };                 // authenticated
        if (r.code === 535 || r.code === 530) return { ok: false, reply: r }; // bad creds — don't retry
        // otherwise the mechanism was unsupported (5xx on the AUTH verb) — try next
      }
      return { ok: false, reply: last };
    }

    (async () => {
      try {
        // 1) Connect (implicit TLS when secure, else plain then optional STARTTLS)
        stage = 'connect';
        if (secure) {
          bind(tls.connect({ host, port, servername: host, rejectUnauthorized }, () => {}));
        } else {
          bind(net.connect({ host, port }, () => {}));
        }

        stage = 'greeting';
        let greeting = await expect();
        if (greeting.code !== 220) return fail('NO_GREETING', greeting.text || 'No SMTP greeting.');

        stage = 'session';
        let ehlo = await cmd('EHLO ' + helloName);
        if (ehlo.code !== 250) { ehlo = await cmd('HELO ' + helloName); if (ehlo.code !== 250) return fail('EHLO_FAILED', ehlo.text); }

        // 2) STARTTLS upgrade for non-implicit connections
        if (!secure) {
          const st = await cmd('STARTTLS');
          if (st.code === 220) {
            const plain = socket;
            plain.removeAllListeners('data');
            plain.removeAllListeners('close');
            plain.removeAllListeners('error');
            await new Promise((res, rej) => {
              const upgraded = tls.connect({ socket: plain, servername: host, rejectUnauthorized }, () => res());
              upgraded.once('error', rej);
              bind(upgraded);
            }).catch((e) => { throw new Error('STARTTLS failed: ' + e.message); });
            ehlo = await cmd('EHLO ' + helloName);
            if (ehlo.code !== 250) return fail('EHLO_FAILED', ehlo.text);
          } else if (cfg.requireTLS) {
            return fail('NO_STARTTLS', 'Server does not support STARTTLS.');
          }
        }

        // 3) AUTH when credentials are supplied — negotiate LOGIN or PLAIN
        if (cfg.username) {
          const caps = (ehlo.lines || []).join(' ');
          const res = await authenticate(caps);
          if (!res.ok) {
            const rep = res.reply || {};
            if (rep.code === 535 || rep.code === 530) return fail('AUTH_FAILED', rep.text || 'Authentication failed — the username or password/API key was rejected.');
            return fail('AUTH_UNSUPPORTED', (rep.text || 'The server rejected AUTH LOGIN and AUTH PLAIN.'));
          }
        }

        // Hand control back to the caller for MAIL/RCPT/DATA or a plain NOOP.
        const out = await onReady({ cmd, fail });
        if (out && out.__stop) return; // fail() already called
        await cmd('QUIT');
        return finish(out);
      } catch (e) {
        return fail('CLIENT_ERROR', e.message);
      }
    })();
  });
}

function dotStuff(body) {
  return String(body).replace(/\r?\n/g, CRLF).replace(new RegExp(CRLF + '\\.', 'g'), CRLF + '..');
}

function buildMessage(cfg, msg) {
  const fromEmail = String(cfg.fromEmail || cfg.username || 'no-reply@localhost').trim();
  const fromName = String(cfg.fromName || '').trim();
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const date = new Date().toUTCString();
  const messageId = `<${crypto.randomBytes(16).toString('hex')}@${(fromEmail.split('@')[1] || 'localhost')}>`;
  const headers = [
    `From: ${from}`,
    `To: ${msg.to}`,
    `Subject: ${msg.subject || ''}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];
  let bodyPart;
  if (msg.html && msg.text) {
    const boundary = 'b_' + crypto.randomBytes(12).toString('hex');
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    bodyPart = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '', dotStuff(msg.text), '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '', dotStuff(msg.html), '',
      `--${boundary}--`, '',
    ].join(CRLF);
  } else if (msg.html) {
    headers.push('Content-Type: text/html; charset=UTF-8');
    bodyPart = dotStuff(msg.html);
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    bodyPart = dotStuff(msg.text || '');
  }
  return headers.join(CRLF) + CRLF + CRLF + bodyPart + CRLF + '.';
}

// Send an email. Returns { ok, code, reason }.
async function sendMail(cfg, msg) {
  if (!cfg) return { ok: false, code: 'NOT_CONFIGURED', reason: 'SMTP is not configured.' };
  // Prefer the provider's HTTPS API (port 443) when available — outbound SMTP
  // ports are frequently firewalled. cfg.transport==='smtp' forces raw SMTP.
  const api = apiProviderKey(cfg);
  if (api && String(cfg.transport || 'auto').toLowerCase() !== 'smtp') {
    return api === 'sendgrid' ? sendViaSendgrid(cfg, msg) : sendViaResend(cfg, msg);
  }
  if (!cfg.host) return { ok: false, code: 'NOT_CONFIGURED', reason: 'SMTP is not configured.' };
  const fromEmail = String(cfg.fromEmail || cfg.username || '').trim();
  return smtpConverse(cfg, async ({ cmd, fail }) => {
    const mf = await cmd(`MAIL FROM:<${fromEmail}>`);
    if (mf.code !== 250) { fail('MAIL_FROM_REJECTED', mf.text); return { __stop: true }; }
    const rc = await cmd(`RCPT TO:<${msg.to}>`);
    if (rc.code !== 250 && rc.code !== 251) { fail('RCPT_REJECTED', rc.text); return { __stop: true }; }
    const d = await cmd('DATA');
    if (d.code !== 354) { fail('DATA_REJECTED', d.text); return { __stop: true }; }
    const sent = await cmd(buildMessage(cfg, msg));
    if (sent.code !== 250) { fail('SEND_REJECTED', sent.text); return { __stop: true }; }
    return { ok: true, code: 'OK', reason: 'Message accepted for delivery.' };
  });
}

// Verify configuration. If `to` is given, sends a real test email; otherwise
// just completes the handshake + AUTH to confirm the credentials work.
async function connectionTest(cfg, to) {
  if (!cfg) return { status: 'error', code: 'NOT_CONFIGURED', reason: 'Enter a host before testing.' };
  const api = apiProviderKey(cfg);
  const useApi = api && String(cfg.transport || 'auto').toLowerCase() !== 'smtp';
  if (to) {
    const r = await sendMail(cfg, {
      to,
      subject: 'Upload Doc — email test',
      text: 'This is a test email from Upload Doc. If you received it, your email settings are working.',
      html: '<p>This is a test email from <b>Upload Doc</b>. If you received it, your email settings are working.</p>',
    });
    return r.ok
      ? { status: 'ok', code: 'OK', reason: `Test email sent to ${to}.` }
      : { status: 'error', code: r.code, reason: r.reason };
  }
  if (useApi) {
    const r = await apiCredentialCheck(cfg);
    return r.ok
      ? { status: 'ok', code: 'OK', reason: r.reason }
      : { status: 'error', code: r.code, reason: r.reason };
  }
  if (!cfg.host) return { status: 'error', code: 'NOT_CONFIGURED', reason: 'Enter a host before testing.' };
  const r = await smtpConverse(cfg, async ({ cmd }) => {
    await cmd('NOOP');
    return { ok: true, code: 'OK', reason: 'Connected and authenticated successfully.' };
  });
  return r.ok
    ? { status: 'ok', code: 'OK', reason: r.reason }
    : { status: 'error', code: r.code, reason: r.reason };
}

module.exports = { sendMail, connectionTest, presetFor, PRESETS };
