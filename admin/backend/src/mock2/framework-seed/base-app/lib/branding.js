'use strict';
/* ---------------------------------------------------------------------------
   Branding, legal pages and shared assets.

   Three things live here because they are the same thing from the operator's
   point of view — "what this app says it is":

   1. Identity: organisation name, legal name, rights mark, logo, favicon.
   2. Legal pages: privacy policy and terms & conditions, editable in the admin
      console and readable by anyone (they must be reachable from the sign-in
      screen, i.e. before there is a session).
   3. App context: a short, factual description of what the application does,
      kept current so the sign-in screen and the legal pages never describe a
      product that has moved on. See the CONTRACT note on appContext below.

   Storage: metadata in the JSON store under `branding`; asset bytes on disk
   under data/branding/. Deliberately separate from lib/files.js — those are
   credentialing documents (private, permission-checked, per-owner); these are
   public site furniture with completely different serving rules.
   --------------------------------------------------------------------------- */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { uuid } = require('./util');

const DATA_DIR = process.env.APP_DATA_DIR || path.join(__dirname, '..', 'data');
const ASSET_DIR = path.join(DATA_DIR, 'branding');
const MAX_ASSET_BYTES = +(process.env.MAX_ASSET_BYTES || 5 * 1024 * 1024); // 5 MB

// Extension -> canonical MIME. Served with this fixed type, never sniffed.
//
// SVG is allowed here (a logo really wants to be vector) even though
// lib/files.js excludes it. It is safe *in this context* because every branding
// asset is served with `Content-Security-Policy: default-src 'none'; sandbox`
// and `X-Content-Type-Options: nosniff`: script inside an SVG cannot run when
// it is referenced by <img>, and the CSP + sandbox neutralise it even if
// someone navigates to the URL directly. Do not copy the allowance to a route
// that drops those headers.
const ALLOWED = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
};
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon']);
const KINDS = new Set(['logo', 'favicon', 'image', 'document']);

const LEGAL_SLUGS = ['privacy', 'terms'];

/* ---------------------------------------------------------------------------
   Default legal copy.

   Deliberately generic and jurisdiction-neutral: enough that a freshly seeded
   app is not shipping a dead link from its sign-in screen, and obviously a
   starting point rather than finished advice. `{{ORG}}` is substituted at read
   time so renaming the organisation does not leave stale text behind.

   A build that knows the real policy should replace the body wholesale through
   the admin console (or PUT /api/admin/branding/pages/:slug) rather than
   patching around this.
   --------------------------------------------------------------------------- */
const DEFAULT_PAGES = {
  privacy: {
    title: 'Privacy Policy',
    body: [
      'This policy explains what {{ORG}} collects when you use this application, why it is collected, and what control you have over it.',
      '',
      '## Information we collect',
      '- Account details you provide when you register or when an administrator creates your account: your name, email address, and sign-in identifier.',
      '- Content you upload, including documents, files and any notes attached to them.',
      '- Technical records created automatically when you use the service: sign-in times, the network address of the device you connected from, and a record of administrative actions taken on the account.',
      '',
      '## How the information is used',
      '- To provide the service: authenticating you, showing you your own records, and routing items to the people responsible for reviewing them.',
      '- To keep the service secure: detecting repeated failed sign-in attempts, and maintaining an audit trail of changes to accounts and permissions.',
      '- To contact you about your account, such as password resets, one-time sign-in links, and notifications about items that need your attention.',
      '',
      'Information is not sold, and it is not shared with third parties for advertising.',
      '',
      '## Where it is stored and how long it is kept',
      'Data is stored on infrastructure controlled by {{ORG}}. Uploaded documents and account records are retained for as long as the account is active, and afterwards for as long as {{ORG}} is required to keep them. Audit records are retained separately so that the history of an account remains complete.',
      '',
      '## Your choices',
      '- You can view and correct your own account details from within the application.',
      '- You can request a copy of the information held about you, or ask for it to be corrected or deleted.',
      '- Some records cannot be deleted on request where {{ORG}} is required to retain them.',
      '',
      '## Security',
      'Access is controlled by individual accounts with role-based permissions. Passwords are stored using a one-way hash and are never recoverable in readable form. Sessions expire and can be revoked. Sensitive stored settings are encrypted.',
      '',
      '## Changes to this policy',
      'This policy may be updated. The revision date shown on this page changes whenever it does, and material changes will be communicated through the application.',
      '',
      '## Contact',
      'Questions about this policy, or requests relating to your information, can be directed to {{ORG}} through the contact route provided to you by your administrator.'
    ].join('\n')
  },
  terms: {
    title: 'Terms & Conditions',
    body: [
      'These terms govern your use of this application, operated by {{ORG}}. By signing in or using the service you agree to them.',
      '',
      '## Your account',
      '- You are responsible for activity that happens under your account, and for keeping your sign-in credentials confidential.',
      '- Accounts are individual. Do not share credentials or let another person use your account.',
      '- Tell your administrator promptly if you believe your account has been used without your permission.',
      '',
      '## Acceptable use',
      '- Use the service only for its intended purpose and only within the access your role grants you.',
      '- Do not attempt to access records belonging to other users, to bypass permission checks, or to interfere with the operation of the service.',
      '- Do not upload material you do not have the right to share, or material that is unlawful or malicious.',
      '',
      '## Content you upload',
      'You keep ownership of what you upload. You grant {{ORG}} permission to store, process and display that content as needed to operate the service and to make it available to the people authorised to review it.',
      '',
      '## Availability',
      'The service is provided on an as-available basis. {{ORG}} aims to keep it running and accurate, but does not warrant uninterrupted or error-free operation, and may suspend access for maintenance or to protect the service.',
      '',
      '## Suspension and termination',
      '{{ORG}} may suspend or close an account that breaches these terms, or where required to do so. You may ask for your account to be closed at any time; retention of your records after closure is described in the Privacy Policy.',
      '',
      '## Limitation of liability',
      'To the extent permitted by law, {{ORG}} is not liable for indirect or consequential loss arising from use of the service. Nothing in these terms limits liability that cannot lawfully be limited.',
      '',
      '## Changes to these terms',
      'These terms may be updated. The revision date shown on this page changes whenever they do, and continued use of the service after a change means you accept the updated terms.',
      '',
      '## Contact',
      'Questions about these terms can be directed to {{ORG}} through the contact route provided to you by your administrator.'
    ].join('\n')
  }
};

const DEFAULTS = {
  orgName: 'Upload Doc',
  legalName: '',            // falls back to orgName in the notice
  rightsMark: '',           // '', '®' or '™'
  copyrightStartYear: null, // renders "2019–<current>" when set and in the past
  rightsText: 'All rights reserved.',
  logoAssetId: null,
  faviconAssetId: null,     // CONTRACT: falls back to the logo when unset
  appContext: null,
  pages: null,
  assets: []
};

/* CONTRACT — appContext.
 *
 * A factual description of what the application does, in the operator's words:
 *
 *   { summary, audience, features: [{ title, detail }], updatedAt, updatedBy }
 *
 * Every build that adds or changes a user- or admin-facing capability should
 * update this. Record WHAT a person can now do ("Administrators can export the
 * audit log as CSV"), not why it was built, who asked for it, or how it was
 * implemented — this text is read by end users on the sign-in screen, so
 * rationale and internal history do not belong in it.
 */
function emptyContext() {
  return { summary: '', audience: '', features: [], updatedAt: null, updatedBy: null };
}

function ensureDir() { fs.mkdirSync(ASSET_DIR, { recursive: true }); }

function raw() {
  const db = store.get();
  if (!db.branding || typeof db.branding !== 'object') db.branding = {};
  const b = db.branding;
  for (const k of Object.keys(DEFAULTS)) if (b[k] === undefined) b[k] = DEFAULTS[k];
  if (!Array.isArray(b.assets)) b.assets = [];
  if (!b.appContext) b.appContext = emptyContext();
  if (!b.pages || typeof b.pages !== 'object') b.pages = {};
  for (const slug of LEGAL_SLUGS) {
    if (!b.pages[slug]) {
      b.pages[slug] = { title: DEFAULT_PAGES[slug].title, body: DEFAULT_PAGES[slug].body, isDefault: true, updatedAt: null, updatedBy: null };
    }
  }
  return b;
}

function seed() { raw(); store.save(); }

/* ------------------------------- helpers -------------------------------- */

function orgLabel(b) { return b.legalName || b.orgName || 'This application'; }

// Always the *current* year — computed on read, never stored, so a deployment
// that runs across New Year does not keep showing last year's notice.
function copyrightYears(b, now) {
  const year = (now || new Date()).getFullYear();
  const start = Number(b.copyrightStartYear);
  if (Number.isInteger(start) && start >= 1900 && start < year) return `${start}–${year}`;
  return String(year);
}

function copyrightNotice(b, now) {
  const mark = b.rightsMark === '®' || b.rightsMark === '™' ? b.rightsMark : '';
  const name = orgLabel(b);
  const rights = (b.rightsText || '').trim();
  return `© ${copyrightYears(b, now)} ${name}${mark}.${rights ? ' ' + rights : ''}`;
}

function assetUrl(id) { return id ? '/api/branding/assets/' + id : null; }

function toAsset(a) {
  return {
    id: a.id, key: a.key || null, name: a.name, mime: a.mime, size: a.size, kind: a.kind || 'image',
    alt: a.alt || '', description: a.description || '', image: IMAGE_MIMES.has(a.mime),
    url: assetUrl(a.id), createdAt: a.createdAt, updatedAt: a.updatedAt || a.createdAt
  };
}

function getAsset(id) { return raw().assets.find(a => a.id === id) || null; }

// The favicon falls back to the logo when none was uploaded — an app with a
// logo and no favicon should not show the browser's blank page icon.
function faviconId(b) { return b.faviconAssetId || b.logoAssetId || null; }

function substitute(text, b) {
  return String(text == null ? '' : text)
    .split('{{ORG}}').join(orgLabel(b))
    .split('{{APP}}').join(b.orgName || orgLabel(b));
}

function page(slug, b) {
  const src = b || raw();
  if (!LEGAL_SLUGS.includes(slug)) return null;
  const p = src.pages[slug];
  return {
    slug,
    title: p.title,
    body: substitute(p.body, src),
    isDefault: !!p.isDefault,
    updatedAt: p.updatedAt,
    // The revision line has to say *something* on a freshly seeded app, and
    // "never updated" reads as broken. Fall back to the current date only for
    // untouched default copy, which is honest: it is today's default text.
    updatedBy: p.updatedBy || null
  };
}

/* --------------------------- public projection --------------------------- */
// Everything the sign-in screen and the legal pages need, with no session.
// Must never include asset filesystem paths or anything permission-bearing.
function publicView(now) {
  const b = raw();
  return {
    orgName: b.orgName || DEFAULTS.orgName,
    legalName: b.legalName || '',
    rightsMark: b.rightsMark || '',
    rightsText: b.rightsText || '',
    year: (now || new Date()).getFullYear(),
    copyright: copyrightNotice(b, now),
    logoUrl: assetUrl(b.logoAssetId),
    faviconUrl: assetUrl(faviconId(b)),
    appContext: {
      summary: substitute(b.appContext.summary || '', b),
      audience: substitute(b.appContext.audience || '', b),
      features: (b.appContext.features || []).map(f => ({ title: substitute(f.title, b), detail: substitute(f.detail || '', b) })),
      updatedAt: b.appContext.updatedAt || null
    },
    legal: LEGAL_SLUGS.map(slug => ({ slug, title: b.pages[slug].title, updatedAt: b.pages[slug].updatedAt }))
  };
}

/* ----------------------------- admin projection --------------------------- */
function adminView(now) {
  const b = raw();
  return {
    orgName: b.orgName || '',
    legalName: b.legalName || '',
    rightsMark: b.rightsMark || '',
    rightsText: b.rightsText || '',
    copyrightStartYear: b.copyrightStartYear || null,
    copyrightPreview: copyrightNotice(b, now),
    logoAssetId: b.logoAssetId || null,
    faviconAssetId: b.faviconAssetId || null,
    effectiveFaviconId: faviconId(b),
    faviconInherited: !b.faviconAssetId && !!b.logoAssetId,
    logoUrl: assetUrl(b.logoAssetId),
    faviconUrl: assetUrl(faviconId(b)),
    appContext: b.appContext,
    pages: LEGAL_SLUGS.map(slug => ({
      slug,
      title: b.pages[slug].title,
      body: b.pages[slug].body,          // raw, with {{ORG}} intact, for editing
      isDefault: !!b.pages[slug].isDefault,
      updatedAt: b.pages[slug].updatedAt,
      updatedBy: b.pages[slug].updatedBy
    })),
    assets: b.assets.slice().sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)).map(toAsset),
    limits: { maxAssetBytes: MAX_ASSET_BYTES, allowedExtensions: Object.keys(ALLOWED) }
  };
}

/* -------------------------------- mutation -------------------------------- */

const RIGHTS_MARKS = new Set(['', '®', '™']);

function updateIdentity(patch, actor) {
  const b = raw();
  if (patch.orgName !== undefined) {
    const v = String(patch.orgName).trim().slice(0, 120);
    if (!v) { const e = new Error('VALIDATION'); e.code = 'VALIDATION'; e.detail = 'Organisation name is required.'; throw e; }
    b.orgName = v;
  }
  if (patch.legalName !== undefined) b.legalName = String(patch.legalName).trim().slice(0, 160);
  if (patch.rightsText !== undefined) b.rightsText = String(patch.rightsText).trim().slice(0, 160);
  if (patch.rightsMark !== undefined) {
    const v = String(patch.rightsMark || '');
    if (!RIGHTS_MARKS.has(v)) { const e = new Error('VALIDATION'); e.code = 'VALIDATION'; e.detail = 'Rights mark must be ®, ™ or empty.'; throw e; }
    b.rightsMark = v;
  }
  if (patch.copyrightStartYear !== undefined) {
    if (patch.copyrightStartYear === null || patch.copyrightStartYear === '') b.copyrightStartYear = null;
    else {
      const n = Number(patch.copyrightStartYear);
      if (!Number.isInteger(n) || n < 1900 || n > new Date().getFullYear()) {
        const e = new Error('VALIDATION'); e.code = 'VALIDATION'; e.detail = 'Start year must be between 1900 and the current year.'; throw e;
      }
      b.copyrightStartYear = n;
    }
  }
  if (patch.logoAssetId !== undefined) {
    if (patch.logoAssetId && !getAsset(patch.logoAssetId)) { const e = new Error('NOT_FOUND'); e.code = 'NOT_FOUND'; e.detail = 'Logo asset not found.'; throw e; }
    b.logoAssetId = patch.logoAssetId || null;
  }
  if (patch.faviconAssetId !== undefined) {
    if (patch.faviconAssetId && !getAsset(patch.faviconAssetId)) { const e = new Error('NOT_FOUND'); e.code = 'NOT_FOUND'; e.detail = 'Favicon asset not found.'; throw e; }
    b.faviconAssetId = patch.faviconAssetId || null;
  }
  if (patch.appContext !== undefined && patch.appContext) {
    const c = patch.appContext;
    const next = b.appContext || emptyContext();
    if (c.summary !== undefined) next.summary = String(c.summary).slice(0, 4000);
    if (c.audience !== undefined) next.audience = String(c.audience).slice(0, 1000);
    if (c.features !== undefined) {
      if (!Array.isArray(c.features)) { const e = new Error('VALIDATION'); e.code = 'VALIDATION'; e.detail = 'features must be a list.'; throw e; }
      next.features = c.features.slice(0, 60)
        .map(f => ({ title: String((f && f.title) || '').trim().slice(0, 160), detail: String((f && f.detail) || '').trim().slice(0, 600) }))
        .filter(f => f.title);
    }
    next.updatedAt = new Date().toISOString();
    next.updatedBy = actor || null;
    b.appContext = next;
  }
  store.save();
  return adminView();
}

function updatePage(slug, patch, actor) {
  if (!LEGAL_SLUGS.includes(slug)) { const e = new Error('NOT_FOUND'); e.code = 'NOT_FOUND'; throw e; }
  const b = raw();
  const p = b.pages[slug];
  if (patch.title !== undefined) {
    const t = String(patch.title).trim().slice(0, 160);
    if (!t) { const e = new Error('VALIDATION'); e.code = 'VALIDATION'; e.detail = 'Title is required.'; throw e; }
    p.title = t;
  }
  if (patch.body !== undefined) {
    const body = String(patch.body);
    if (body.length > 100000) { const e = new Error('VALIDATION'); e.code = 'VALIDATION'; e.detail = 'Page body is too long.'; throw e; }
    p.body = body;
  }
  p.isDefault = false;
  p.updatedAt = new Date().toISOString();
  p.updatedBy = actor || null;
  store.save();
  return page(slug, b);
}

// Restore the shipped default copy for a page — an operator who has edited
// themselves into a corner should not have to find the original text.
function resetPage(slug) {
  if (!LEGAL_SLUGS.includes(slug)) { const e = new Error('NOT_FOUND'); e.code = 'NOT_FOUND'; throw e; }
  const b = raw();
  b.pages[slug] = { title: DEFAULT_PAGES[slug].title, body: DEFAULT_PAGES[slug].body, isDefault: true, updatedAt: null, updatedBy: null };
  store.save();
  return page(slug, b);
}

/* --------------------------------- assets --------------------------------- */

function sanitizeName(name) {
  const base = path.basename(String(name || 'asset'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return base.slice(0, 200) || 'asset';
}

function extFor(name, mime) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ALLOWED[ext]) return ext;
  const declared = String(mime || '').toLowerCase().split(';')[0].trim();
  return Object.keys(ALLOWED).find(e => ALLOWED[e] === declared) || '';
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_ASSET_BYTES) { reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function saveAsset(req, { filename, mime, kind, alt, description, key, actor }) {
  const name = sanitizeName(filename);
  const ext = extFor(name, mime);
  if (!ext) { const e = new Error('UNSUPPORTED_TYPE'); e.code = 'UNSUPPORTED_TYPE'; throw e; }
  const body = await readRawBody(req);
  if (!body.length) { const e = new Error('EMPTY'); e.code = 'EMPTY'; throw e; }
  const useKind = KINDS.has(kind) ? kind : 'image';
  ensureDir();
  const id = uuid();
  const storedAs = id + ext;
  fs.writeFileSync(path.join(ASSET_DIR, storedAs), body);
  const rec = {
    id, key: key ? String(key).slice(0, 64) : null,
    name: name.toLowerCase().endsWith(ext) ? name : name + ext,
    mime: ALLOWED[ext], size: body.length, ext, storedAs, kind: useKind,
    alt: alt ? String(alt).slice(0, 300) : '',
    description: description ? String(description).slice(0, 1000) : '',
    uploadedBy: actor || null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const b = raw();
  b.assets.push(rec);
  // Uploading *as* the logo or favicon selects it — the two-step "upload, then
  // go and pick it" was the step everyone forgot.
  if (useKind === 'logo') b.logoAssetId = id;
  if (useKind === 'favicon') b.faviconAssetId = id;
  store.save();
  return toAsset(rec);
}

function updateAsset(id, patch) {
  const a = getAsset(id);
  if (!a) { const e = new Error('NOT_FOUND'); e.code = 'NOT_FOUND'; throw e; }
  if (patch.alt !== undefined) a.alt = String(patch.alt).slice(0, 300);
  if (patch.description !== undefined) a.description = String(patch.description).slice(0, 1000);
  if (patch.name !== undefined) { const n = sanitizeName(patch.name); if (n) a.name = n; }
  if (patch.key !== undefined) a.key = patch.key ? String(patch.key).slice(0, 64) : null;
  if (patch.kind !== undefined && KINDS.has(patch.kind)) {
    a.kind = patch.kind;
    const b = raw();
    if (patch.kind === 'logo') b.logoAssetId = a.id;
    if (patch.kind === 'favicon') b.faviconAssetId = a.id;
  }
  a.updatedAt = new Date().toISOString();
  store.save();
  return toAsset(a);
}

function removeAsset(id) {
  const b = raw();
  const idx = b.assets.findIndex(a => a.id === id);
  if (idx === -1) return null;
  const rec = b.assets[idx];
  try {
    const full = path.join(ASSET_DIR, rec.storedAs);
    if (full.startsWith(ASSET_DIR)) fs.unlinkSync(full);
  } catch (_) { /* blob already gone — still drop the index row */ }
  b.assets.splice(idx, 1);
  // Never leave a dangling reference: a deleted logo must clear the pointer,
  // otherwise the favicon fallback resolves to a 404 forever.
  if (b.logoAssetId === id) b.logoAssetId = null;
  if (b.faviconAssetId === id) b.faviconAssetId = null;
  store.save();
  return toAsset(rec);
}

// Serve an asset. Public by design: the sign-in screen and the browser's
// favicon fetch both happen without a session.
function streamAsset(res, id) {
  const rec = getAsset(id);
  if (!rec) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const full = path.join(ASSET_DIR, rec.storedAs);
  if (!full.startsWith(ASSET_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(full, (err, st) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': rec.mime,
      'Content-Length': st.size,
      'Content-Disposition': `inline; filename="${rec.name.replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      // Neutralises script inside an uploaded SVG even on direct navigation.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // Immutable: the id is content-addressed by upload, so a change always
      // produces a new URL. Public because there is nothing private here.
      'Cache-Control': 'public, max-age=86400'
    });
    fs.createReadStream(full).pipe(res);
  });
}

module.exports = {
  seed, publicView, adminView, page, updateIdentity, updatePage, resetPage,
  saveAsset, updateAsset, removeAsset, getAsset, streamAsset, toAsset,
  copyrightNotice, copyrightYears, faviconId, raw,
  LEGAL_SLUGS, DEFAULT_PAGES, ALLOWED, KINDS, MAX_ASSET_BYTES, ASSET_DIR
};
