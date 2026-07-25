'use strict';
/* ===========================================================================
   SPA controller: setup -> login -> app, with refresh, RBAC-aware UI,
   realtime deactivation enforcement, and the admin console.
   Clients branch on machine-readable codes, never on message text.
   =========================================================================== */
(function () {
  const root = () => document.getElementById('root');
  let ME = null;          // current identity
  let sse = null;         // EventSource
  let refreshTimer = null;
  let deactPoll = null;

  const ICON = {
    logo: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    lock: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    arrow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>',
    up: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    doc2: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>',
    mail: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>',
    users: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13A4 4 0 0 1 16 11"/></svg>',
    back: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    grip: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>'
  };

  /* ----------------------------- API layer ----------------------------- */
  async function rawApi(method, path, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(path, opt);
    let data = {};
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }
  // Wraps api with a single silent refresh retry on 401.
  async function api(method, path, body, _retried) {
    const r = await rawApi(method, path, body);
    if (r.status === 401 && !_retried && path !== '/api/auth/refresh' && path !== '/api/auth/login') {
      const rf = await rawApi('POST', '/api/auth/refresh');
      if (rf.status === 200) return api(method, path, body, true);
    }
    return r;
  }

  function toast(title, body, kind) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<div class="tic">${kind === 'err' ? '!' : '✓'}</div><div><div class="tt">${esc(title)}</div>${body ? `<div class="tb">${esc(body)}</div>` : ''}</div>`;
    document.getElementById('globalToasts').appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4200);
  }
  // Escapes BOTH quote characters — see the note in portal.js.
  function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtLastLogin(iso) {
    if (!iso) return '<span class="muted small">Never</span>';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '<span class="muted small">—</span>';
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    let rel;
    if (mins < 1) rel = 'Just now';
    else if (mins < 60) rel = mins + ' min ago';
    else if (mins < 1440) { const h = Math.floor(mins / 60); rel = h + ' hr' + (h === 1 ? '' : 's') + ' ago'; }
    else if (mins < 43200) { const dd = Math.floor(mins / 1440); rel = dd + ' day' + (dd === 1 ? '' : 's') + ' ago'; }
    else rel = d.toLocaleDateString();
    return `<span title="${esc(d.toLocaleString())}">${esc(rel)}</span>`;
  }
  function can(p) { return ME && ME.permissions.includes(p); }
  function hasPortal() { return can('portal.view'); }
  function hasInternal() { return can('internal.review'); }
  function hasAnyAdmin() { return ['users.view', 'roles.view', 'perms.manage', 'ldap.manage', 'smtp.manage', 'catalog.manage', 'audit.view'].some(can); }

  /* ------------------------------- Boot -------------------------------- */
  async function boot() {
    const _params = new URLSearchParams(window.location.search);
    const _resetToken = _params.get('reset');
    if (_resetToken) return renderReset(_resetToken);
    const _otpToken = _params.get('otp');
    if (_otpToken) return renderOtpLogin(_otpToken);
    const st = await rawApi('GET', '/api/setup/status');
    if (st.data && st.data.needsSetup) return renderSetup();
    const me = await api('GET', '/api/auth/me');
    if (me.status === 200) { ME = me.data.user; return enterApp(); }
    if (me.status === 403 && me.data.code === 'ACCOUNT_DEACTIVATED') return renderDeactivated();
    renderRoleChoice();
  }

  /* ------------------------- Setup (first run) ------------------------- */
  // Shared split-screen auth layout (mockup style): marketing panel + auth box.
  function authLayout(rightInner) {
    return `
      <div class="split authsplit">
        <div class="left">
          <div class="glow"></div>
          <div class="brand"><span class="logo">${ICON.logo}</span> Upload&nbsp;Doc</div>
          <div class="authhero">
          <h1>Physician credentialing, without the paperwork chase.</h1>
          <p class="lede">One secure portal where physicians submit their credentialing documents, and your team collects, reviews, and follows up — document by document.</p>
          <div class="plist">
            <div class="row"><div class="ic">${ICON.up}</div><div><b>A guided checklist</b><span>Every credentialing item, grouped and tracked with live status.</span></div></div>
            <div class="row"><div class="ic">${ICON.doc2}</div><div><b>Notes on each document</b><span>Questions and requests stay attached to the exact document — no lost threads.</span></div></div>
            <div class="row"><div class="ic">${ICON.mail}</div><div><b>Nothing stalls</b><span>Not logged in? A note is emailed automatically so it still gets seen.</span></div></div>
          </div>
          </div>
        </div>
        <div class="right"><div class="authbox">${rightInner}</div></div>
      </div>`;
  }

  function renderSetup() {
    stopRealtime();
    root().innerHTML = authLayout(`
      <div class="stepper"><div class="st on"></div><div class="st on"></div></div>
      <h2 style="font-size:22px;margin-bottom:4px">Create the super administrator</h2>
      <p class="muted small" style="margin-bottom:18px">This one-time step creates the first administrator account. You will not see this screen again.</p>
      <div id="setupAlert"></div>
      <div class="field"><label>Full name</label><input id="s_name" placeholder="Alex Rivera"></div>
      <div class="field"><label>Username</label><input id="s_user" placeholder="admin" autocomplete="username"></div>
      <div class="field"><label>Email</label><input id="s_email" type="email" placeholder="admin@yourorg.com"></div>
      <div class="field"><label>Password</label><input id="s_pw" type="password" placeholder="At least 8 characters" autocomplete="new-password"></div>
      <div class="field"><label>Confirm password</label><input id="s_pw2" type="password" autocomplete="new-password"></div>
      <button class="btn" id="s_go" style="width:100%;justify-content:center;margin-top:6px">Create administrator ${ICON.arrow}</button>
    `);
    document.getElementById('s_go').onclick = doSetup;
    document.getElementById('s_pw2').addEventListener('keydown', e => { if (e.key === 'Enter') doSetup(); });
  }
  async function doSetup() {
    const username = val('s_user'), password = val('s_pw'), pw2 = val('s_pw2');
    const alert = (m) => document.getElementById('setupAlert').innerHTML = `<div class="alert err">${esc(m)}</div>`;
    if (!username) return alert('Username is required.');
    if (password.length < 8) return alert('Password must be at least 8 characters.');
    if (password !== pw2) return alert('Passwords do not match.');
    const btn = document.getElementById('s_go'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Creating…';
    const r = await rawApi('POST', '/api/setup', { username, password, email: val('s_email'), displayName: val('s_name') });
    if (r.status === 201) { ME = r.data.user; toast('Administrator created', 'Welcome to Upload Doc.'); return enterApp(); }
    btn.disabled = false; btn.innerHTML = 'Create administrator';
    alert((r.data && r.data.message) || 'Setup failed.');
  }

  /* ------------------------------- Login ------------------------------- */

  let authRole = null;
  function renderRoleChoice() {
    stopRealtime(); authRole = null;
    root().innerHTML = authLayout(`
      <h2 style="font-size:22px;margin-bottom:4px">Welcome to Upload Doc</h2>
      <p class="muted small" style="margin-bottom:20px">To continue, tell us who you are.</p>
      <div class="rolecards">
        <button class="rolecard phys" data-pick="physician">
          <div class="rc-ic">${ICON.up}</div>
          <div><div class="rc-t">I'm a physician</div><div class="rc-s">Create a profile and upload my credentialing documents</div></div>
          <div class="rc-go">${ICON.arrow}</div>
        </button>
        <button class="rolecard team" data-pick="team">
          <div class="rc-ic">${ICON.users}</div>
          <div><div class="rc-t">I'm on the credentialing team</div><div class="rc-s">Review every physician profile and collect documents</div></div>
          <div class="rc-go">${ICON.arrow}</div>
        </button>
      </div>
      <p class="muted small" style="text-align:center;margin-top:18px">Your administrator provisions account access.</p>
    `);
    root().querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { authRole = b.dataset.pick; authRole === 'physician' ? renderSignup() : renderLogin(); });
  }
  // Physician auth tabs (Create account / Sign in). Team role has no tabs.
  function authTabs(active) {
    return `<div class="authtabs" role="tablist">
      <button class="authtab ${active === 'signup' ? 'on' : ''}" data-tab="signup" role="tab" aria-selected="${active === 'signup'}">Create account</button>
      <button class="authtab ${active === 'login' ? 'on' : ''}" data-tab="login" role="tab" aria-selected="${active === 'login'}">Sign in</button>
    </div>`;
  }
  function wireAuthTabs() {
    const t = document.querySelector('[data-tab="signup"]'); if (t) t.onclick = () => renderSignup();
    const l = document.querySelector('[data-tab="login"]'); if (l) l.onclick = () => renderLogin();
  }
  function renderLogin(prefillCode) {
    stopRealtime();
    const isP = authRole === 'physician';
    const ctx = authRole ? `<button class="backlink" data-back>${ICON.back} Choose a different role</button><div class="roletag">${isP ? ICON.up : ICON.users} ${isP ? 'Physician' : 'Credentialing team'}</div>` : '';
    root().innerHTML = authLayout(`
      ${ctx}
      ${isP ? authTabs('login') : ''}
      <h2 style="font-size:22px;margin-bottom:4px">Sign in</h2>
      <p class="muted small" style="margin-bottom:18px">Use your local account or directory (LDAP) credentials.</p>
      <div id="loginAlert"></div>
      <div class="field"><label>Username or email</label><input id="l_user" autocomplete="username"></div>
      <div class="field"><label>Password</label><input id="l_pw" type="password" autocomplete="current-password"></div>
      <button class="btn" id="l_go" style="width:100%;justify-content:center;margin-top:6px">Log in ${ICON.arrow}</button>
      <button class="otp-cta" data-otp type="button">${ICON.mail}<span>Email one-time sign-in link</span></button>
      ${isP ? `<p class="muted small" style="text-align:center;margin-top:12px"><a data-forgot>Forgot your password?</a></p>` : ''}
      ${isP ? '' : `<div class="center-note">Accounts are provisioned by an administrator.</div>`}
    `);
    if (isP) wireAuthTabs();
    const _bk = document.querySelector('[data-back]'); if (_bk) _bk.onclick = renderRoleChoice;
    const _fg = document.querySelector('[data-forgot]'); if (_fg) _fg.onclick = () => renderForgot();
    const _otp = document.querySelector('[data-otp]'); if (_otp) _otp.onclick = () => renderOtpRequest(val('l_user'));
    document.getElementById('l_go').onclick = doLogin;
    document.getElementById('l_pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  }
  function loginAlert(m, kind) { document.getElementById('loginAlert').innerHTML = `<div class="alert ${kind || 'err'}">${esc(m)}</div>`; }
  async function doLogin() {
    const login = val('l_user'), password = val('l_pw');
    if (!login || !password) return loginAlert('Enter your username and password.');
    const btn = document.getElementById('l_go'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Signing in…';
    const r = await rawApi('POST', '/api/auth/login', { login, password });
    btn.disabled = false; btn.innerHTML = 'Log in';
    const code = r.data && r.data.code;
    if (r.status === 200 && code === 'OK') { ME = r.data.user; return enterApp(); }
    if (code === 'PASSWORD_SETUP_REQUIRED') return renderSetPassword(login);
    if (code === 'PASSWORD_RESET_REQUIRED') return loginAlert((r.data && r.data.message) || 'A password reset is required. Use the link sent by your administrator.');
    if (code === 'MFA_REQUIRED') return renderMfa(login);
    if (code === 'ACCOUNT_DEACTIVATED') return renderDeactivated();
    if (code === 'RATE_LIMITED') return loginAlert(r.data.message, 'err');
    loginAlert((r.data && r.data.message) || 'Sign-in failed.');
  }
  function renderOtpRequest(prefill) {
    stopRealtime();
    const isP = authRole === 'physician';
    const ctx = authRole ? `<button class="backlink" data-back>${ICON.back} Back to password sign in</button><div class="roletag">${isP ? ICON.up : ICON.users} ${isP ? 'Physician' : 'Credentialing team'}</div>` : '';
    root().innerHTML = authLayout(`
      ${ctx}
      ${isP ? authTabs('login') : ''}
      <h2 style="font-size:22px;margin-bottom:4px">Email one-time link</h2>
      <p class="muted small" style="margin-bottom:18px">Enter your account email and we will send a sign-in link.</p>
      <div id="otpReqAlert"></div>
      <div class="field"><label>Email</label><input id="otp_email" type="email" autocomplete="email" value="${esc(prefill || '')}"></div>
      <button class="otp-cta primary" id="otp_go" type="button">${ICON.mail}<span>Email one-time link</span></button>
    `);
    if (isP) wireAuthTabs();
    const _bk = document.querySelector('[data-back]'); if (_bk) _bk.onclick = () => renderLogin();
    document.getElementById('otp_go').onclick = doOtpRequest;
    document.getElementById('otp_email').addEventListener('keydown', e => { if (e.key === 'Enter') doOtpRequest(); });
  }
  async function doOtpRequest() {
    const login = val('otp_email');
    const alert = (m, k) => document.getElementById('otpReqAlert').innerHTML = `<div class="alert ${k || 'err'}">${esc(m)}</div>`;
    if (!login) return alert('Enter your email address.');
    const btn = document.getElementById('otp_go'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Sending…';
    const r = await rawApi('POST', '/api/auth/otp/request', { login });
    btn.disabled = false; btn.innerHTML = `${ICON.mail}<span>Email one-time link</span>`;
    if (r.status === 200) return alert((r.data && r.data.message) || 'If this account can use email sign-in, a one-time link has been sent.', 'info');
    alert((r.data && r.data.message) || 'Could not send a sign-in link.');
  }

  function renderSignup() {
    stopRealtime();
    root().innerHTML = authLayout(`
      <button class="backlink" data-back>${ICON.back} Choose a different role</button>
      <div class="roletag">${ICON.up} Physician</div>
      ${authTabs('signup')}
      <h2 style="font-size:22px;margin-bottom:4px">Create your account</h2>
      <p class="muted small" style="margin-bottom:18px">Sign up with your email to build your profile and upload your credentialing documents.</p>
      <div id="suAlert"></div>
      <div class="field"><label>Full name</label><input id="su_name" autocomplete="name" placeholder="Dr. Jane Smith"></div>
      <div class="field"><label>Email</label><input id="su_email" type="email" autocomplete="email" placeholder="you@example.com"></div>
      <div class="field"><label>Password</label><input id="su_pw" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
      <div class="field"><label>Confirm password</label><input id="su_pw2" type="password" autocomplete="new-password"></div>
      <button class="btn" id="su_go" style="width:100%;justify-content:center;margin-top:6px">Create account ${ICON.arrow}</button>
    `);
    wireAuthTabs();
    document.querySelector('[data-back]').onclick = () => renderRoleChoice();
    document.getElementById('su_pw2').addEventListener('keydown', e => { if (e.key === 'Enter') doSignup(); });
    document.getElementById('su_go').onclick = doSignup;
  }
  function signupAlert(m, kind) { document.getElementById('suAlert').innerHTML = `<div class="alert ${kind || 'err'}">${esc(m)}</div>`; }
  async function doSignup() {
    const displayName = val('su_name'), email = val('su_email'), pw = val('su_pw'), pw2 = val('su_pw2');
    if (!email) return signupAlert('Enter your email address.');
    if (pw.length < 8) return signupAlert('Password must be at least 8 characters.');
    if (pw !== pw2) return signupAlert('Passwords do not match.');
    const btn = document.getElementById('su_go'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Creating account…';
    const r = await rawApi('POST', '/api/auth/register', { email, password: pw, displayName });
    btn.disabled = false; btn.innerHTML = 'Create account';
    if (r.status === 201 && r.data && r.data.code === 'OK') { ME = r.data.user; return enterApp(); }
    signupAlert((r.data && r.data.message) || 'Could not create your account.');
  }

  function renderSetPassword(login) {
    root().innerHTML = authLayout(`
      <h2 style="font-size:22px;margin-bottom:4px">Set your password</h2>
      <p class="muted small" style="margin-bottom:18px">Your account requires a password before first sign-in.</p>
      <div id="spAlert"></div>
      <div class="field"><label>New password</label><input id="sp_pw" type="password" autocomplete="new-password"></div>
      <div class="field"><label>Confirm password</label><input id="sp_pw2" type="password" autocomplete="new-password"></div>
      <button class="btn" id="sp_go" style="width:100%;justify-content:center">Set password & continue ${ICON.arrow}</button>
    `);
    document.getElementById('sp_go').onclick = async () => {
      const pw = val('sp_pw'), pw2 = val('sp_pw2');
      if (pw.length < 8) return document.getElementById('spAlert').innerHTML = '<div class="alert err">Password must be at least 8 characters.</div>';
      if (pw !== pw2) return document.getElementById('spAlert').innerHTML = '<div class="alert err">Passwords do not match.</div>';
      const r = await rawApi('POST', '/api/auth/set-password', { login, newPassword: pw });
      if (r.status === 200) { ME = r.data.user; return enterApp(); }
      document.getElementById('spAlert').innerHTML = `<div class="alert err">${esc((r.data && r.data.message) || 'Could not set password.')}</div>`;
    };
  }
  function renderMfa(login) {
    root().innerHTML = authLayout(`
      <h2 style="font-size:22px;margin-bottom:4px">Multi-factor authentication</h2>
      <p class="muted small" style="margin-bottom:18px">Enter the 6-digit code from your authenticator app.</p>
      <div class="alert info">MFA is required for this account. (Verification endpoint is a stub in this build.)</div>
      <div class="field"><label>Authentication code</label><input id="mfa_code" inputmode="numeric" placeholder="123456"></div>
      <button class="btn" style="width:100%;justify-content:center" onclick="location.reload()">Back to sign in</button>
    `);
  }

  /* --------------------- Forgot / reset password ----------------------- */
  function renderForgot() {
    stopRealtime();
    root().innerHTML = authLayout(`
      <button class="backlink" data-back>${ICON.back} Back to sign in</button>
      <div class="roletag">${ICON.up} Physician</div>
      <h2 style="font-size:22px;margin-bottom:4px">Reset your password</h2>
      <p class="muted small" style="margin-bottom:18px">Enter the email on your provider account and we'll send you a link to choose a new password.</p>
      <div id="fgAlert"></div>
      <div class="field"><label>Email</label><input id="fg_email" type="email" autocomplete="email" placeholder="you@example.com"></div>
      <button class="btn" id="fg_go" style="width:100%;justify-content:center;margin-top:6px">Send reset link ${ICON.arrow}</button>
    `);
    document.querySelector('[data-back]').onclick = () => renderLogin();
    document.getElementById('fg_email').addEventListener('keydown', e => { if (e.key === 'Enter') doForgot(); });
    document.getElementById('fg_go').onclick = doForgot;
  }
  async function doForgot() {
    const email = val('fg_email');
    const alert = (m, k) => document.getElementById('fgAlert').innerHTML = `<div class="alert ${k || 'err'}">${esc(m)}</div>`;
    if (!email) return alert('Enter your email address.');
    const btn = document.getElementById('fg_go'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Sending…';
    const r = await rawApi('POST', '/api/auth/forgot', { email });
    btn.disabled = false; btn.innerHTML = 'Send reset link';
    if (r.status === 200) alert((r.data && r.data.message) || 'If an account exists, a reset link has been sent.', 'ok');
    else alert((r.data && r.data.message) || 'Could not process the request.');
  }
  function renderReset(token) {
    stopRealtime();
    root().innerHTML = authLayout(`
      <h2 style="font-size:22px;margin-bottom:4px">Choose a new password</h2>
      <p class="muted small" style="margin-bottom:18px">Enter a new password for your account. You will be signed in automatically after it is saved.</p>
      <div id="rsAlert"></div>
      <div class="field"><label>New password</label><input id="rs_pw" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
      <div class="field"><label>Confirm password</label><input id="rs_pw2" type="password" autocomplete="new-password"></div>
      <button class="btn" id="rs_go" style="width:100%;justify-content:center">Set new password ${ICON.arrow}</button>
    `);
    document.getElementById('rs_pw2').addEventListener('keydown', e => { if (e.key === 'Enter') doReset(token); });
    document.getElementById('rs_go').onclick = () => doReset(token);
  }
  async function doReset(token) {
    const pw = val('rs_pw'), pw2 = val('rs_pw2');
    const alert = (m, k) => document.getElementById('rsAlert').innerHTML = `<div class="alert ${k || 'err'}">${esc(m)}</div>`;
    if (pw.length < 8) return alert('Password must be at least 8 characters.');
    if (pw !== pw2) return alert('Passwords do not match.');
    const btn = document.getElementById('rs_go'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Saving…';
    const r = await rawApi('POST', '/api/auth/reset', { token, newPassword: pw });
    if (r.status === 200 && r.data && r.data.code === 'OK') { clearResetParam(); ME = r.data.user; toast('Password updated', 'You are now signed in.'); return enterApp(); }
    btn.disabled = false; btn.innerHTML = 'Set new password';
    alert((r.data && r.data.message) || 'Could not reset your password.');
  }
  function renderOtpLogin(token) {
    stopRealtime();
    root().innerHTML = authLayout(`
      <h2 style="font-size:22px;margin-bottom:4px">Signing you in</h2>
      <p class="muted small" style="margin-bottom:18px">Checking your one-time email link.</p>
      <div id="otpAlert"><div class="alert info"><span class="spin" style="margin-right:8px"></span>Opening Upload Doc…</div></div>
    `);
    doOtpLogin(token);
  }
  async function doOtpLogin(token) {
    const r = await rawApi('POST', '/api/auth/otp', { token });
    if (r.status === 200 && r.data && r.data.code === 'OK') { clearParam('otp'); ME = r.data.user; toast('Signed in', 'Your email link was accepted.'); return enterApp(); }
    document.getElementById('otpAlert').innerHTML = `<div class="alert err">${esc((r.data && r.data.message) || 'This sign-in link is invalid or expired.')}</div><button class="btn subtle" style="width:100%;justify-content:center;margin-top:12px" id="otpBack">Back to sign in</button>`;
    document.getElementById('otpBack').onclick = () => { clearParam('otp'); renderRoleChoice(); };
  }
  function clearResetParam() { clearParam('reset'); }
  function clearParam(name) { try { const u = new URL(window.location.href); u.searchParams.delete(name); window.history.replaceState({}, document.title, u.pathname + u.search + u.hash); } catch (_) {} }

  /* --------------------------- Deactivated ----------------------------- */
  function renderDeactivated() {
    stopRealtime();
    ME = null;
    root().innerHTML = `
      <div class="screen"><div class="panel deact-wrap" style="max-width:520px">
        <div class="pb" style="padding:34px 34px 30px">
          <div class="deact-ic">${ICON.lock}</div>
          <h1 style="text-align:center">Account deactivated</h1>
          <div class="sub" style="text-align:center">Your access to Upload Doc has been suspended by an administrator.</div>
          <div class="alert info" style="text-align:left">
            <div><b>Need access restored?</b><br>Contact your credentialing administrator or submit a support ticket to <b>support@uploaddoc.io</b>. Reference your username when you reach out.</div>
          </div>
          <div style="text-align:center"><span class="pill-check"><span class="spin" style="border-color:rgba(20,102,184,.35);border-top-color:var(--blue-600)"></span> Checking for reactivation…</span></div>
          <div class="center-note">This page restores your session automatically the moment your account is reactivated — no need to sign in again.</div>
        </div>
      </div></div>`;
    // Automatic restore check (polling) + realtime handled separately.
    clearInterval(deactPoll);
    deactPoll = setInterval(async () => {
      const me = await rawApi('GET', '/api/auth/me');
      if (me.status === 200) { clearInterval(deactPoll); ME = me.data.user; toast('Access restored', 'Welcome back.'); enterApp(); }
    }, 5000);
  }

  /* ------------------------------ App shell ---------------------------- */
  function enterApp() {
    clearInterval(deactPoll);
    startRealtime();
    scheduleRefresh();
    let view = hasPortal() ? 'portal' : (hasInternal() ? 'internal' : (hasAnyAdmin() ? 'admin' : 'portal'));
    try {
      const v = localStorage.getItem('updoc.shell.' + ME.id);
      if (v === 'admin' && hasAnyAdmin()) view = 'admin';
      else if (v === 'internal' && hasInternal()) view = 'internal';
      else if (v === 'portal' && hasPortal()) view = 'portal';
    } catch (e) {}
    renderShell(view);
  }
  function renderShell(view) {
    if (view === 'admin' && !hasAnyAdmin()) view = hasPortal() ? 'portal' : (hasInternal() ? 'internal' : 'portal');
    if (view === 'internal' && !hasInternal()) view = hasPortal() ? 'portal' : (hasAnyAdmin() ? 'admin' : 'portal');
    if (view === 'portal' && !hasPortal()) view = hasInternal() ? 'internal' : (hasAnyAdmin() ? 'admin' : 'portal');
    try { localStorage.setItem('updoc.shell.' + ME.id, view); } catch (e) {}
    const roleLabel = can('portal.review') ? 'Credentialing team' : (hasInternal() ? 'Internal credentialing' : 'Physician');
    const initials = (ME.displayName || ME.username || 'U').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();
    const portalBtn = hasPortal() ? `<button class="${view === 'portal' ? 'active' : ''}" data-nav="portal">Portal</button>` : '';
    const internalBtn = hasInternal() ? `<button class="${view === 'internal' ? 'active' : ''}" data-nav="internal">Internal Credentialing</button>` : '';
    const adminBtn = hasAnyAdmin() ? `<button class="${view === 'admin' ? 'active' : ''}" data-nav="admin">Admin console</button>` : '';
    root().innerHTML = `
      <div class="appshell">
        <header class="app">
          <div class="brand"><span class="logo">${ICON.logo}</span> Upload&nbsp;Doc</div>
          <nav>
            ${portalBtn}
            ${internalBtn}
            ${adminBtn}
          </nav>
          <div class="headspace"></div>
          <div class="whoami">
            <div style="text-align:right">
              <div style="font-weight:600;color:var(--ink)">${esc(ME.displayName || ME.username)}</div>
              <div class="small">${esc(roleLabel)} · ${esc(ME.provider)}</div>
            </div>
            <button class="avatar profile-avatar ${can('portal.review') || hasInternal() ? 'team' : ''}" id="profileBtn" type="button" title="Change password">${esc(initials)}</button>
            <button class="logout-btn" id="logoutBtn">Log out</button>
          </div>
        </header>
        <div id="appContent"></div>
      </div>`;
    root().querySelectorAll('[data-nav]').forEach(b => b.onclick = () => renderShell(b.dataset.nav));
    document.getElementById('profileBtn').onclick = changePasswordModal;
    document.getElementById('logoutBtn').onclick = doLogout;
    if (view === 'admin' && hasAnyAdmin()) renderAdmin(document.getElementById('appContent'));
    else window.Portal.render(document.getElementById('appContent'), ME, { mode: view === 'internal' ? 'internal' : 'providers' });
  }
  async function doLogout() {
    await rawApi('POST', '/api/auth/logout');
    stopRealtime(); clearInterval(refreshTimer); ME = null;
    renderRoleChoice();
  }

  function changePasswordModal() {
    if (ME.provider !== 'local') {
      return modal('Change password', `<div class="alert info">This account uses directory sign-in. Change your password with your directory administrator.</div>`, close => close(), 'Done');
    }
    modal('Change password', `
      <div id="cpAlert"></div>
      <div class="field"><label>Current password</label><input id="cp_cur" type="password" autocomplete="current-password"></div>
      <div class="field"><label>New password</label><input id="cp_new" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
      <div class="field"><label>Confirm new password</label><input id="cp_new2" type="password" autocomplete="new-password"></div>
    `, async (close) => {
      const cur = val('cp_cur'), next = val('cp_new'), next2 = val('cp_new2');
      const alert = (m) => document.getElementById('cpAlert').innerHTML = `<div class="alert err">${esc(m)}</div>`;
      if (!cur) return alert('Current password is required.');
      if (next.length < 8) return alert('Password must be at least 8 characters.');
      if (next !== next2) return alert('Passwords do not match.');
      const r = await api('POST', '/api/auth/change-password', { currentPassword: cur, newPassword: next });
      if (r.status === 200) { toast('Password changed', 'Your new password is ready.'); close(); return; }
      alert((r.data && r.data.message) || 'Could not change password.');
    }, 'Change password');
    const submit = () => { const btn = document.querySelector('[data-msave]'); if (btn) btn.click(); };
    ['cp_cur', 'cp_new', 'cp_new2'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }); });
  }

  /* ---------------------------- Realtime ------------------------------- */
  function startRealtime() {
    stopRealtime();
    try {
      sse = new EventSource('/api/realtime');
      sse.addEventListener('account.deactivated', () => { stopRealtime(); renderDeactivated(); });
      sse.addEventListener('account.reactivated', async () => {
        const me = await rawApi('GET', '/api/auth/me');
        if (me.status === 200) { ME = me.data.user; enterApp(); }
      });
      sse.addEventListener('permissions.changed', async () => {
        const me = await api('GET', '/api/auth/me');
        if (me.status === 200) { ME = me.data.user; toast('Permissions updated', 'Your access was updated by an administrator.'); renderShell('portal'); }
        else if (me.status === 403) renderDeactivated();
      });
      // Fallback: if SSE errors, a periodic /me check still catches deactivation.
      sse.onerror = () => { /* EventSource auto-reconnects; nothing to do */ };
    } catch (_) { /* SSE unsupported: refresh loop + guards still enforce */ }
  }
  function stopRealtime() { if (sse) { try { sse.close(); } catch (_) {} sse = null; } }

  // Silent access-token refresh + a lightweight liveness/deactivation check.
  function scheduleRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
      const r = await rawApi('POST', '/api/auth/refresh');
      if (r.status !== 200) { const me = await rawApi('GET', '/api/auth/me'); if (me.status === 403) renderDeactivated(); else if (me.status === 401) { stopRealtime(); renderRoleChoice(); } }
      else if (r.data && r.data.active === false) renderDeactivated();
    }, 8 * 60 * 1000);
  }

  /* ==================================================================== */
  /*                           ADMIN CONSOLE                              */
  /* ==================================================================== */
  let adminTab = 'users';
  let usersSubTab = 'active';
  let usersSearch = '';
  let usersPage = 1;
  const USERS_PAGE_SIZE = 6;
  const adminCache = {};
  async function renderAdmin(container) {
    const tabs = [
      ['users', 'Users', 'users.view'],
      ['roles', 'Roles', 'roles.view'],
      ['perms', 'Permissions', 'roles.view'],
      ['ldap', 'Directory (LDAP)', 'ldap.manage'],
      ['smtp', 'Email (SMTP)', 'smtp.manage'],
      ['catalog', 'Documents', 'catalog.manage'],
      ['internalCatalog', 'Internal Documents', 'catalog.manage'],
      ['audit', 'Audit log', 'audit.view'],
      ['thirdparty', '3rd Party Login', 'audit.view']
    ].filter(t => can(t[2]));
    if (!tabs.find(t => t[0] === adminTab)) adminTab = tabs[0] && tabs[0][0];
    container.innerHTML = `<div class="wrap">
      <h1 style="font-size:24px">Admin console</h1>
      <p class="muted" style="margin:4px 0 16px">Manage users, roles, permissions, directory settings and audit history.</p>
      <div class="admin-tabs">${tabs.map(t => `<button class="${t[0] === adminTab ? 'active' : ''}" data-atab="${t[0]}">${t[1]}</button>`).join('')}</div>
      <div id="adminBody"></div>
    </div>`;
    container.querySelectorAll('[data-atab]').forEach(b => b.onclick = () => { adminTab = b.dataset.atab; renderAdmin(container); });
    const body = document.getElementById('adminBody');
    if (adminTab === 'users') return adminUsers(body);
    if (adminTab === 'roles') return adminRoles(body);
    if (adminTab === 'perms') return adminPerms(body);
    if (adminTab === 'ldap') return adminLdap(body);
    if (adminTab === 'smtp') return adminSmtp(body);
    if (adminTab === 'catalog') return adminCatalog(body);
    if (adminTab === 'internalCatalog') return adminCatalog(body, { base: '/api/admin/internal-catalog', title: 'Internal Documents', audience: 'employee' });
    if (adminTab === 'audit') return adminAudit(body);
    if (adminTab === 'thirdparty') return adminThirdParty(body);
  }

  /* ------ Users ------ */
  async function adminUsers(body) {
    body.innerHTML = '<div class="muted">Loading…</div>';
    const [u, r] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/roles')]);
    const usersList = (u.data.users || []);
    const deletedList = (u.data.deleted || []);
    const roles = (r.data.roles || []);
    adminCache.roles = roles;
    const canManage = can('users.manage');
    const avatarOf = us => esc((us.displayName || us.username).split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase());
    const matches = us => {
      const roleText = (us.roles || []).map(rk => ((roles.find(x => x.key === rk) || {}).label || rk)).join(' ');
      const hay = [us.displayName, us.username, us.email, us.provider, roleText, us.active ? 'active' : 'deactivated'].join(' ').toLowerCase();
      return !usersSearch || hay.includes(usersSearch.toLowerCase());
    };
    const activeFiltered = usersList.filter(matches);
    const deletedFiltered = deletedList.filter(matches);
    const currentList = usersSubTab === 'deleted' ? deletedFiltered : activeFiltered;
    const pageCount = Math.max(1, Math.ceil(currentList.length / USERS_PAGE_SIZE));
    if (usersPage > pageCount) usersPage = pageCount;
    const pageStart = (usersPage - 1) * USERS_PAGE_SIZE;
    const pageItems = currentList.slice(pageStart, pageStart + USERS_PAGE_SIZE);
    const pageInfo = currentList.length ? `${pageStart + 1}-${Math.min(pageStart + USERS_PAGE_SIZE, currentList.length)} of ${currentList.length}` : '0 of 0';
    const pager = `<div class="muted small" style="display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap;white-space:nowrap">
      <span>${esc(pageInfo)}</span>
      <button class="btn subtle sm" data-page="prev" ${usersPage <= 1 ? 'disabled' : ''}>Prev</button>
      <span>Page ${usersPage} of ${pageCount}</span>
      <button class="btn subtle sm" data-page="next" ${usersPage >= pageCount ? 'disabled' : ''}>Next</button>
    </div>`;
    const rows = pageItems.map(us => {
      const roleChips = us.roles.map(rk => `<span class="chip">${esc((roles.find(x => x.key === rk) || {}).label || rk)}</span>`).join(' ');
      const status = us.active ? '<span class="badge b-approved">Active</span>' : '<span class="badge b-attention">Deactivated</span>';
      const isSelf = us.id === ME.id;
      const toggle = canManage ? `<button class="btn ${us.active ? 'danger-soft' : ''} sm" data-toggle="${us.id}" data-active="${us.active ? '0' : '1'}" ${isSelf && us.active ? 'disabled title="You cannot deactivate yourself"' : ''}>${us.active ? 'Deactivate' : 'Activate'}</button>` : '';
      const editRoles = canManage ? `<button class="btn subtle sm" data-editroles="${us.id}">Roles</button>` : '';
      const resetPw = canManage ? `<button class="btn subtle sm" data-resetpw="${us.id}" ${(!us.active || us.provider !== 'local' || !us.email) ? 'disabled title="Requires an active local account with email"' : ''}>Reset</button>` : '';
      const loginLink = canManage ? `<button class="btn ghost sm" data-loginlink="${us.id}" ${(!us.active || !us.email || us.forcePasswordReset) ? 'disabled title="Requires an active account with email and no pending password reset"' : ''}>OTP</button>` : '';
      // Delete only for team members (never 3rd-party providers) and never self.
      const del = canManage && us.isTeam && !isSelf ? `<button class="btn danger sm" data-delete="${us.id}">Delete</button>` : '';
      return `<tr>
        <td><div class="who"><div class="avatar">${avatarOf(us)}</div>
          <div><div class="nm">${esc(us.displayName || us.username)}</div><div class="sp">${esc(us.username)}${us.email ? ' · ' + esc(us.email) : ''}</div></div></div></td>
        <td class="small"><span class="chip gray">${esc(us.provider)}</span></td>
        <td><div class="chips">${roleChips || '<span class="muted small">none</span>'}</div></td>
        <td>${status}</td>
        <td class="small">${fmtLastLogin(us.lastLoginAt)}</td>
        <td style="text-align:right"><div class="dact">${editRoles}${resetPw}${loginLink}${toggle}${del}</div></td>
      </tr>`;
    }).join('');
    const deletedRows = pageItems.map(us => {
      const roleChips = us.roles.map(rk => `<span class="chip">${esc((roles.find(x => x.key === rk) || {}).label || rk)}</span>`).join(' ');
      const restore = canManage ? `<button class="btn subtle sm" data-restore="${us.id}">Restore</button>` : '';
      return `<tr>
        <td><div class="who"><div class="avatar" style="opacity:.6">${avatarOf(us)}</div>
          <div><div class="nm">${esc(us.displayName || us.username)}</div><div class="sp">${esc(us.username)}${us.email ? ' · ' + esc(us.email) : ''}</div></div></div></td>
        <td class="small"><span class="chip gray">${esc(us.provider)}</span></td>
        <td><div class="chips">${roleChips || '<span class="muted small">none</span>'}</div></td>
        <td class="small">${us.deletedAt ? esc(new Date(us.deletedAt).toLocaleString()) : '—'}</td>
        <td style="text-align:right"><div class="dact">${restore}</div></td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      <div style="display:flex;gap:10px;align-items:end;justify-content:space-between;margin:0 0 10px;flex-wrap:wrap">
        <div class="admin-subtabs" style="margin:0">
          <button class="${usersSubTab === 'active' ? 'active' : ''}" data-ustab="active">Users <span class="st-count">${usersList.length}</span></button>
          <button class="${usersSubTab === 'deleted' ? 'active' : ''}" data-ustab="deleted">Deleted <span class="st-count">${deletedList.length}</span></button>
        </div>
        <div class="field" style="margin:0;min-width:280px;flex:1"><label>Search users</label><input id="userSearch" value="${esc(usersSearch)}" placeholder="Name, email, role, source, status"></div>
        ${pager}
      </div>
      ${usersSubTab === 'deleted'
        ? `<div class="card"><div class="card-h"><h3>Deleted <span class="muted small">(${deletedFiltered.length}${usersSearch ? ` of ${deletedList.length}` : ''})</span></h3><span class="muted small">Hidden from active users · cannot sign in</span></div>
        <div class="card-b" style="padding:6px 8px"><table class="roster">
          <thead><tr><th>User</th><th>Source</th><th>Roles</th><th>Deleted</th><th></th></tr></thead>
          <tbody>${deletedRows || '<tr><td colspan="5" class="muted" style="padding:14px">No matching deleted users.</td></tr>'}</tbody></table></div></div>`
        : `<div class="card"><div class="card-h"><h3>Users (${activeFiltered.length}${usersSearch ? ` of ${usersList.length}` : ''})</h3>
        ${canManage ? '<button class="btn sm" id="addUser">+ Add user</button>' : ''}</div>
        <div class="card-b" style="padding:6px 8px"><table class="roster">
          <thead><tr><th>User</th><th>Source</th><th>Roles</th><th>Status</th><th>Last login</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="muted" style="padding:14px">No matching users.</td></tr>'}</tbody></table></div></div>`}`;
    const search = document.getElementById('userSearch');
    if (search) search.oninput = () => {
      usersSearch = search.value.trim(); usersPage = 1;
      adminUsers(body).then(() => { const s = document.getElementById('userSearch'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
    };
    body.querySelectorAll('[data-page]').forEach(b => b.onclick = () => { usersPage += b.dataset.page === 'next' ? 1 : -1; adminUsers(body); });
    body.querySelectorAll('[data-ustab]').forEach(b => b.onclick = () => { usersSubTab = b.dataset.ustab; usersPage = 1; adminUsers(body); });
    body.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => toggleUser(b.dataset.toggle, b.dataset.active === '1', body));
    body.querySelectorAll('[data-editroles]').forEach(b => b.onclick = () => editUserRoles(b.dataset.editroles, usersList, roles, body));
    body.querySelectorAll('[data-resetpw]').forEach(b => b.onclick = () => sendPasswordReset(b.dataset.resetpw, usersList));
    body.querySelectorAll('[data-loginlink]').forEach(b => b.onclick = () => sendLoginLink(b.dataset.loginlink, usersList));
    body.querySelectorAll('[data-delete]').forEach(b => b.onclick = () => deleteUser(b.dataset.delete, usersList, body));
    body.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => restoreUser(b.dataset.restore, body));
    const add = document.getElementById('addUser'); if (add) add.onclick = () => addUserModal(roles, body);
  }
  function deleteUser(id, usersList, body) {
    const us = usersList.find(x => x.id === id) || {};
    modal(`Delete ${esc(us.displayName || us.username || 'user')}?`,
      `<p style="margin:0 0 8px">This team member will be moved to the <strong>Deleted</strong> section. They will no longer be able to sign in or make changes, and they will be hidden from current users.</p>
       <p class="muted small" style="margin:0">You can restore the account later from the Deleted section.</p>`,
      async (close) => {
        const r = await api('DELETE', `/api/admin/users/${id}`);
        if (r.status === 200) { toast('User deleted', 'Moved to the Deleted section.'); close(); adminUsers(body); }
        else toast('Could not delete', (r.data && r.data.message) || '', 'err');
      }, 'Delete user');
  }
  async function restoreUser(id, body) {
    const r = await api('POST', `/api/admin/users/${id}/restore`);
    if (r.status === 200) toast('User restored', 'The account is active again.');
    else toast('Could not restore', (r.data && r.data.message) || '', 'err');
    adminUsers(body);
  }
  async function toggleUser(id, activate, body) {
    const r = await api('PATCH', `/api/admin/users/${id}/active`, { active: activate });
    if (r.status === 200) toast(activate ? 'User activated' : 'User deactivated', activate ? 'Access restored.' : 'Active sessions are being terminated.');
    else toast('Action blocked', (r.data && r.data.message) || 'Could not update.', 'err');
    adminUsers(body);
  }
  function editUserRoles(id, usersList, roles, body) {
    const us = usersList.find(x => x.id === id);
    const checks = roles.map(rl => `<label class="rolechk"><input type="checkbox" value="${rl.key}" ${us.roles.includes(rl.key) ? 'checked' : ''}> ${esc(rl.label)} <span class="muted small">(${rl.key})</span></label>`).join('');
    modal(`Assign roles — ${esc(us.displayName || us.username)}`, `<div id="roleChecks">${checks}</div>`, async (close) => {
      const roleKeys = [...document.querySelectorAll('#roleChecks input:checked')].map(i => i.value);
      const r = await api('PATCH', `/api/admin/users/${id}/roles`, { roles: roleKeys });
      if (r.status === 200) { toast('Roles updated'); close(); adminUsers(body); }
      else toast('Update failed', (r.data && r.data.message) || '', 'err');
    }, 'Save roles');
  }
  function addUserModal(roles, body) {
    const checks = roles.map(rl => `<label class="rolechk"><input type="checkbox" value="${rl.key}" ${rl.key === 'staff' ? 'checked' : ''}> ${esc(rl.label)}</label>`).join('');
    modal('Add user', `
      <div class="field"><label>Full name</label><input id="nu_name"></div>
      <div class="field"><label>Username</label><input id="nu_user"></div>
      <div class="field"><label>Email</label><input id="nu_email" type="email"></div>
      <div class="field"><label>Temporary password <span class="muted small">(leave blank to require setup at first login)</span></label><input id="nu_pw" type="password"></div>
      <label style="font-size:13px;font-weight:600">Roles</label>${checks}`, async (close) => {
      const roleKeys = [...document.querySelectorAll('.modal-bg input[type=checkbox]:checked')].map(i => i.value);
      const r = await api('POST', '/api/admin/users', { username: val('nu_user'), email: val('nu_email'), displayName: val('nu_name'), password: val('nu_pw') || undefined, roles: roleKeys, mustSetPassword: !val('nu_pw') });
      if (r.status === 201) { toast('User created'); close(); adminUsers(body); }
      else toast('Could not create user', (r.data && r.data.message) || '', 'err');
    }, 'Create user');
  }

  async function sendPasswordReset(id, usersList) {
    const us = usersList.find(x => x.id === id);
    if (!us) return;
    if (!confirm(`Send a forced password reset to ${us.displayName || us.username}? Their current password will stop working until they use the reset link.`)) return;
    const r = await api('POST', `/api/admin/users/${id}/password-reset`);
    if (r.status === 200) {
      toast(r.data.emailed ? 'Reset email sent' : 'Reset link created', r.data.message || '');
      return showIssuedLink('Password reset link', r.data.message || '', r.data.link);
    }
    toast('Could not send reset', (r.data && r.data.message) || '', 'err');
  }
  async function sendLoginLink(id, usersList) {
    const us = usersList.find(x => x.id === id);
    if (!us) return;
    const r = await api('POST', `/api/admin/users/${id}/login-link`);
    if (r.status === 200) {
      toast(r.data.emailed ? 'OTP email sent' : 'OTP link created', r.data.message || '');
      return showIssuedLink('One-time sign-in link', r.data.message || '', r.data.link);
    }
    toast('Could not send OTP', (r.data && r.data.message) || '', 'err');
  }
  function showIssuedLink(title, message, link) {
    modal(title, `
      <p class="muted small" style="margin-top:0">${esc(message || 'The link was created.')}</p>
      <div class="field"><label>One-click link</label><input id="issuedLink" readonly value="${esc(link || '')}"></div>
      <button class="btn subtle" id="copyIssuedLink" type="button">Copy link</button>
    `, close => close(), 'Done');
    const cp = document.getElementById('copyIssuedLink');
    if (cp) cp.onclick = async () => {
      const input = document.getElementById('issuedLink');
      try { await navigator.clipboard.writeText(input.value); toast('Link copied'); }
      catch (_) { input.select(); document.execCommand('copy'); toast('Link copied'); }
    };
  }

  /* ------ Roles ------ */
  async function adminRoles(body) {
    body.innerHTML = '<div class="muted">Loading…</div>';
    const [r, p] = await Promise.all([api('GET', '/api/admin/roles'), api('GET', '/api/admin/permissions')]);
    const roles = r.data.roles || [];
    const perms = p.data.permissions || [];
    const matrix = p.data.matrix || [];
    adminCache.perms = perms;
    const canManage = can('roles.manage');
    const cards = roles.map(role => {
      const eff = (matrix.find(m => m.role === role.key) || { perms: [] }).perms.filter(x => x.allowed).length;
      const flags = [role.system ? '<span class="tag-sys">SYSTEM</span>' : '', !role.editable ? '<span class="chip gray">locked</span>' : '', !role.deletable ? '<span class="chip gray">protected</span>' : ''].filter(Boolean).join(' ');
      return `<div class="card" style="margin-bottom:12px"><div class="card-b" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px"><div style="font-weight:700;font-size:15px">${esc(role.label)} ${flags}</div>
          <div class="muted small">key: <span class="mono">${esc(role.key)}</span> · ${eff} permission(s)</div></div>
        ${canManage && role.editable ? `<button class="btn subtle sm" data-editrole="${role.key}">Edit</button>` : ''}
        ${canManage && role.deletable ? `<button class="btn ghost sm" data-delrole="${role.key}">Delete</button>` : ''}
      </div></div>`;
    }).join('');
    body.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div class="muted small">${roles.length} roles. Protected roles (admin/staff) cannot be deleted.</div>
      ${canManage ? '<button class="btn sm" id="addRole">+ New role</button>' : ''}</div>${cards}`;
    body.querySelectorAll('[data-editrole]').forEach(b => b.onclick = () => roleModal(roles.find(x => x.key === b.dataset.editrole), perms, matrix, body));
    body.querySelectorAll('[data-delrole]').forEach(b => b.onclick = () => delRole(b.dataset.delrole, body));
    const add = document.getElementById('addRole'); if (add) add.onclick = () => roleModal(null, perms, matrix, body);
  }
  function roleModal(role, perms, matrix, body) {
    const cur = role ? (matrix.find(m => m.role === role.key) || { perms: [] }).perms : [];
    const groups = {};
    perms.forEach(p => { (groups[p.group] = groups[p.group] || []).push(p); });
    const checks = Object.entries(groups).map(([g, arr]) => `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--slate);font-weight:700;margin:10px 0 6px">${esc(g)}</div>` +
      arr.map(p => { const on = role ? (cur.find(x => x.key === p.key) || {}).default : false; return `<label class="rolechk"><input type="checkbox" value="${p.key}" ${on ? 'checked' : ''}> ${esc(p.label)} <span class="muted small">${p.key}</span></label>`; }).join('')).join('');
    modal(role ? `Edit role — ${esc(role.label)}` : 'New role', `
      ${role ? '' : '<div class="field"><label>Role key</label><input id="r_key" placeholder="e.g. auditor"></div>'}
      <div class="field"><label>Label</label><input id="r_label" value="${role ? esc(role.label) : ''}"></div>
      <label style="font-size:13px;font-weight:600">Default permissions</label>${checks}`, async (close) => {
      const permissions = [...document.querySelectorAll('.modal-bg input[type=checkbox]:checked')].map(i => i.value);
      let r;
      if (role) r = await api('PATCH', `/api/admin/roles/${role.key}`, { label: val('r_label'), permissions });
      else r = await api('POST', '/api/admin/roles', { key: val('r_key'), label: val('r_label'), permissions });
      if (r.status < 300) { toast(role ? 'Role updated' : 'Role created'); close(); adminRoles(body); }
      else toast('Failed', (r.data && r.data.message) || '', 'err');
    }, role ? 'Save role' : 'Create role');
  }
  async function delRole(key, body) {
    if (!confirm(`Delete role "${key}"? This cannot be undone.`)) return;
    const r = await api('DELETE', `/api/admin/roles/${key}`);
    if (r.status === 200) { toast('Role deleted'); adminRoles(body); }
    else toast('Cannot delete role', (r.data && r.data.message) || '', 'err');
  }

  /* ------ Permissions matrix ------ */
  async function adminPerms(body) {
    body.innerHTML = '<div class="muted">Loading…</div>';
    const p = await api('GET', '/api/admin/permissions');
    const perms = p.data.permissions || [];
    const matrix = p.data.matrix || [];
    const canManage = can('perms.manage');
    const head = `<tr><th>Permission</th>${matrix.map(m => `<th>${esc(m.role)}</th>`).join('')}</tr>`;
    const rows = perms.map(perm => {
      const cells = matrix.map(m => {
        const cell = m.perms.find(x => x.key === perm.key) || {};
        const cls = (cell.allowed ? 'on' : 'off') + (cell.overridden ? ' ovr' : '');
        const title = cell.overridden ? 'Overridden (default: ' + (cell.default ? 'allow' : 'deny') + ')' : 'Default';
        const clickable = canManage ? `data-cell="${m.role}|${perm.key}" data-allowed="${cell.allowed ? '1' : '0'}" data-ovr="${cell.overridden ? '1' : '0'}" style="cursor:pointer"` : '';
        return `<td class="${cls}" ${clickable} title="${title}">${cell.allowed ? '✓' : '✕'}${cell.overridden ? ' *' : ''}</td>`;
      }).join('');
      return `<tr><td>${esc(perm.label)}<div class="muted small mono">${perm.key}</div></td>${cells}</tr>`;
    }).join('');
    body.innerHTML = `<div class="muted small" style="margin-bottom:10px">Effective access = override if set, else default. ${canManage ? 'Click a cell to cycle <b>allow → deny → clear override</b>. Cells marked <b>*</b> are overrides.' : 'Read-only.'}</div>
      <div class="card"><div class="card-b" style="overflow:auto"><table class="matrix">${head}${rows}</table></div></div>`;
    if (canManage) body.querySelectorAll('[data-cell]').forEach(td => td.onclick = () => cycleOverride(td.dataset.cell, td.dataset.allowed === '1', td.dataset.ovr === '1', body));
  }
  async function cycleOverride(spec, allowed, overridden, body) {
    const [roleKey, permKey] = spec.split('|');
    // cycle: not-overridden -> override allow -> override deny -> clear
    let next;
    if (!overridden) next = true;           // set allow
    else if (allowed) next = false;         // set deny
    else next = null;                       // clear
    const r = await api('PUT', '/api/admin/overrides', { roleKey, permKey, allowed: next });
    if (r.status === 200) adminPerms(body);
    else toast('Failed', (r.data && r.data.message) || '', 'err');
  }

  /* ------ LDAP ------ */
  async function adminLdap(body) {
    body.innerHTML = '<div class="muted">Loading…</div>';
    const [c, r] = await Promise.all([api('GET', '/api/admin/ldap'), api('GET', '/api/admin/roles')]);
    const cfg = c.data.config || {};
    const roles = r.data.roles || [];
    body.innerHTML = `
      <div class="card" style="max-width:720px"><div class="card-h"><h3>Directory (LDAP / LDAPS)</h3>
        <label class="rolechk" style="margin:0;border:none;padding:0"><input type="checkbox" id="ld_enabled" ${cfg.enabled ? 'checked' : ''}> Enabled</label></div>
        <div class="card-b">
          <div id="ldapAlert"></div>
          <div class="detail-grid" style="grid-template-columns:1fr 1fr">
            <div class="field"><label>Host</label><input id="ld_host" value="${esc(cfg.host || '')}" placeholder="ldap.example.com"></div>
            <div class="field"><label>Port</label><input id="ld_port" value="${esc(cfg.port || '')}" placeholder="389 / 636"></div>
          </div>
          <div class="field"><label>Base DN</label><input id="ld_base" value="${esc(cfg.baseDN || '')}" placeholder="dc=example,dc=com"></div>
          <div class="field"><label>Bind DN</label><input id="ld_bind" value="${esc(cfg.bindDN || '')}" placeholder="cn=service,dc=example,dc=com"></div>
          <div class="field"><label>Bind password ${cfg.hasPassword ? '<span class="muted small">(saved — leave blank to keep)</span>' : ''}</label><input id="ld_pw" type="password" placeholder="${cfg.hasPassword ? '••••••••' : ''}"></div>
          <div class="field"><label>User search filter <span class="muted small">— Entra ID / Azure AD: match on email via <span class="mono">userPrincipalName</span>. <span class="mono">%u</span> is replaced with the entered login.</span></label><input id="ld_filter" value="${esc(cfg.userFilter || '(userPrincipalName=%u)')}" placeholder="(userPrincipalName=%u)"></div>
          <div class="muted small" style="margin:-6px 0 12px">Common patterns: <span class="mono">(userPrincipalName=%u)</span> · both email &amp; short name <span class="mono">(|(userPrincipalName=%u)(sAMAccountName=%u))</span>. Placeholders <span class="mono">%u</span> and <span class="mono">%(user)s</span> both work.</div>
          <div class="detail-grid" style="grid-template-columns:1fr 1fr">
            <label class="rolechk"><input type="checkbox" id="ld_tls" ${cfg.useTLS ? 'checked' : ''}> Use TLS (LDAPS)</label>
            <label class="rolechk"><input type="checkbox" id="ld_verify" ${cfg.tlsVerify !== false ? 'checked' : ''}> Verify TLS certificate</label>
          </div>
          <div class="field"><label>Default role(s) for provisioned LDAP users</label>
            <div class="chips">${roles.map(rl => `<label class="chip" style="cursor:pointer"><input type="checkbox" value="${rl.key}" ${(cfg.defaultRoles || ['staff']).includes(rl.key) ? 'checked' : ''} style="margin-right:5px">${esc(rl.label)}</label>`).join('')}</div>
          </div>
          <div style="display:flex;gap:10px;margin-top:8px">
            <button class="btn" id="ld_save">Save settings</button>
            <button class="btn ghost" id="ld_test">Test connection</button>
          </div>
        </div></div>`;
    document.getElementById('ld_save').onclick = saveLdap;
    document.getElementById('ld_test').onclick = testLdap;
  }
  function ldapPayload() {
    return {
      enabled: document.getElementById('ld_enabled').checked,
      host: val('ld_host'), port: val('ld_port'), baseDN: val('ld_base'), bindDN: val('ld_bind'),
      bindPassword: val('ld_pw'), userFilter: val('ld_filter'),
      useTLS: document.getElementById('ld_tls').checked, tlsVerify: document.getElementById('ld_verify').checked,
      defaultRoles: [...document.querySelectorAll('.chips input:checked')].map(i => i.value)
    };
  }
  async function saveLdap() {
    const r = await api('PUT', '/api/admin/ldap', ldapPayload());
    if (r.status === 200) toast('Directory settings saved');
    else toast('Save failed', (r.data && r.data.message) || '', 'err');
  }
  async function testLdap() {
    const el = document.getElementById('ldapAlert');
    el.innerHTML = '<div class="alert info"><span class="spin" style="border-color:rgba(20,102,184,.3);border-top-color:var(--blue-600)"></span> Testing connection…</div>';
    const r = await api('POST', '/api/admin/ldap/test', ldapPayload());
    const d = r.data || {};
    const kind = d.status === 'ok' ? 'ok' : 'err';
    el.innerHTML = `<div class="alert ${kind}"><div><b>${esc(d.code || 'ERROR')}</b> — ${esc(d.reason || 'No response')}</div></div>`;
  }

  /* ------ SMTP / Email ------ */
  const SMTP_PRESETS = {
    sendgrid: { host: 'smtp.sendgrid.net', port: 587, secure: false, username: 'apikey', pwLabel: 'API key', hint: 'Username is <b>apikey</b>; paste your SendGrid API key as the password.' },
    resend:   { host: 'smtp.resend.com',   port: 465, secure: true,  username: 'resend', pwLabel: 'API key', hint: 'Username is <b>resend</b>; paste your Resend API key as the password.' },
    custom:   { host: '', port: 587, secure: false, username: '', pwLabel: 'Password', hint: 'Enter the host, port and credentials from your email provider.' }
  };
  async function adminSmtp(body) {
    body.innerHTML = '<div class="muted">Loading…</div>';
    const c = await api('GET', '/api/admin/smtp');
    const cfg = c.data.config || {};
    const provider = cfg.provider || 'custom';
    const pw = SMTP_PRESETS[provider] || SMTP_PRESETS.custom;
    body.innerHTML = `
      <div class="card" style="max-width:720px"><div class="card-h"><h3>Email (SMTP)</h3>
        <label class="rolechk" style="margin:0;border:none;padding:0"><input type="checkbox" id="sm_enabled" ${cfg.enabled ? 'checked' : ''}> Enabled</label></div>
        <div class="card-b">
          <div id="smtpAlert"></div>
          <p class="muted small" style="margin:-2px 0 14px">Configure how outgoing email is sent. This powers the provider <b>forgot-password</b> flow. Use SendGrid, Resend, or any standard SMTP server.</p>
          <div class="field"><label>Provider</label>
            <select id="sm_provider" style="width:100%;border:1px solid var(--line);border-radius:9px;padding:10px 12px;font-size:14px;font-family:inherit;background:#fff">
              <option value="sendgrid" ${provider === 'sendgrid' ? 'selected' : ''}>SendGrid</option>
              <option value="resend" ${provider === 'resend' ? 'selected' : ''}>Resend</option>
              <option value="custom" ${provider === 'custom' ? 'selected' : ''}>Another provider / actual email server</option>
            </select>
          </div>
          <div class="muted small" id="sm_hint" style="margin:-6px 0 12px">${pw.hint}</div>
          <div class="detail-grid" style="grid-template-columns:2fr 1fr">
            <div class="field"><label>Host</label><input id="sm_host" value="${esc(cfg.host || '')}" placeholder="smtp.example.com"></div>
            <div class="field"><label>Port</label><input id="sm_port" value="${esc(cfg.port || '')}" placeholder="587 / 465"></div>
          </div>
          <div class="detail-grid" style="grid-template-columns:1fr 1fr">
            <label class="rolechk"><input type="checkbox" id="sm_secure" ${cfg.secure ? 'checked' : ''}> Implicit TLS (SSL, port 465)</label>
            <label class="rolechk"><input type="checkbox" id="sm_verify" ${cfg.tlsVerify !== false ? 'checked' : ''}> Verify TLS certificate</label>
          </div>
          <div class="field"><label>Username</label><input id="sm_user" value="${esc(cfg.username || '')}" placeholder="apikey / resend / user@example.com"></div>
          <div class="field"><label><span id="sm_pwlabel">${pw.pwLabel}</span> ${cfg.hasPassword ? '<span class="muted small">(saved — leave blank to keep)</span>' : ''}</label><input id="sm_pw" type="password" placeholder="${cfg.hasPassword ? '••••••••' : ''}"></div>
          <div class="detail-grid" style="grid-template-columns:1fr 1fr">
            <div class="field"><label>From name</label><input id="sm_fromname" value="${esc(cfg.fromName || '')}" placeholder="Upload Doc"></div>
            <div class="field"><label>From email</label><input id="sm_fromemail" type="email" value="${esc(cfg.fromEmail || '')}" placeholder="no-reply@yourorg.com"></div>
          </div>
          <div class="field"><label>Send test email to <span class="muted small">(optional — defaults to the From address)</span></label><input id="sm_testto" type="email" placeholder="you@example.com"></div>
          <div style="display:flex;gap:10px;margin-top:8px">
            <button class="btn" id="sm_save">Save settings</button>
            <button class="btn ghost" id="sm_test">Send test email</button>
          </div>
        </div></div>`;
    const provSel = document.getElementById('sm_provider');
    provSel.onchange = () => {
      const pr = SMTP_PRESETS[provSel.value] || SMTP_PRESETS.custom;
      document.getElementById('sm_host').value = pr.host;
      document.getElementById('sm_port').value = pr.port;
      document.getElementById('sm_secure').checked = pr.secure;
      document.getElementById('sm_user').value = pr.username;
      document.getElementById('sm_pwlabel').textContent = pr.pwLabel;
      document.getElementById('sm_hint').innerHTML = pr.hint;
    };
    document.getElementById('sm_save').onclick = saveSmtp;
    document.getElementById('sm_test').onclick = testSmtp;
  }
  function smtpPayload() {
    return {
      enabled: document.getElementById('sm_enabled').checked,
      provider: val('sm_provider') || document.getElementById('sm_provider').value,
      host: val('sm_host'), port: val('sm_port'),
      secure: document.getElementById('sm_secure').checked,
      tlsVerify: document.getElementById('sm_verify').checked,
      username: val('sm_user'), password: val('sm_pw'),
      fromName: val('sm_fromname'), fromEmail: val('sm_fromemail')
    };
  }
  async function saveSmtp() {
    const r = await api('PUT', '/api/admin/smtp', smtpPayload());
    if (r.status === 200) toast('Email settings saved');
    else toast('Save failed', (r.data && r.data.message) || '', 'err');
  }
  async function testSmtp() {
    const el = document.getElementById('smtpAlert');
    el.innerHTML = '<div class="alert info"><span class="spin" style="border-color:rgba(20,102,184,.3);border-top-color:var(--blue-600)"></span> Sending test email…</div>';
    const r = await api('POST', '/api/admin/smtp/test', Object.assign(smtpPayload(), { testTo: val('sm_testto') }));
    const d = r.data || {};
    const kind = d.status === 'ok' ? 'ok' : 'err';
    el.innerHTML = `<div class="alert ${kind}"><div><b>${esc(d.code || 'ERROR')}</b> — ${esc(d.reason || 'No response')}</div></div>`;
  }

  /* ------ Documents (catalog) ------ */
  const EXPIRY_LABEL = { expires: 'Expires (renew by date)', annual: 'Annual review', none: 'No expiry' };
  const FIELD_TYPES = ['text', 'textarea', 'date', 'number', 'email', 'phone', 'select', 'upload'];
  const FIELD_TYPE_LABEL = { text: 'Text', textarea: 'Long text', date: 'Date', number: 'Number', email: 'Email', phone: 'Phone', select: 'Dropdown', upload: 'Document upload' };
  async function adminCatalog(body, opts) {
    opts = opts || {};
    const base = opts.base || '/api/admin/catalog';
    const title = opts.title || 'Documents';
    const audience = opts.audience || 'provider';
    body.innerHTML = '<div class="muted">Loading…</div>';
    const c = await api('GET', base);
    const cat = (c.data.catalog) || { sections: [] };
    const sections = cat.sections.map(s => {
      const items = s.items.map(it => {
        const expCls = it.expiry === 'expires' ? 'b-attention' : (it.expiry === 'annual' ? 'b-review' : 'b-missing');
        return `<div class="item cat-item" draggable="true" data-item-key="${esc(it.key)}" style="cursor:default">
          <span class="grip" title="Drag to reorder this document">${ICON.grip}</span>
          <div class="fic">${ICON.doc2}</div>
          <div class="dinfo"><div class="dt">${esc(it.name)}</div><div class="ds">${esc(it.hint || '')} <span class="chip gray">${esc(it.type)}</span></div></div>
          <div class="dact"><span class="badge ${expCls}">${esc(EXPIRY_LABEL[it.expiry] || it.expiry)}${it.expiryDate ? ' · ' + esc(it.expiryDate) : ''}</span>
            <button class="btn subtle sm" data-edit-item="${esc(it.key)}">Edit</button>
            <button class="btn ghost sm" data-del-item="${esc(it.key)}">Delete</button></div>
        </div>`;
      }).join('');
      return `<div class="cat-section" draggable="true" data-section-id="${s.id}"><div class="card" style="margin-bottom:14px"><div class="card-h">
          <span class="grip grip-sec" title="Drag to reorder this section">${ICON.grip}</span>
          <h3 style="flex:1">${esc(s.title)}</h3>
          <div class="dact"><button class="btn sm" data-add-item="${s.id}">+ Document</button><button class="btn ghost sm" data-del-section="${s.id}">Delete section</button></div>
        </div><div class="card-b cat-items" data-items-for="${s.id}">${items || '<div class="muted small">No documents in this section yet.</div>'}</div></div></div>`;
    }).join('');
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:10px;flex-wrap:wrap">
        <div class="muted small">${cat.sections.length} sections · ${cat.sections.reduce((n, s) => n + s.items.length, 0)} documents. Drag the ${'\u2807'} handles to reorder — changes apply to every ${audience}'s checklist.</div>
        <button class="btn sm" id="cat_add_section">+ New section</button>
      </div><div id="cat_sections">${sections}</div>`;
    document.getElementById('cat_add_section').onclick = () => {
      modal('New section', `<div class="field"><label>Section title</label><input id="sec_title" placeholder="e.g. Background Checks"></div>`, async (close) => {
        const r = await api('POST', `${base}/sections`, { title: val('sec_title') });
        if (r.status === 201) { toast('Section added'); close(); adminCatalog(body, opts); }
        else toast('Failed', (r.data && r.data.message) || '', 'err');
      }, 'Add section');
    };
    body.querySelectorAll('[data-del-section]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this section and all its documents from the catalog?')) return;
      const r = await api('DELETE', `${base}/sections/${b.dataset.delSection}`);
      if (r.status === 200) { toast('Section deleted'); adminCatalog(body, opts); } else toast('Failed', (r.data && r.data.message) || '', 'err');
    });
    body.querySelectorAll('[data-add-item]').forEach(b => b.onclick = () => itemModal(b.dataset.addItem, null, body, opts));
    body.querySelectorAll('[data-edit-item]').forEach(b => b.onclick = () => {
      let it = null; cat.sections.forEach(s => { const f = s.items.find(x => x.key === b.dataset.editItem); if (f) it = f; });
      itemModal(null, it, body, opts);
    });
    body.querySelectorAll('[data-del-item]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this document from the catalog?')) return;
      const r = await api('DELETE', `${base}/items/${b.dataset.delItem}`);
      if (r.status === 200) { toast('Document deleted'); adminCatalog(body, opts); } else toast('Failed', (r.data && r.data.message) || '', 'err');
    });
    wireCatalogDnD(body, opts);
  }
  // Position (before which sibling) a dragged element should drop, based on cursor Y.
  function dragAfterElement(container, y, selector) {
    const els = [...container.querySelectorAll(selector + ':not(.dragging)')];
    let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    for (const child of els) {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
    }
    return closest.element;
  }
  // Drag-and-drop reordering for catalog sections and the documents within them.
  function wireCatalogDnD(body, opts) {
    opts = opts || {};
    const base = opts.base || '/api/admin/catalog';
    // Sections
    const secWrap = body.querySelector('#cat_sections');
    let dragSec = null;
    body.querySelectorAll('.cat-section').forEach(el => {
      el.addEventListener('dragstart', e => {
        // Only start a section drag when the section grip is the source, not an item.
        if (e.target.closest('.cat-item')) return;
        dragSec = el; el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', el.dataset.sectionId); } catch (_) {}
      });
      el.addEventListener('dragend', () => {
        if (!dragSec) return;
        dragSec.classList.remove('dragging'); dragSec = null;
        const order = [...secWrap.querySelectorAll('.cat-section')].map(x => x.dataset.sectionId);
        api('PATCH', `${base}/sections/reorder`, { order }).then(r => {
          if (r.status !== 200) { toast('Reorder failed', '', 'err'); adminCatalog(body, opts); }
          else toast('Sections reordered');
        });
      });
    });
    if (secWrap) secWrap.addEventListener('dragover', e => {
      if (!dragSec) return;
      e.preventDefault();
      const after = dragAfterElement(secWrap, e.clientY, '.cat-section');
      if (after == null) secWrap.appendChild(dragSec);
      else secWrap.insertBefore(dragSec, after);
    });
    // Documents within each section
    body.querySelectorAll('.cat-items').forEach(container => {
      let dragItem = null;
      container.querySelectorAll('.cat-item').forEach(el => {
        el.addEventListener('dragstart', e => {
          e.stopPropagation();
          dragItem = el; el.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', el.dataset.itemKey); } catch (_) {}
        });
        el.addEventListener('dragend', e => {
          e.stopPropagation();
          if (!dragItem) return;
          dragItem.classList.remove('dragging'); dragItem = null;
          const order = [...container.querySelectorAll('.cat-item')].map(x => x.dataset.itemKey);
          api('PATCH', `${base}/sections/${container.dataset.itemsFor}/items/reorder`, { order }).then(r => {
            if (r.status !== 200) { toast('Reorder failed', '', 'err'); adminCatalog(body, opts); }
            else toast('Documents reordered');
          });
        });
      });
      container.addEventListener('dragover', e => {
        if (!dragItem) return;
        e.preventDefault(); e.stopPropagation();
        const after = dragAfterElement(container, e.clientY, '.cat-item');
        if (after == null) container.appendChild(dragItem);
        else container.insertBefore(dragItem, after);
      });
    });
  }
  function itemModal(sectionId, item, body, opts) {
    opts = opts || {};
    const base = opts.base || '/api/admin/catalog';
    const typeOpts = ['doc', 'info', 'access'].map(t => `<option value="${t}" ${item && item.type === t ? 'selected' : ''}>${t}</option>`).join('');
    const expOpts = Object.keys(EXPIRY_LABEL).map(e => `<option value="${e}" ${item && item.expiry === e ? 'selected' : ''}>${EXPIRY_LABEL[e]}</option>`).join('');
    modal(item ? `Edit document — ${esc(item.name)}` : 'New document', `
      <div class="field"><label>Name</label><input id="it_name" value="${item ? esc(item.name) : ''}" placeholder="e.g. Michigan License"></div>
      <div class="field"><label>Hint / description <span class="muted small">(optional)</span></label><input id="it_hint" value="${item ? esc(item.hint || '') : ''}" placeholder="Short note shown to the provider"></div>
      <div class="detail-grid" style="grid-template-columns:1fr 1fr;gap:14px">
        <div class="field"><label>Type</label><select id="it_type">${typeOpts}</select></div>
        <div class="field"><label>Expiry behaviour</label><select id="it_expiry">${expOpts}</select></div>
      </div>
      <div class="field"><label>Default expiry date <span class="muted small">(optional; for licenses that share a fixed date)</span></label>
        <input type="hidden" id="it_expdate" value="${item && item.expiryDate ? esc(item.expiryDate) : ''}">
        <button type="button" class="btn subtle" id="it_expdate_btn">${item && item.expiryDate ? esc(item.expiryDate) : 'Set date'}</button></div>
      <div class="field" style="margin-bottom:0"><label>Input fields <span class="muted small">(info the provider types in — e.g. Name, Date of Birth, Address)</span></label>
        <div class="item-fields">
          <div id="it_fields_list"></div>
          <button type="button" class="btn subtle sm" id="it_add_field">+ Add a field</button>
        </div></div>`,
      async (close) => {
        const fields = [...document.querySelectorAll('#it_fields_list .ff-row')].map(r => ({
          label: r.querySelector('.ff-label').value.trim(),
          type: r.querySelector('.ff-type').value,
          options: r.querySelector('.ff-opts').value
        })).filter(f => f.label);
        const payload = { name: val('it_name'), hint: val('it_hint'), type: val('it_type') || document.getElementById('it_type').value, expiry: document.getElementById('it_expiry').value, expiryDate: val('it_expdate'), fields };
        let r;
        if (item) r = await api('PATCH', `${base}/items/${item.key}`, payload);
        else r = await api('POST', `${base}/sections/${sectionId}/items`, payload);
        if (r.status < 300) { toast(item ? 'Document updated' : 'Document added'); close(); adminCatalog(body, opts); }
        else toast('Failed', (r.data && r.data.message) || '', 'err');
      }, item ? 'Save document' : 'Add document');
    // Wire the stylized date picker (shared from portal.js) for the default expiry date.
    const _eb = document.getElementById('it_expdate_btn');
    if (_eb && window.openCalendar) _eb.onclick = () => window.openCalendar({
      title: 'Default expiry date', selectedLabel: 'Expiry date',
      value: document.getElementById('it_expdate').value || '', confirmLabel: 'Save date', allowClear: true,
      onConfirm: (iso) => { document.getElementById('it_expdate').value = iso || ''; _eb.textContent = iso || 'Set date'; }
    });
    // Custom input-field editor: add/name/type/remove rows.
    const fieldsList = document.getElementById('it_fields_list');
    const typeOptsFor = (sel) => FIELD_TYPES.map(t => `<option value="${t}" ${t === sel ? 'selected' : ''}>${FIELD_TYPE_LABEL[t] || t}</option>`).join('');
    function addFieldRow(f) {
      f = f || { label: '', type: 'text', options: [] };
      const row = document.createElement('div');
      row.className = 'ff-row';
      row.innerHTML = `
        <input class="ff-label" placeholder="Field name (e.g. Date of Birth)" value="${esc(f.label || '')}">
        <select class="ff-type">${typeOptsFor(f.type)}</select>
        <input class="ff-opts" placeholder="Options, comma separated" value="${esc((f.options || []).join(', '))}"${f.type === 'select' ? '' : ' style="display:none"'}>
        <button type="button" class="btn ghost sm ff-remove" aria-label="Remove field">✕</button>`;
      const typeEl = row.querySelector('.ff-type'), optsEl = row.querySelector('.ff-opts');
      typeEl.onchange = () => { optsEl.style.display = typeEl.value === 'select' ? '' : 'none'; };
      row.querySelector('.ff-remove').onclick = () => row.remove();
      fieldsList.appendChild(row);
    }
    (item && Array.isArray(item.fields) ? item.fields : []).forEach(addFieldRow);
    document.getElementById('it_add_field').onclick = () => addFieldRow();
  }

  /* ------ Audit ------ */
  async function adminAudit(body) {
    body.innerHTML = '<div class="muted">Loading…</div>';
    const r = await api('GET', '/api/admin/audit');
    const ev = r.data.events || [];
    const rows = ev.map(e => `<div class="audit-row">
      <div><div class="a-act">${esc(e.action)}</div><div class="a-ts">${esc(new Date(e.ts).toLocaleString())}</div></div>
      <div class="small">${esc(e.actorLabel || e.actorId || '—')}${e.provider ? '<div class="muted mono">' + esc(e.provider) + '</div>' : ''}</div>
      <div class="small">${e.targetLabel ? '→ ' + esc(e.targetLabel) : ''} ${e.reason ? '<span class="chip gray">' + esc(e.reason) + '</span>' : ''} <span class="badge ${e.outcome === 'ok' ? 'b-approved' : (e.outcome === 'denied' || e.outcome === 'fail' || e.outcome === 'blocked' ? 'b-attention' : 'b-pending')}">${esc(e.outcome || '')}</span><div class="muted mono">${esc(e.ip || '')}</div></div>
    </div>`).join('');
    body.innerHTML = `<div class="card"><div class="card-h"><h3>Audit log</h3><span class="muted small">${ev.length} most recent events</span></div>
      <div class="card-b">${rows || '<div class="muted">No events.</div>'}</div></div>`;
  }

  /* ------ 3rd Party Login (login audit: user + last login, newest first) ------ */
  async function adminThirdParty(body) {
    body.innerHTML = '<div class="muted">Loading…</div>';
    const u = await api('GET', '/api/admin/users');
    const all = (u.data.users || []).filter(us => !us.isTeam).slice().sort((a, b) => {
      const ta = a.lastLoginAt ? Date.parse(a.lastLoginAt) : -Infinity;
      const tb = b.lastLoginAt ? Date.parse(b.lastLoginAt) : -Infinity;
      return tb - ta;
    });
    body.innerHTML = `<div class="card">
      <div class="card-h"><h3>3rd Party Login</h3><span class="muted small">Login audit — most recent first</span></div>
      <div class="card-b" style="padding:6px 8px">
        <div class="field" style="margin:6px 6px 10px"><input id="tpl_search" placeholder="Search by name, username or email…" autocomplete="off"></div>
        <table class="roster">
          <thead><tr><th>User</th><th>Source</th><th>Last login</th></tr></thead>
          <tbody id="tpl_rows"></tbody></table>
      </div></div>`;
    const input = document.getElementById('tpl_search');
    const tbody = document.getElementById('tpl_rows');
    function draw() {
      const q = (input.value || '').trim().toLowerCase();
      const list = all.filter(us => !q
        || (us.displayName || '').toLowerCase().includes(q)
        || (us.username || '').toLowerCase().includes(q)
        || (us.email || '').toLowerCase().includes(q));
      tbody.innerHTML = list.map(us => `<tr>
        <td><div class="who"><div class="avatar">${esc((us.displayName || us.username).split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase())}</div>
          <div><div class="nm">${esc(us.displayName || us.username)}</div><div class="sp">${esc(us.username)}${us.email ? ' · ' + esc(us.email) : ''}</div></div></div></td>
        <td class="small"><span class="chip gray">${esc(us.provider)}</span></td>
        <td class="small">${fmtLastLogin(us.lastLoginAt)}</td>
      </tr>`).join('') || '<tr><td colspan="3" class="muted" style="padding:14px">No matching users.</td></tr>';
    }
    input.oninput = draw;
    draw();
  }

  /* ----------------------------- modal --------------------------------- */
  function modal(title, inner, onSave, saveLabel) {
    const mr = document.getElementById('modalRoot');
    mr.innerHTML = `<div class="modal-bg" data-mbg><div class="modal" style="max-width:520px;max-height:88vh;display:flex;flex-direction:column">
      <div class="m-h"><h3 style="font-size:16px;flex:1">${esc(title)}</h3><button class="xbtn" data-mclose>✕</button></div>
      <div class="m-b" style="overflow:auto">${inner}</div>
      <div class="m-f"><button class="btn subtle" data-mclose>Cancel</button><button class="btn" data-msave>${esc(saveLabel || 'Save')}</button></div>
    </div></div>`;
    const close = () => { mr.innerHTML = ''; };
    mr.querySelectorAll('[data-mclose]').forEach(b => b.onclick = close);
    mr.querySelector('[data-mbg]').onclick = e => { if (e.target === mr.querySelector('[data-mbg]')) close(); };
    mr.querySelector('[data-msave]').onclick = () => onSave(close);
  }

  function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
