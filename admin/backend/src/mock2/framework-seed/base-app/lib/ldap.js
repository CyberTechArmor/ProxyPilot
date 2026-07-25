'use strict';
// Minimal, dependency-free LDAPv3 client: simple bind + search + connection test.
// Enough for authentication (bind), user lookup (search), and admin connection tests.
const net = require('net');
const tls = require('tls');
const { decryptSecret, isEncrypted } = require('./crypto');

/* ---------------- BER/DER encoding ---------------- */
function encLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, content) {
  const c = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), encLen(c.length), c]);
}
function berInt(n) {
  const bytes = [];
  let v = n;
  do { bytes.unshift(v & 0xff); v >>= 8; } while (v > 0 && v !== -1);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}
function berEnum(n) { const b = berInt(n); b[0] = 0x0a; return b; }
function berStr(s) { return tlv(0x04, Buffer.from(String(s), 'utf8')); }
function berBool(b) { return tlv(0x01, Buffer.from([b ? 0xff : 0x00])); }
function seq(...parts) { return tlv(0x30, Buffer.concat(parts)); }

/* ---------------- Filter compiler ---------------- */
// Supports (attr=value), (attr=*), and (&...)/(|...)/(!...) composition.
function compileFilter(str) {
  str = String(str || '(objectClass=*)').trim();
  const { node } = parseFilter(str, 0);
  return node;
}
function parseFilter(s, i) {
  if (s[i] !== '(') throw new Error('bad filter');
  i++;
  const op = s[i];
  if (op === '&' || op === '|') {
    i++;
    const parts = [];
    while (s[i] === '(') { const r = parseFilter(s, i); parts.push(r.node); i = r.i; }
    if (s[i] !== ')') throw new Error('bad filter');
    const tag = op === '&' ? 0xa0 : 0xa1;
    return { node: tlv(tag, Buffer.concat(parts)), i: i + 1 };
  }
  if (op === '!') {
    i++;
    const r = parseFilter(s, i); i = r.i;
    if (s[i] !== ')') throw new Error('bad filter');
    return { node: tlv(0xa2, r.node), i: i + 1 };
  }
  // simple attr=value
  let end = s.indexOf(')', i);
  const expr = s.slice(i, end);
  const eq = expr.indexOf('=');
  const attr = expr.slice(0, eq);
  const val = expr.slice(eq + 1);
  let node;
  if (val === '*') {
    node = tlv(0x87, Buffer.from(attr, 'utf8')); // present
  } else {
    // equalityMatch [3]
    node = tlv(0xa3, Buffer.concat([berStr(attr), berStr(val)]));
  }
  return { node, i: end + 1 };
}

/* ---------------- Message builders ---------------- */
function bindRequest(msgId, dn, password) {
  const op = tlv(0x60, Buffer.concat([
    berInt(3),                              // version
    berStr(dn || ''),                       // name
    tlv(0x80, Buffer.from(String(password || ''), 'utf8')) // simple auth [0]
  ]));
  return seq(berInt(msgId), op);
}
function searchRequest(msgId, baseDN, filterBuf, attrs = [], scope = 2) {
  const op = tlv(0x63, Buffer.concat([
    berStr(baseDN || ''),
    berEnum(scope),        // 0 base, 1 one, 2 sub
    berEnum(0),            // derefAliases never
    berInt(1),             // sizeLimit
    berInt(10),            // timeLimit
    berBool(false),        // typesOnly
    filterBuf,
    seq(...attrs.map(a => berStr(a)))
  ]));
  return seq(berInt(msgId), op);
}

/* ---------------- Response parsing ---------------- */
function readLen(buf, i) {
  let b = buf[i++];
  if (b < 0x80) return { len: b, i };
  const num = b & 0x7f;
  let len = 0;
  for (let k = 0; k < num; k++) len = (len << 8) | buf[i++];
  return { len, i };
}
// Parse as many complete LDAPMessages as available; return {messages, rest}
function parseMessages(buf) {
  const messages = [];
  let off = 0;
  while (off < buf.length) {
    if (buf[off] !== 0x30) break;
    const { len, i } = readLen(buf, off + 1);
    const total = i + len;
    if (total > buf.length) break; // incomplete
    const body = buf.slice(i, total);
    messages.push(parseLdapMessage(body));
    off = total;
  }
  return { messages, rest: buf.slice(off) };
}
function parseLdapMessage(body) {
  // messageID INTEGER, protocolOp
  let i = 0;
  if (body[i++] !== 0x02) return { bad: true };
  const l1 = readLen(body, i); i = l1.i;
  let msgId = 0;
  for (let k = 0; k < l1.len; k++) msgId = (msgId << 8) | body[i++];
  const opTag = body[i++];
  const l2 = readLen(body, i); i = l2.i;
  const opBody = body.slice(i, i + l2.len);
  const out = { msgId, opTag };
  if (opTag === 0x61 || opTag === 0x65) {
    // BindResponse / SearchResultDone: ENUM resultCode, matchedDN, diagnosticMessage
    let j = 0;
    if (opBody[j++] === 0x0a) {
      const rl = readLen(opBody, j); j = rl.i;
      let code = 0; for (let k = 0; k < rl.len; k++) code = (code << 8) | opBody[j++];
      out.resultCode = code;
      // diagnostic message (skip matchedDN)
      if (opBody[j] === 0x04) { const ml = readLen(opBody, j + 1); j = ml.i + ml.len; }
      if (opBody[j] === 0x04) { const dl = readLen(opBody, j + 1); out.diagnostic = opBody.slice(dl.i, dl.i + dl.len).toString('utf8'); }
    }
  } else if (opTag === 0x64) {
    // SearchResultEntry: objectName OCTET STRING
    let j = 0;
    if (opBody[j++] === 0x04) {
      const nl = readLen(opBody, j); j = nl.i;
      out.dn = opBody.slice(j, j + nl.len).toString('utf8');
      j += nl.len;
    }
    out.attributes = {};
    if (opBody[j++] === 0x30) {
      const al = readLen(opBody, j); j = al.i;
      const end = j + al.len;
      while (j < end && opBody[j++] === 0x30) {
        const pl = readLen(opBody, j); j = pl.i;
        const pend = j + pl.len;
        if (opBody[j++] !== 0x04) { j = pend; continue; }
        const tl = readLen(opBody, j); j = tl.i;
        const name = opBody.slice(j, j + tl.len).toString('utf8'); j += tl.len;
        const values = [];
        if (opBody[j++] === 0x31) {
          const vl = readLen(opBody, j); j = vl.i;
          const vend = j + vl.len;
          while (j < vend && opBody[j++] === 0x04) {
            const sl = readLen(opBody, j); j = sl.i;
            values.push(opBody.slice(j, j + sl.len).toString('utf8'));
            j += sl.len;
          }
        }
        out.attributes[name] = values;
        j = pend;
      }
    }
  }
  return out;
}

const RESULT_LABEL = {
  0: 'success', 8: 'stronger auth required', 49: 'invalid credentials',
  32: 'no such object', 34: 'invalid DN syntax', 53: 'unwilling to perform'
};

/* ---------------- Connection + operations ---------------- */
function resolveConfig(cfg) {
  const c = Object.assign({}, cfg);
  if (isEncrypted(c.bindPassword)) {
    const decrypted = decryptSecret(c.bindPassword);
    // decryptSecret returns null when the stored ciphertext cannot be decrypted
    // with the current master key (e.g. data/secret.key was regenerated). Flag it
    // so callers fail loudly instead of silently attempting an anonymous bind.
    c.bindPasswordDecryptFailed = decrypted == null;
    c.bindPassword = decrypted;
  }
  c.port = +c.port || (c.useTLS ? 636 : 389);
  return c;
}

// A simple bind that carries a bindDN but an empty/absent password is an
// "unauthenticated bind": most directories (incl. Active Directory) return
// success but leave the session anonymous, so every later search fails with
// "a successful bind must be completed". Detect and reject this up front.
function bindConfigError(cfg) {
  if (cfg.bindDN && !cfg.bindPassword) {
    const reason = cfg.bindPasswordDecryptFailed
      ? 'Service bind password could not be decrypted (the encryption master key at data/secret.key may have been regenerated). Re-enter the LDAP bind password.'
      : 'Service bind password is missing. A bind DN was provided without a password, which results in an anonymous bind. Enter the LDAP bind password.';
    return { code: 'BIND_CONFIG', reason };
  }
  return null;
}

function connect(cfg, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    let socket;
    const onErr = (e) => { cleanup(); reject(e); };
    const to = setTimeout(() => { cleanup(); reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); }, timeoutMs);
    function cleanup() { clearTimeout(to); if (socket) socket.removeListener('error', onErr); }
    if (cfg.useTLS) {
      // RFC 6066: SNI servername must not be an IP literal.
      const servername = net.isIP(cfg.host) ? undefined : cfg.host;
      socket = tls.connect({ host: cfg.host, port: cfg.port, rejectUnauthorized: cfg.tlsVerify !== false, servername },
        () => { cleanup(); resolve(socket); });
    } else {
      socket = net.connect({ host: cfg.host, port: cfg.port }, () => { cleanup(); resolve(socket); });
    }
    socket.once('error', onErr);
    // Persistent guard: once the socket is handed off, a peer RST during close
    // (common with AD LDAPS after unbind) emits 'error'. Without a listener Node
    // throws an unhandled 'error' and crashes the whole process. Swallow it.
    socket.on('error', () => {});
  });
}

// Send one request and await the terminal response for msgId. onEntry collects search entries.
function exchange(socket, reqBuf, msgId, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const entries = [];
    const to = setTimeout(() => { cleanup(); reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); }, timeoutMs);
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest } = parseMessages(buf);
      buf = rest;
      for (const m of messages) {
        if (m.msgId !== msgId) continue;
        if (m.opTag === 0x64) entries.push({ dn: m.dn, attributes: m.attributes || {} });
        else if (m.opTag === 0x61 || m.opTag === 0x65) { cleanup(); return resolve({ resultCode: m.resultCode, diagnostic: m.diagnostic, entries }); }
      }
    }
    function onErr(e) { cleanup(); reject(e); }
    function cleanup() { clearTimeout(to); socket.removeListener('data', onData); socket.removeListener('error', onErr); }
    socket.on('data', onData);
    socket.once('error', onErr);
    socket.write(reqBuf);
  });
}

async function bind(socket, dn, password) {
  const r = await exchange(socket, bindRequest(1, dn, password), 1);
  return { code: r.resultCode, diagnostic: r.diagnostic };
}

// Active Directory returns resultCode 49 for a whole family of failures and hides
// the real reason in the diagnostic as "data <hex>". Decode it so operators can
// tell a wrong password from a locked/disabled/expired account, etc.
const AD_SUBCODES = {
  '525': 'user not found',
  '52e': 'invalid credentials (wrong password)',
  '530': 'not permitted to log on at this time',
  '531': 'not permitted to log on from this workstation',
  '532': 'password expired',
  '533': 'account disabled',
  '568': 'too many context IDs',
  '701': 'account expired',
  '773': 'user must reset password',
  '775': 'account locked out'
};
function describeBind(code, diagnostic) {
  const base = RESULT_LABEL[code] || ('code ' + code);
  const diag = (diagnostic || '').replace(/\u0000/g, '').trim();
  const m = /data\s+([0-9a-fA-F]+)/.exec(diag);
  if (m) {
    const sub = m[1].toLowerCase();
    if (AD_SUBCODES[sub]) return `${base} — AD reason: ${AD_SUBCODES[sub]} (data ${sub})`;
    return `${base} — AD reason: data ${sub}`;
  }
  return diag ? `${base} — ${diag}` : base;
}
async function search(socket, baseDN, filterStr, attrs) {
  const r = await exchange(socket, searchRequest(2, baseDN, compileFilter(filterStr), attrs), 2);
  return r;
}

const PROFILE_ATTRS = ['displayName', 'cn', 'givenName', 'sn', 'mail', 'userPrincipalName', 'sAMAccountName'];
function firstAttr(attrs, names) {
  for (const name of names) {
    const key = Object.keys(attrs || {}).find(k => k.toLowerCase() === name.toLowerCase());
    const value = key && attrs[key] && attrs[key][0];
    if (value) return value;
  }
  return '';
}
function profileFromEntry(entry) {
  const attrs = (entry && entry.attributes) || {};
  const given = firstAttr(attrs, ['givenName']);
  const family = firstAttr(attrs, ['sn', 'surname']);
  const displayName = firstAttr(attrs, ['displayName', 'cn', 'name']) || [given, family].filter(Boolean).join(' ');
  return {
    dn: entry && entry.dn,
    displayName: displayName || '',
    email: firstAttr(attrs, ['mail', 'userPrincipalName']),
    username: firstAttr(attrs, ['sAMAccountName', 'userPrincipalName', 'mail'])
  };
}

async function lookupUser(rawCfg, username) {
  const cfg = resolveConfig(rawCfg);
  const badCfg = bindConfigError(cfg);
  if (badCfg) return { ok: false, code: badCfg.code, reason: badCfg.reason };
  let socket;
  try {
    socket = await connect(cfg);
    const svc = await bind(socket, cfg.bindDN || '', cfg.bindPassword || '');
    if (svc.code !== 0) return { ok: false, code: 'BIND_FAILED', reason: 'Service bind failed: ' + describeBind(svc.code, svc.diagnostic) };
    const filter = substituteUser(cfg.userFilter || '(userPrincipalName=%u)', escapeFilter(username));
    const res = await search(socket, cfg.baseDN || '', filter, PROFILE_ATTRS);
    if (!res.entries.length) return { ok: false, code: 'USER_NOT_FOUND', reason: 'Directory search returned no user' };
    return { ok: true, profile: profileFromEntry(res.entries[0]) };
  } catch (e) {
    return { ok: false, code: e.code === 'TIMEOUT' ? 'TIMEOUT' : 'CONNECT_FAILED', reason: e.message };
  } finally {
    if (socket) try { socket.end(); } catch (_) {}
  }
}

// Full authentication: bind service acct -> find user DN -> bind as user.
async function authenticate(rawCfg, username, password) {
  const cfg = resolveConfig(rawCfg);
  const badCfg = bindConfigError(cfg);
  if (badCfg) return { ok: false, code: badCfg.code, reason: badCfg.reason };
  let socket;
  try {
    socket = await connect(cfg);
    const svc = await bind(socket, cfg.bindDN || '', cfg.bindPassword || '');
    if (svc.code !== 0) return { ok: false, code: 'BIND_FAILED', reason: 'Service bind failed: ' + describeBind(svc.code, svc.diagnostic) };
    const filter = substituteUser(cfg.userFilter || '(userPrincipalName=%u)', escapeFilter(username));
    const res = await search(socket, cfg.baseDN || '', filter, PROFILE_ATTRS);
    // resultCode 0 = success, 4 = sizeLimitExceeded (still returns entries).
    // Anything else with no entries is a directory error (e.g. 1 operationsError
    // from an anonymous session), not simply a missing user.
    if (!res.entries.length && res.resultCode && res.resultCode !== 0 && res.resultCode !== 4) {
      return { ok: false, code: 'SEARCH_FAILED', reason: 'Directory search failed: ' + (RESULT_LABEL[res.resultCode] || ('code ' + res.resultCode)) + (res.diagnostic ? ' — ' + res.diagnostic.replace(/\u0000/g, '').trim() : '') };
    }
    if (!res.entries.length) return { ok: false, code: 'USER_NOT_FOUND', reason: 'Directory search returned no user' };
    const profile = profileFromEntry(res.entries[0]);
    const userDN = profile.dn;
    // rebind as the user to verify their password (new connection to be safe)
    try { socket.end(); } catch (_) {}
    socket = await connect(cfg);
    const user = await bind(socket, userDN, password);
    if (user.code === 0) return { ok: true, dn: userDN, profile, reason: 'LDAP bind succeeded' };
    return { ok: false, code: 'INVALID_CREDENTIALS', reason: describeBind(user.code, user.diagnostic) };
  } catch (e) {
    return { ok: false, code: e.code === 'TIMEOUT' ? 'TIMEOUT' : 'CONNECT_FAILED', reason: e.message };
  } finally {
    if (socket) try { socket.end(); } catch (_) {}
  }
}

function escapeFilter(v) {
  return String(v).replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

// Substitute the login into a user filter. Accepts multiple placeholder styles:
// %u, %s, %(user)s, %(username)s, {user}, {username}.
function substituteUser(filter, value) {
  return String(filter).replace(/%\(username\)s|%\(user\)s|\{username\}|\{user\}|%u|%s/gi, value);
}

// Structured connection test for admins.
async function connectionTest(rawCfg) {
  const cfg = resolveConfig(rawCfg);
  if (!cfg.host) return { status: 'error', code: 'NO_HOST', reason: 'Host is required' };
  const badCfg = bindConfigError(cfg);
  if (badCfg) return { status: 'error', code: badCfg.code, reason: badCfg.reason };
  let socket;
  try {
    socket = await connect(cfg);
  } catch (e) {
    if (cfg.useTLS && /certificate|self.signed|altnames|depth zero/i.test(e.message))
      return { status: 'error', code: 'TLS_FAILED', reason: 'TLS handshake failed: ' + e.message };
    return { status: 'error', code: e.code === 'TIMEOUT' ? 'TIMEOUT' : 'CONNECT_FAILED', reason: 'Could not connect: ' + e.message };
  }
  try {
    const bindResult = await bind(socket, cfg.bindDN || '', cfg.bindPassword || '');
    if (bindResult.code !== 0) return { status: 'error', code: 'BIND_FAILED', reason: 'Bind failed: ' + describeBind(bindResult.code, bindResult.diagnostic) };
    let searched = null;
    if (cfg.baseDN) {
      const res = await search(socket, cfg.baseDN, cfg.userFilter ? substituteUser(cfg.userFilter, '*') : '(objectClass=*)', ['dn']);
      searched = { resultCode: res.resultCode, entries: res.entries.length };
    }
    return { status: 'ok', code: 'OK', reason: 'Bind succeeded' + (searched ? `; base DN reachable (${searched.entries} entr${searched.entries === 1 ? 'y' : 'ies'} sampled)` : ''), details: searched };
  } catch (e) {
    return { status: 'error', code: e.code === 'TIMEOUT' ? 'TIMEOUT' : 'SEARCH_FAILED', reason: e.message };
  } finally {
    if (socket) try { socket.end(); } catch (_) {}
  }
}

module.exports = { authenticate, lookupUser, connectionTest, compileFilter, _internals: { bindRequest, searchRequest, parseMessages, berInt, encLen, profileFromEntry } };
