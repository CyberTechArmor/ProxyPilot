// Mock2 runtime scaffold — the PLATFORM module.
//
// Everything here is part of the base app EVERY project is provisioned with,
// alongside the auth component. It is the set of capabilities that are true of
// any real application regardless of what it is for:
//
//   1. Identity      — organisation name, logo, favicon, shared assets.
//   2. Legal         — editable Privacy / Terms pages, reachable signed-out,
//                      with a copyright notice that is always the current year.
//   3. App context   — a short factual description of what the app does, which
//                      each build is expected to keep current.
//   4. Machine API   — API keys carrying the SAME permissions people hold, so
//                      other applications can use this one.
//   5. Read-only SQL — a SELECT-only credential over curated views, for the
//                      questions that are far cheaper as a join than as N+1
//                      API calls.
//
// Written in the project's own stack (TypeScript strict, Express, Drizzle, Zod)
// because the constitution, the gate battery and the build skills all assume it.
// A separate CommonJS reference implementation of the same capabilities lives in
// framework-seed/base-app/ and is NOT what gets installed.
//
// PURE (stub-first, risk R9): returns [{ path, content }]. No I/O, no native
// modules. Terminology (risk R7): nothing here is named "agent".

export const PLATFORM_MODULE_VERSION = 'mock2-platform-v6';

/* ---------------------------------------------------------------------------
   Drizzle schema. Registered by src/db/index.ts alongside the app's own tables.
   --------------------------------------------------------------------------- */
import {
  pushSchemaTs, pushMigrationSql, pushTs, pushClientJs, pushAdminMarkup, PUSH_CSS,
} from './scaffold-push.js';

function platformSchemaTs() {
  return `import { pgTable, text, boolean, integer, bigint, jsonb, serial, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Platform tables — identity, legal copy, shared assets, machine credentials.
// Drizzle is the only data-access path (constitution §2); migrations/ holds the
// matching SQL.
// ---------------------------------------------------------------------------

// Singleton row (id = 1). A table rather than a config file because an operator
// edits this at runtime and it has to survive a redeploy.
export const branding = pgTable('branding', {
  id: integer('id').primaryKey().default(1),
  orgName: text('org_name').notNull().default('Application'),
  legalName: text('legal_name').notNull().default(''),
  rightsMark: text('rights_mark').notNull().default(''),      // '', '®' or '™'
  rightsText: text('rights_text').notNull().default('All rights reserved.'),
  copyrightStartYear: integer('copyright_start_year'),
  logoAssetId: text('logo_asset_id'),
  faviconAssetId: text('favicon_asset_id'),
  // { summary, audience, features: [{title, detail}] } — see the CONTRACT note
  // in platform/branding.ts.
  appContext: jsonb('app_context').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const legalPages = pgTable('legal_pages', {
  slug: text('slug').primaryKey(),          // 'privacy' | 'terms'
  title: text('title').notNull(),
  body: text('body').notNull(),
  isDefault: boolean('is_default').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  updatedBy: text('updated_by'),
});

export const assets = pgTable('assets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  kind: text('kind').notNull().default('image'),   // logo | favicon | image | document
  alt: text('alt').notNull().default(''),
  // Bytes live in the row. These are a handful of small brand assets, and a
  // volume mount is one more thing to get wrong on a redeploy; documents at
  // scale belong in object storage, not here.
  data: text('data').notNull(),                    // base64
  uploadedBy: text('uploaded_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // The public half of the token: indexes the row so verification is one
  // lookup rather than hashing the candidate against every row.
  prefix: text('prefix').notNull(),
  // SHA-256 of the secret half. Cleared on revoke, so a revoked row carries no
  // material that could be re-activated by flipping a boolean.
  tokenHash: text('token_hash'),
  userId: integer('user_id'),
  permissions: jsonb('permissions').notNull().default([]),
  active: boolean('active').notNull().default(true),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  prefixKey: uniqueIndex('api_keys_prefix_key').on(t.prefix),
  activeIdx: index('api_keys_active_idx').on(t.active),
}));

export const auditLog = pgTable('platform_audit', {
  id: serial('id').primaryKey(),
  action: text('action').notNull(),
  actorLabel: text('actor_label'),
  targetLabel: text('target_label'),
  outcome: text('outcome'),
  meta: jsonb('meta'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  createdIdx: index('platform_audit_created_idx').on(t.createdAt),
}));
` + pushSchemaTs();
}

/* ---------------------------------------------------------------------------
   Branding + legal service.
   --------------------------------------------------------------------------- */
function brandingTs() {
  return `import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { branding, legalPages, assets } from './schema.js';

/* CONTRACT — appContext.
 *
 * A factual description of what this application does:
 *
 *   { summary, audience, features: [{ title, detail }] }
 *
 * EVERY BUILD that adds or changes a user- or admin-facing capability should
 * update it (Admin → Branding → About this app, or PUT /api/admin/branding).
 * Record WHAT a person can now do — "Administrators can export the audit log as
 * CSV" — not why it was built, who asked for it, or how it was implemented.
 * End users read this on the sign-in screen; rationale does not belong in it.
 */
export interface AppContext {
  summary: string;
  audience: string;
  features: { title: string; detail: string }[];
  updatedAt?: string | null;
}

export const LEGAL_SLUGS = ['privacy', 'terms'] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

// Generic, jurisdiction-neutral starting copy, so a freshly provisioned app is
// never serving a dead link from its sign-in screen. {{ORG}} is substituted at
// READ time, so renaming the organisation updates the text with it.
export const DEFAULT_PAGES: Record<LegalSlug, { title: string; body: string }> = {
  privacy: {
    title: 'Privacy Policy',
    body: [
      'This policy explains what {{ORG}} collects when you use this application, why it is collected, and what control you have over it.',
      '',
      '## Information we collect',
      '- Account details you provide, or that an administrator creates for you: your name, email address, and sign-in identifier.',
      '- Content you create or upload while using the service.',
      '- Technical records created automatically: sign-in times, the network address you connected from, and a record of administrative actions.',
      '',
      '## How the information is used',
      '- To provide the service: authenticating you and showing you the records you are entitled to see.',
      '- To keep the service secure: detecting repeated failed sign-in attempts and maintaining an audit trail.',
      '- To contact you about your account, such as password resets and sign-in links.',
      '',
      'Information is not sold, and is not shared with third parties for advertising.',
      '',
      '## Retention',
      'Records are retained for as long as the account is active, and afterwards for as long as {{ORG}} is required to keep them.',
      '',
      '## Your choices',
      '- You can view and correct your own account details in the application.',
      '- You can request a copy of the information held about you, or ask for it to be corrected or deleted.',
      '- Some records cannot be deleted on request where {{ORG}} is required to retain them.',
      '',
      '## Security',
      'Access is controlled by individual accounts with role-based permissions. Passwords are stored using a one-way hash and are never recoverable. Sessions expire and can be revoked.',
      '',
      '## Changes',
      'This policy may be updated. The revision date on this page changes whenever it does.',
      '',
      '## Contact',
      'Questions can be directed to {{ORG}} through the contact route provided by your administrator.',
    ].join('\\n'),
  },
  terms: {
    title: 'Terms & Conditions',
    body: [
      'These terms govern your use of this application, operated by {{ORG}}. By signing in you agree to them.',
      '',
      '## Your account',
      '- You are responsible for activity under your account and for keeping your credentials confidential.',
      '- Accounts are individual. Do not share credentials.',
      '- Tell your administrator promptly if you believe your account has been used without permission.',
      '',
      '## Acceptable use',
      '- Use the service only for its intended purpose and within the access your role grants.',
      '- Do not attempt to reach records belonging to others, bypass permission checks, or interfere with the service.',
      '- Do not upload material you do not have the right to share, or that is unlawful or malicious.',
      '',
      '## Content you provide',
      'You keep ownership of what you upload. You grant {{ORG}} permission to store, process and display it as needed to operate the service.',
      '',
      '## Availability',
      'The service is provided on an as-available basis. {{ORG}} does not warrant uninterrupted or error-free operation and may suspend access for maintenance.',
      '',
      '## Suspension and termination',
      '{{ORG}} may suspend or close an account that breaches these terms. You may ask for your account to be closed at any time.',
      '',
      '## Limitation of liability',
      'To the extent permitted by law, {{ORG}} is not liable for indirect or consequential loss arising from use of the service.',
      '',
      '## Changes',
      'These terms may be updated. Continued use after a change means you accept the updated terms.',
      '',
      '## Contact',
      'Questions can be directed to {{ORG}} through the contact route provided by your administrator.',
    ].join('\\n'),
  },
};

const EMPTY_CONTEXT: AppContext = { summary: '', audience: '', features: [], updatedAt: null };

export async function ensureSeeded(): Promise<void> {
  const rows = await db.select().from(branding).where(eq(branding.id, 1));
  if (!rows.length) await db.insert(branding).values({ id: 1 }).onConflictDoNothing();
  for (const slug of LEGAL_SLUGS) {
    const existing = await db.select().from(legalPages).where(eq(legalPages.slug, slug));
    if (!existing.length) {
      await db.insert(legalPages).values({
        slug, title: DEFAULT_PAGES[slug].title, body: DEFAULT_PAGES[slug].body, isDefault: true,
      }).onConflictDoNothing();
    }
  }
}

export async function getBranding() {
  const rows = await db.select().from(branding).where(eq(branding.id, 1));
  return rows[0] ?? { id: 1, orgName: 'Application', legalName: '', rightsMark: '', rightsText: 'All rights reserved.', copyrightStartYear: null, logoAssetId: null, faviconAssetId: null, appContext: EMPTY_CONTEXT };
}

export function orgLabel(b: { legalName?: string | null; orgName?: string | null }): string {
  return (b.legalName && b.legalName.trim()) || b.orgName || 'This application';
}

export function substitute(text: string, b: { legalName?: string | null; orgName?: string | null }): string {
  return String(text ?? '').split('{{ORG}}').join(orgLabel(b));
}

// ALWAYS the current year — computed on read, never stored, so a deployment
// that runs across New Year does not keep showing last year's notice.
export function copyrightYears(b: { copyrightStartYear?: number | null }, now = new Date()): string {
  const year = now.getFullYear();
  const start = Number(b.copyrightStartYear);
  if (Number.isInteger(start) && start >= 1900 && start < year) return \`\${start}–\${year}\`;
  return String(year);
}

export function copyrightNotice(b: Parameters<typeof orgLabel>[0] & { rightsMark?: string | null; rightsText?: string | null; copyrightStartYear?: number | null }, now = new Date()): string {
  const mark = b.rightsMark === '®' || b.rightsMark === '™' ? b.rightsMark : '';
  const rights = (b.rightsText ?? '').trim();
  return \`© \${copyrightYears(b, now)} \${orgLabel(b)}\${mark}.\${rights ? ' ' + rights : ''}\`;
}

// The favicon falls back to the logo — an app with a logo and no favicon should
// not show the browser's blank page icon.
export function faviconId(b: { faviconAssetId?: string | null; logoAssetId?: string | null }): string | null {
  return b.faviconAssetId || b.logoAssetId || null;
}

export function assetUrl(id: string | null): string | null {
  return id ? \`/api/assets/\${id}\` : null;
}

export async function getPage(slug: string) {
  if (!(LEGAL_SLUGS as readonly string[]).includes(slug)) return null;
  const rows = await db.select().from(legalPages).where(eq(legalPages.slug, slug));
  const p = rows[0];
  if (!p) return null;
  const b = await getBranding();
  return {
    slug, title: p.title, body: substitute(p.body, b),
    isDefault: p.isDefault, updatedAt: p.updatedAt ? p.updatedAt.toISOString() : null,
  };
}

// Everything the sign-in screen and the legal pages need, with NO session.
// Must never include anything permission-bearing.
export async function publicView(now = new Date()) {
  const b = await getBranding();
  const ctx = (b.appContext ?? EMPTY_CONTEXT) as AppContext;
  const pages = await db.select().from(legalPages);
  return {
    orgName: b.orgName,
    legalName: b.legalName,
    year: now.getFullYear(),
    copyright: copyrightNotice(b, now),
    logoUrl: assetUrl(b.logoAssetId),
    faviconUrl: assetUrl(faviconId(b)),
    appContext: {
      summary: substitute(ctx.summary ?? '', b),
      audience: substitute(ctx.audience ?? '', b),
      features: (ctx.features ?? []).map((f) => ({ title: substitute(f.title, b), detail: substitute(f.detail ?? '', b) })),
    },
    legal: (LEGAL_SLUGS as readonly string[])
      .map((slug) => pages.find((p) => p.slug === slug))
      .filter(Boolean)
      .map((p) => ({ slug: p!.slug, title: p!.title })),
  };
}

export async function getAsset(id: string) {
  const rows = await db.select().from(assets).where(eq(assets.id, id));
  return rows[0] ?? null;
}
`;
}

/* ---------------------------------------------------------------------------
   API keys.
   --------------------------------------------------------------------------- */
function apiKeysTs() {
  return `import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys } from './schema.js';

// ---------------------------------------------------------------------------
// API keys — machine credentials for other applications.
//
// Design decisions worth knowing:
//
// 1. Keys carry PERMISSIONS from the same catalog people hold. There is no
//    parallel "scope" vocabulary to drift out of sync, so every existing
//    requirePermission() check covers key callers for free — a route cannot end
//    up open to machines but closed to people.
// 2. A key can never exceed its issuer: permissions are intersected with what
//    the issuing user actually holds. Otherwise anyone able to mint keys could
//    mint themselves an admin one.
// 3. The secret is shown exactly once; only a SHA-256 hash is stored, so a
//    database dump does not yield working credentials.
// 4. app_<prefix>.<secret> — the prefix indexes the row so verification is one
//    lookup; the secret is compared in constant time.
// ---------------------------------------------------------------------------

const TOKEN_NS = 'app';
const MAX_KEYS = 100;
const TOUCH_MS = 60_000;

export interface IssuedKey { id: string; name: string; prefix: string; permissions: string[]; active: boolean; expiresAt: string | null; lastUsedAt: string | null; createdBy: string | null; createdAt: string | null; revokedAt: string | null; }

function sha256(v: string): string { return crypto.createHash('sha256').update(v).digest('hex'); }

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function mint() {
  const prefix = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  return { prefix, secret, token: \`\${TOKEN_NS}_\${prefix}.\${secret}\` };
}

export function parseToken(token: string): { prefix: string; secret: string } | null {
  const m = String(token ?? '').match(/^([a-z]+)_([0-9a-f]+)\\.([A-Za-z0-9_-]+)$/);
  if (!m || m[1] !== TOKEN_NS) return null;
  return { prefix: m[2], secret: m[3] };
}

function shape(r: typeof apiKeys.$inferSelect): IssuedKey {
  return {
    id: r.id, name: r.name, prefix: r.prefix,
    permissions: (r.permissions as string[]) ?? [],
    active: r.active,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    createdBy: r.createdBy, createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  };
}

export async function listKeys(): Promise<IssuedKey[]> {
  const rows = await db.select().from(apiKeys);
  return rows.map(shape);
}

export class KeyError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export async function createKey(opts: {
  name: string;
  permissions: string[];
  expiresAt?: string | null;
  issuerId: number | null;
  issuerLabel: string | null;
  issuerPermissions: string[];
  knownPermissions: string[];
}): Promise<{ key: IssuedKey; token: string }> {
  const name = String(opts.name ?? '').trim().slice(0, 120);
  if (!name) throw new KeyError('VALIDATION', 'A name is required.');

  const active = (await db.select().from(apiKeys)).filter((k) => k.active);
  if (active.length >= MAX_KEYS) throw new KeyError('TOO_MANY', \`At most \${MAX_KEYS} active keys.\`);

  const requested = [...new Set((opts.permissions ?? []).map(String))];
  const unknown = requested.filter((p) => !opts.knownPermissions.includes(p));
  if (unknown.length) throw new KeyError('VALIDATION', \`Unknown permission(s): \${unknown.join(', ')}.\`);

  // PRIVILEGE CEILING. Without this, anyone who may create a key could create
  // one carrying permissions they do not have, and then use it.
  const refused = requested.filter((p) => !opts.issuerPermissions.includes(p));
  if (refused.length) throw new KeyError('FORBIDDEN', \`You cannot grant a key permissions you do not hold: \${refused.join(', ')}.\`);
  if (!requested.length) throw new KeyError('VALIDATION', 'A key needs at least one permission.');

  let expiry: Date | null = null;
  if (opts.expiresAt) {
    const t = new Date(opts.expiresAt);
    if (Number.isNaN(t.getTime())) throw new KeyError('VALIDATION', 'expiresAt must be a date.');
    if (t.getTime() <= Date.now()) throw new KeyError('VALIDATION', 'expiresAt must be in the future.');
    expiry = t;
  }

  const { prefix, secret, token } = mint();
  const id = crypto.randomUUID();
  await db.insert(apiKeys).values({
    id, name, prefix, tokenHash: sha256(secret),
    userId: opts.issuerId, permissions: requested, active: true,
    expiresAt: expiry, createdBy: opts.issuerLabel,
  });
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  return { key: shape(rows[0]), token };
}

export async function revokeKey(id: string): Promise<IssuedKey | null> {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  if (!rows.length) return null;
  await db.update(apiKeys)
    // The hash is cleared, not just the flag: a revoked row must carry nothing
    // that could be re-activated by editing a boolean.
    .set({ active: false, revokedAt: new Date(), tokenHash: null })
    .where(eq(apiKeys.id, id));
  const after = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  return shape(after[0]);
}

export interface VerifiedKey { id: string; name: string; userId: number | null; permissions: string[]; }

// verify — deliberately vague on failure: a caller learns "this did not work",
// never which part of it was wrong.
export async function verifyKey(token: string): Promise<{ ok: true; key: VerifiedKey } | { ok: false; code: string }> {
  const parsed = parseToken(token);
  if (!parsed) return { ok: false, code: 'INVALID_KEY' };
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.prefix, parsed.prefix));
  const k = rows[0];
  if (!k || !k.active || !k.tokenHash) return { ok: false, code: 'INVALID_KEY' };
  if (!timingSafeEq(sha256(parsed.secret), k.tokenHash)) return { ok: false, code: 'INVALID_KEY' };
  if (k.expiresAt && k.expiresAt.getTime() <= Date.now()) return { ok: false, code: 'KEY_EXPIRED' };
  return { ok: true, key: { id: k.id, name: k.name, userId: k.userId, permissions: (k.permissions as string[]) ?? [] } };
}

// Throttled: a busy integration would otherwise turn every read into a write.
const lastTouch = new Map<string, number>();
export async function touchKey(id: string): Promise<void> {
  const now = Date.now();
  if (now - (lastTouch.get(id) ?? 0) < TOUCH_MS) return;
  lastTouch.set(id, now);
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id)).catch(() => undefined);
}

// Authorization is the standard; X-API-Key is accepted because a lot of BI and
// automation tooling can set a custom header but not an Authorization one.
export function tokenFromRequest(req: { headers: Record<string, unknown> }): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^bearer\\s+/i.test(auth)) return auth.replace(/^bearer\\s+/i, '').trim();
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  return null;
}
`;
}

/* ---------------------------------------------------------------------------
   Read-only SQL.
   --------------------------------------------------------------------------- */
function readonlyTs() {
  return `import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Read-only SQL access.
//
// Why: some questions are enormously cheaper in SQL than over the API. Why
// READ-ONLY: every state change must go through the API, where permission
// checks, validation and the audit trail live.
//
// THE IMPORTANT PART: consumers get VIEWS, never base tables. The base tables
// hold credential material (password hashes, refresh-token hashes, API-key
// hashes, encrypted LDAP bind passwords), so a plain
// GRANT SELECT ON ALL TABLES would hand every reporting consumer the hashes.
// The role is granted SELECT on curated views in a separate schema and is
// explicitly denied everything else. Adding a table later does NOT expose it:
// the grant is per-schema-of-views, and default privileges are never widened to
// base tables.
// ---------------------------------------------------------------------------

export const RO_SCHEMA = 'api_read';
export const RO_ROLE = process.env.READONLY_DB_ROLE || 'app_readonly';

// The published surface. Deliberately narrower than the tables behind it.
// Extend this when a build adds a table worth reporting on — and project only
// the non-secret columns.
const VIEWS = \`
CREATE SCHEMA IF NOT EXISTS \${RO_SCHEMA};

CREATE OR REPLACE VIEW \${RO_SCHEMA}.branding AS
SELECT id, org_name, legal_name, rights_mark, updated_at FROM public.branding;

CREATE OR REPLACE VIEW \${RO_SCHEMA}.legal_pages AS
SELECT slug, title, is_default, updated_at FROM public.legal_pages;

-- Assets WITHOUT their bytes: metadata is queryable, payloads are not.
CREATE OR REPLACE VIEW \${RO_SCHEMA}.assets AS
SELECT id, name, mime, size, kind, alt, created_at FROM public.assets;

-- Issued machine credentials: which exist and whether they are live. NEVER
-- token_hash.
CREATE OR REPLACE VIEW \${RO_SCHEMA}.api_keys AS
SELECT id, name, prefix, user_id, permissions, active, expires_at,
       last_used_at, created_by, created_at, revoked_at
FROM public.api_keys;

CREATE OR REPLACE VIEW \${RO_SCHEMA}.platform_audit AS
SELECT id, action, actor_label, target_label, outcome, created_at FROM public.platform_audit;
\`;

function grants(role: string): string {
  return \`
REVOKE ALL ON SCHEMA public FROM \${role};
GRANT USAGE ON SCHEMA \${RO_SCHEMA} TO \${role};
GRANT SELECT ON ALL TABLES IN SCHEMA \${RO_SCHEMA} TO \${role};
ALTER DEFAULT PRIVILEGES IN SCHEMA \${RO_SCHEMA} GRANT SELECT ON TABLES TO \${role};
\`;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error('INVALID_ROLE_NAME');
  return '"' + name + '"';
}
function literal(v: string): string { return "'" + v.replace(/'/g, "''") + "'"; }

export async function ensureViews(): Promise<void> {
  await db.execute(sql.raw(VIEWS));
}

export async function describe(): Promise<Record<string, { column: string; type: string }[]>> {
  const r = await db.execute(sql.raw(
    \`SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = '\${RO_SCHEMA}' ORDER BY table_name, ordinal_position\`,
  ));
  const out: Record<string, { column: string; type: string }[]> = {};
  for (const row of (r as unknown as { rows: Record<string, string>[] }).rows ?? []) {
    (out[row.table_name] ??= []).push({ column: row.column_name, type: row.data_type });
  }
  return out;
}

async function roleExists(role: string): Promise<boolean> {
  const r = await db.execute(sql.raw(\`SELECT 1 FROM pg_roles WHERE rolname = \${literal(role)}\`));
  return ((r as unknown as { rows: unknown[] }).rows ?? []).length > 0;
}

export async function status(): Promise<{ enabled: boolean; role: string; schema: string }> {
  if (!(await roleExists(RO_ROLE))) return { enabled: false, role: RO_ROLE, schema: RO_SCHEMA };
  const r = await db.execute(sql.raw(\`SELECT rolcanlogin FROM pg_roles WHERE rolname = \${literal(RO_ROLE)}\`));
  const rows = (r as unknown as { rows: { rolcanlogin: boolean }[] }).rows ?? [];
  return { enabled: !!rows[0]?.rolcanlogin, role: RO_ROLE, schema: RO_SCHEMA };
}

export class DbPrivilegeError extends Error { code = 'DB_PRIVILEGE'; }

// Issuing rotates: the previous password stops working immediately, which is
// also the revocation story.
export async function enableReadonly(): Promise<{ role: string; schema: string; url: string; odbc: string }> {
  const role = quoteIdent(RO_ROLE);
  const password = crypto.randomBytes(24).toString('base64url');
  await ensureViews();
  try {
    if (await roleExists(RO_ROLE)) {
      await db.execute(sql.raw(\`ALTER ROLE \${role} WITH LOGIN PASSWORD \${literal(password)}\`));
    } else {
      // Stated explicitly: this role must never be able to widen its own access.
      await db.execute(sql.raw(\`CREATE ROLE \${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD \${literal(password)}\`));
    }
    await db.execute(sql.raw(grants(role)));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The app role is deliberately not a superuser, so a locked-down deployment
    // may refuse this. That is a legitimate configuration, not a bug — answer
    // with the exact statement a DBA must run.
    if (/permission denied to create role|must be superuser|permission denied for/i.test(msg)) {
      throw new DbPrivilegeError(
        "This application's database role may not create roles, so it cannot issue the read-only credential itself. "
        + 'Ask a database administrator to run:  ALTER ROLE <app_role> CREATEROLE;  '
        + 'Granting CREATEROLE is the minimum; the app never needs superuser.',
      );
    }
    throw e;
  }
  return { role: RO_ROLE, schema: RO_SCHEMA, url: connectionUrl(RO_ROLE, password), odbc: odbcDsn(RO_ROLE, password) };
}

export async function disableReadonly(): Promise<{ enabled: false; role: string }> {
  if (await roleExists(RO_ROLE)) {
    // NOLOGIN rather than DROP: dropping fails while the role owns or is granted
    // anything, and an operator disabling access wants it to stop NOW.
    await db.execute(sql.raw(\`ALTER ROLE \${quoteIdent(RO_ROLE)} WITH NOLOGIN\`));
  }
  return { enabled: false, role: RO_ROLE };
}

function parts() {
  let u: URL | null = null;
  try { u = new URL(config.DATABASE_URL); } catch { u = null; }
  return {
    host: u?.hostname ?? '127.0.0.1',
    port: u?.port ?? '5432',
    database: (u?.pathname ?? '/app').replace(/^\\//, ''),
  };
}
export function connectionUrl(role: string, password: string): string {
  const { host, port, database } = parts();
  return \`postgres://\${encodeURIComponent(role)}:\${encodeURIComponent(password)}@\${host}:\${port}/\${database}\`;
}
// ODBC takes a DSN, not a URL — the point of the request is "let a BI tool
// connect", and those want a DSN.
export function odbcDsn(role: string, password: string): string {
  const { host, port, database } = parts();
  return \`Driver={PostgreSQL Unicode};Server=\${host};Port=\${port};Database=\${database};Uid=\${role};Pwd=\${password};sslmode=prefer;\`;
}
`;
}

export const PLATFORM_SOURCES = { platformSchemaTs, brandingTs, apiKeysTs, readonlyTs };

/* ---------------------------------------------------------------------------
   API-key authentication middleware.
   --------------------------------------------------------------------------- */
function apiKeyAuthTs() {
  return `import type { Request, Response, NextFunction } from 'express';
import { verifyKey, touchKey, tokenFromRequest } from './api-keys.js';

// ---------------------------------------------------------------------------
// Layered onto the SAME permission check routes already use, rather than bolted
// on as a parallel /v1 surface. That is the whole design: every existing
// endpoint becomes callable by another application with exactly the check it
// already had, and a route cannot end up open to machines but closed to people
// because there is only one check.
//
// A key is tried only when there is no session, so browsers are unaffected.
// ---------------------------------------------------------------------------

export interface KeyAuth { id: string; name: string; userId: number | null; permissions: string[]; }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { apiKey?: KeyAuth }
  }
}

// Attach the key context when a token is presented AND no session is active.
export async function withApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = tokenFromRequest(req as unknown as { headers: Record<string, unknown> });
  if (!token) { next(); return; }
  const v = await verifyKey(token);
  if (!v.ok) {
    res.status(401).json({ code: v.code, message: 'That API key is not valid.' });
    return;
  }
  req.apiKey = v.key;
  void touchKey(v.key.id);
  next();
}

// requirePermissionOrKey — the drop-in replacement for requirePermission on any
// route a machine may call. A KEY is limited to its OWN permission list, never
// everything its owner can do; otherwise every key an admin issued would carry
// admin rights.
export function requirePermissionOrKey(
  permission: string,
  sessionCheck: (p: string) => (req: Request, res: Response, next: NextFunction) => void,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.apiKey) {
      if (req.apiKey.permissions.includes(permission)) { next(); return; }
      res.status(403).json({ code: 'FORBIDDEN', message: 'This key does not have permission to do that.', required: permission });
      return;
    }
    sessionCheck(permission)(req, res, next);
  };
}

// Human-only guard: a machine credential must never be able to take over the
// account it acts for, nor mint another credential (which would make revocation
// unwinnable).
export function denyApiKey(req: Request, res: Response, next: NextFunction): void {
  if (req.apiKey) {
    res.status(401).json({ code: 'SESSION_REQUIRED', message: 'This action requires a signed-in user, not an API key.' });
    return;
  }
  next();
}
`;
}

/* ---------------------------------------------------------------------------
   Platform routes.
   --------------------------------------------------------------------------- */
function platformRoutesTs() {
  return `import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { branding, legalPages, assets, auditLog } from './schema.js';
import {
  publicView, getPage, getBranding, getAsset, ensureSeeded,
  copyrightNotice, faviconId, DEFAULT_PAGES, LEGAL_SLUGS,
} from './branding.js';
import { listKeys, createKey, revokeKey, KeyError } from './api-keys.js';
import { status as roStatus, enableReadonly, disableReadonly, describe as roDescribe, DbPrivilegeError } from './readonly.js';
import { denyApiKey } from './api-key-auth.js';
import { DEFAULT_PERMISSIONS } from '../auth/permissions.js';
import { requireRole, getAuth } from '../auth/index.js';
import { pushPublicRoutes, pushRoutes } from './push.js';

const ALLOWED_ASSET_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon']);
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

// The audit actor. AuthContext carries userId + role, not an email, so the
// label is built from what is actually there rather than a field that does not
// exist — a missing property would have compiled to \"undefined\" in every row.
function actorLabel(req: Request): string | null {
  if (req.apiKey) return \`api-key:\${req.apiKey.name}\`;
  const a = getAuth(req);
  if (!a || !a.authenticated) return null;
  return a.userId != null ? \`user:\${a.userId}\` : \`role:\${a.role}\`;
}

async function record(action: string, actor: string | null, meta: unknown = null, targetLabel: string | null = null): Promise<void> {
  await db.insert(auditLog).values({ action, actorLabel: actor, targetLabel, outcome: 'ok', meta: meta as object }).catch(() => undefined);
}

/* ------------------------------- PUBLIC ---------------------------------- */
// Mounted BEFORE the auth gate. The sign-in screen renders the copyright
// notice, the logo and the Privacy/Terms links before anyone has a session, and
// the browser fetches the favicon with no cookies at all.
export const publicPlatformRoutes = Router();
// Web Push config rides the PUBLIC router: the browser needs the VAPID public
// key before it can subscribe, and the sign-in page is allowed to know whether
// notifications exist at all. Nothing here is a secret.
publicPlatformRoutes.use(pushPublicRoutes);

publicPlatformRoutes.get('/api/branding', async (_req: Request, res: Response) => {
  res.json({ branding: await publicView() });
});

publicPlatformRoutes.get('/api/legal/:slug', async (req: Request, res: Response) => {
  const page = await getPage(String(req.params.slug));
  if (!page) { res.status(404).json({ code: 'NOT_FOUND', message: 'Page not found.' }); return; }
  res.json({ page });
});

publicPlatformRoutes.get('/api/assets/:id', async (req: Request, res: Response) => {
  const a = await getAsset(String(req.params.id));
  if (!a) { res.status(404).json({ code: 'NOT_FOUND' }); return; }
  res.setHeader('Content-Type', a.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Neutralises script inside an uploaded SVG even on direct navigation.
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(a.data, 'base64'));
});

publicPlatformRoutes.get('/favicon.ico', async (_req: Request, res: Response) => {
  const b = await getBranding();
  const id = faviconId(b);
  if (!id) { res.status(404).end(); return; }
  const a = await getAsset(id);
  if (!a) { res.status(404).end(); return; }
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(a.data, 'base64'));
});

// The capability index. Public because a consumer needs it BEFORE they have a
// key; it lists what can be done, never data.
publicPlatformRoutes.get('/api/meta', async (_req: Request, res: Response) => {
  const b = await publicView();
  res.json({
    name: b.orgName,
    auth: {
      header: 'Authorization: Bearer <key>',
      alternative: 'X-API-Key: <key>',
      note: 'A key carries a subset of the same permissions people hold. Every endpoint enforces the same check for keys and sessions.',
    },
    permissions: Object.keys(DEFAULT_PERMISSIONS),
    endpoints: [
      { method: 'GET', path: '/api/meta', permission: null, summary: 'This document' },
      { method: 'GET', path: '/api/whoami', permission: null, summary: 'Check a credential and list what it may do' },
      { method: 'GET', path: '/api/branding', permission: null, summary: 'Public identity, logo, legal page index' },
      { method: 'GET', path: '/api/legal/:slug', permission: null, summary: 'A legal page (privacy, terms)' },
      { method: 'GET', path: '/api/health', permission: null, summary: 'Liveness' },
      { method: 'GET', path: '/api/admin/branding', permission: 'admin.settings', summary: 'Editable identity, legal copy, assets' },
      { method: 'PUT', path: '/api/admin/branding', permission: 'admin.settings', summary: 'Update identity / app context' },
      { method: 'GET', path: '/api/admin/api-keys', permission: 'admin.settings', summary: 'List issued API keys' },
      { method: 'POST', path: '/api/admin/api-keys', permission: 'admin.settings', summary: 'Issue a key (session only; token shown once)' },
      { method: 'DELETE', path: '/api/admin/api-keys/:id', permission: 'admin.settings', summary: 'Revoke a key (session only)' },
      { method: 'GET', path: '/api/admin/db/readonly', permission: 'admin.settings', summary: 'Read-only SQL status and published views' },
      { method: 'POST', path: '/api/admin/db/readonly', permission: 'admin.settings', summary: 'Issue/rotate the read-only credential (session only)' },
    ],
    readonlySql: 'POST /api/admin/db/readonly issues a SELECT-only PostgreSQL credential for reporting.',
  });
});

/* ------------------------------ AUTHENTICATED ---------------------------- */
export const platformRoutes = Router();
// Subscribing ties a device to this install, so it sits behind the auth gate.
platformRoutes.use(pushRoutes);

platformRoutes.get('/api/whoami', (req: Request, res: Response) => {
  if (req.apiKey) {
    res.json({ kind: 'api_key', key: { id: req.apiKey.id, name: req.apiKey.name }, permissions: req.apiKey.permissions });
    return;
  }
  const auth = getAuth(req);
  // withAuth ATTACHES a context whether or not an identity was asserted, so the
  // presence of the object proves nothing — the authenticated flag is what
  // decides. Checking only for the object made this endpoint answer 200 to a
  // caller with no session at all.
  if (!auth || !auth.authenticated) { res.status(401).json({ code: 'UNAUTHENTICATED' }); return; }
  res.json({ kind: 'session', user: { id: auth.userId ?? null, role: auth.role }, permissions: Object.keys(DEFAULT_PERMISSIONS) });
});

/* -------------------------------- ADMIN ---------------------------------- */
export const adminPlatformRoutes = Router();
adminPlatformRoutes.use(requireRole('admin'));

const IdentitySchema = z.object({
  orgName: z.string().trim().min(1).max(120).optional(),
  legalName: z.string().trim().max(160).optional(),
  rightsMark: z.enum(['', '®', '™']).optional(),
  rightsText: z.string().trim().max(160).optional(),
  copyrightStartYear: z.number().int().min(1900).max(new Date().getFullYear()).nullable().optional(),
  logoAssetId: z.string().nullable().optional(),
  faviconAssetId: z.string().nullable().optional(),
  appContext: z.object({
    summary: z.string().max(4000).optional(),
    audience: z.string().max(1000).optional(),
    features: z.array(z.object({ title: z.string().max(160), detail: z.string().max(600).optional() })).max(60).optional(),
  }).optional(),
});

adminPlatformRoutes.get('/branding', async (_req: Request, res: Response) => {
  await ensureSeeded();
  const b = await getBranding();
  const pages = await db.select().from(legalPages);
  const list = await db.select({
    id: assets.id, name: assets.name, mime: assets.mime, size: assets.size,
    kind: assets.kind, alt: assets.alt, createdAt: assets.createdAt,
  }).from(assets);
  res.json({
    branding: {
      ...b,
      copyrightPreview: copyrightNotice(b),
      logoUrl: b.logoAssetId ? \`/api/assets/\${b.logoAssetId}\` : null,
      faviconUrl: faviconId(b) ? \`/api/assets/\${faviconId(b)}\` : null,
      faviconInherited: !b.faviconAssetId && !!b.logoAssetId,
      pages, assets: list,
      limits: { maxAssetBytes: MAX_ASSET_BYTES, allowedMime: [...ALLOWED_ASSET_MIME] },
    },
  });
});

adminPlatformRoutes.put('/branding', async (req: Request, res: Response) => {
  const parsed = IdentitySchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ code: 'VALIDATION', message: parsed.error.issues[0]?.message ?? 'Invalid settings.' }); return; }
  const patch = parsed.data;
  const values: Record<string, unknown> = {};
  for (const k of ['orgName', 'legalName', 'rightsMark', 'rightsText', 'copyrightStartYear', 'logoAssetId', 'faviconAssetId'] as const) {
    if (patch[k] !== undefined) values[k] = patch[k];
  }
  if (patch.appContext) {
    const cur = (await getBranding()).appContext as Record<string, unknown>;
    values.appContext = {
      ...cur,
      ...patch.appContext,
      features: patch.appContext.features ?? (cur?.features ?? []),
      updatedAt: new Date().toISOString(),
    };
  }
  values.updatedAt = new Date();
  await db.update(branding).set(values).where(eq(branding.id, 1));
  await record('branding.update', actorLabel(req), { fields: Object.keys(values) });
  const b = await getBranding();
  res.json({ code: 'OK', branding: { ...b, copyrightPreview: copyrightNotice(b) } });
});

adminPlatformRoutes.put('/branding/pages/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  if (!(LEGAL_SLUGS as readonly string[]).includes(slug)) { res.status(404).json({ code: 'NOT_FOUND' }); return; }
  const Body = z.object({ title: z.string().trim().min(1).max(160).optional(), body: z.string().max(100000).optional() });
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ code: 'VALIDATION', message: 'Invalid page.' }); return; }
  const set: Record<string, unknown> = { isDefault: false, updatedAt: new Date(), updatedBy: actorLabel(req) };
  if (parsed.data.title !== undefined) set.title = parsed.data.title;
  if (parsed.data.body !== undefined) set.body = parsed.data.body;
  await db.update(legalPages).set(set).where(eq(legalPages.slug, slug));
  await record('branding.page_update', actorLabel(req), { slug });
  res.json({ code: 'OK', page: await getPage(slug) });
});

// Restore the shipped copy — an operator who has edited themselves into a
// corner should not have to find the original text.
adminPlatformRoutes.post('/branding/pages/:slug/reset', async (req: Request, res: Response) => {
  const slug = String(req.params.slug) as keyof typeof DEFAULT_PAGES;
  if (!(LEGAL_SLUGS as readonly string[]).includes(slug)) { res.status(404).json({ code: 'NOT_FOUND' }); return; }
  await db.update(legalPages)
    .set({ title: DEFAULT_PAGES[slug].title, body: DEFAULT_PAGES[slug].body, isDefault: true, updatedAt: null, updatedBy: null })
    .where(eq(legalPages.slug, slug));
  res.json({ code: 'OK', page: await getPage(slug) });
});

// Assets arrive base64 in JSON: one small brand image at a time, so a multipart
// parser would be a dependency bought for nothing.
adminPlatformRoutes.post('/branding/assets', async (req: Request, res: Response) => {
  const Body = z.object({
    name: z.string().trim().min(1).max(200),
    mime: z.string().trim(),
    data: z.string().min(1),
    kind: z.enum(['logo', 'favicon', 'image', 'document']).default('image'),
    alt: z.string().max(300).default(''),
  });
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ code: 'VALIDATION', message: 'name, mime and data are required.' }); return; }
  const { name, mime, data, kind, alt } = parsed.data;
  if (!ALLOWED_ASSET_MIME.has(mime)) { res.status(415).json({ code: 'UNSUPPORTED_TYPE', message: 'That file type cannot be used as an asset.' }); return; }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) { res.status(400).json({ code: 'VALIDATION', message: 'The uploaded file was empty.' }); return; }
  if (bytes.length > MAX_ASSET_BYTES) { res.status(413).json({ code: 'TOO_LARGE', message: 'That file is too large.' }); return; }

  const id = crypto.randomUUID();
  await db.insert(assets).values({ id, name, mime, size: bytes.length, kind, alt, data: bytes.toString('base64'), uploadedBy: actorLabel(req) });
  // Uploading AS the logo/favicon selects it — the two-step "upload, then go and
  // pick it" is the step everyone forgets.
  if (kind === 'logo') await db.update(branding).set({ logoAssetId: id }).where(eq(branding.id, 1));
  if (kind === 'favicon') await db.update(branding).set({ faviconAssetId: id }).where(eq(branding.id, 1));
  await record('branding.asset_upload', actorLabel(req), { id, kind, name });
  res.status(201).json({ code: 'OK', asset: { id, name, mime, size: bytes.length, kind, alt } });
});

adminPlatformRoutes.delete('/branding/assets/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const existing = await getAsset(id);
  if (!existing) { res.status(404).json({ code: 'NOT_FOUND' }); return; }
  await db.delete(assets).where(eq(assets.id, id));
  // Never leave a dangling reference: a deleted logo must clear the pointer, or
  // the favicon fallback resolves to a 404 forever.
  const b = await getBranding();
  const clear: Record<string, unknown> = {};
  if (b.logoAssetId === id) clear.logoAssetId = null;
  if (b.faviconAssetId === id) clear.faviconAssetId = null;
  if (Object.keys(clear).length) await db.update(branding).set(clear).where(eq(branding.id, 1));
  res.json({ code: 'OK' });
});

/* ---- API keys ---- */
adminPlatformRoutes.get('/api-keys', async (_req: Request, res: Response) => {
  res.json({ keys: await listKeys(), permissions: Object.keys(DEFAULT_PERMISSIONS) });
});

// Issuing a credential is a HUMAN act: a key must not be able to mint another
// key, which would make revocation unwinnable.
adminPlatformRoutes.post('/api-keys', denyApiKey, async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const known = Object.keys(DEFAULT_PERMISSIONS);
  // An admin session holds every permission in the catalog; the ceiling still
  // exists in code so a narrower issuer role cannot escalate later.
  const issuerPermissions = known;
  try {
    const out = await createKey({
      name: String(req.body?.name ?? ''),
      permissions: Array.isArray(req.body?.permissions) ? req.body.permissions : [],
      expiresAt: req.body?.expiresAt ?? null,
      issuerId: auth?.userId ?? null,
      issuerLabel: actorLabel(req),
      issuerPermissions,
      knownPermissions: known,
    });
    await record('apikey.create', actorLabel(req), { permissions: out.key.permissions }, out.key.name);
    // The token appears here and nowhere else, ever.
    res.status(201).json({ code: 'OK', key: out.key, token: out.token, warning: 'Copy this key now — it cannot be shown again.' });
  } catch (e) {
    if (e instanceof KeyError) {
      const status = e.code === 'FORBIDDEN' ? 403 : e.code === 'TOO_MANY' ? 409 : 400;
      res.status(status).json({ code: e.code, message: e.message });
      return;
    }
    throw e;
  }
});

adminPlatformRoutes.delete('/api-keys/:id', denyApiKey, async (req: Request, res: Response) => {
  const gone = await revokeKey(String(req.params.id));
  if (!gone) { res.status(404).json({ code: 'NOT_FOUND', message: 'Key not found.' }); return; }
  await record('apikey.revoke', actorLabel(req), null, gone.name);
  res.json({ code: 'OK', key: gone });
});

/* ---- read-only SQL ---- */
adminPlatformRoutes.get('/db/readonly', async (_req: Request, res: Response) => {
  try {
    res.json({ ...(await roStatus()), views: await roDescribe() });
  } catch (e) {
    res.status(500).json({ code: 'DB_ERROR', message: e instanceof Error ? e.message : 'Could not read the database role.' });
  }
});

adminPlatformRoutes.post('/db/readonly', denyApiKey, async (req: Request, res: Response) => {
  try {
    const out = await enableReadonly();
    await record('db.readonly_issue', actorLabel(req), { role: out.role });
    res.status(201).json({
      code: 'OK', ...out, views: await roDescribe(),
      warning: 'Copy this connection string now — the password cannot be shown again. Issuing again rotates it, which also revokes the previous one.',
    });
  } catch (e) {
    // A missing database privilege is a configuration answer, not a server
    // fault — 409 with the fix, so the operator knows what to do.
    if (e instanceof DbPrivilegeError) { res.status(409).json({ code: e.code, message: e.message }); return; }
    res.status(500).json({ code: 'DB_ERROR', message: e instanceof Error ? e.message : 'Could not issue the credential.' });
  }
});

adminPlatformRoutes.delete('/db/readonly', denyApiKey, async (req: Request, res: Response) => {
  const out = await disableReadonly();
  await record('db.readonly_disable', actorLabel(req));
  res.json({ code: 'OK', ...out });
});
`;
}

/* ---------------------------------------------------------------------------
   Migration. Numbered above the auth component's 0001–0003 so ordering is
   unambiguous however the two are installed.
   --------------------------------------------------------------------------- */
function platformMigrationSql() {
  return `-- Platform tables: identity, legal copy, shared assets, machine credentials.
-- Every project is provisioned with these; a build adds its own tables beside
-- them, it does not replace them.

CREATE TABLE IF NOT EXISTS branding (
  id                   integer PRIMARY KEY DEFAULT 1,
  org_name             text NOT NULL DEFAULT 'Application',
  legal_name           text NOT NULL DEFAULT '',
  rights_mark          text NOT NULL DEFAULT '',
  rights_text          text NOT NULL DEFAULT 'All rights reserved.',
  copyright_start_year integer,
  logo_asset_id        text,
  favicon_asset_id     text,
  app_context          jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT branding_singleton CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS legal_pages (
  slug       text PRIMARY KEY,
  title      text NOT NULL,
  body       text NOT NULL,
  is_default boolean NOT NULL DEFAULT true,
  updated_at timestamptz,
  updated_by text
);

CREATE TABLE IF NOT EXISTS assets (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  mime        text NOT NULL,
  size        bigint NOT NULL,
  kind        text NOT NULL DEFAULT 'image',
  alt         text NOT NULL DEFAULT '',
  data        text NOT NULL,
  uploaded_by text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_kind CHECK (kind IN ('logo', 'favicon', 'image', 'document'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  prefix       text NOT NULL,
  -- Nullable: revoking CLEARS the hash, so a revoked row carries no material
  -- that could be re-activated by flipping the boolean.
  token_hash   text,
  user_id      integer,
  permissions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  active       boolean NOT NULL DEFAULT true,
  expires_at   timestamptz,
  last_used_at timestamptz,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_prefix_key ON api_keys (prefix);
CREATE INDEX IF NOT EXISTS api_keys_active_idx ON api_keys (active) WHERE active = true;

CREATE TABLE IF NOT EXISTS platform_audit (
  id           bigserial PRIMARY KEY,
  action       text NOT NULL,
  actor_label  text,
  target_label text,
  outcome      text,
  meta         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_created_idx ON platform_audit (created_at DESC);

INSERT INTO branding (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
` + pushMigrationSql();
}

/* ---------------------------------------------------------------------------
   Theme — loaded synchronously BEFORE the stylesheet.
   --------------------------------------------------------------------------- */
function themeJs() {
  return `'use strict';
/* Theme (light / dark / follow the system).
 *
 * Loaded FIRST and SYNCHRONOUSLY in <head>, before the stylesheet. A deferred
 * script applies the theme after first paint, which shows a dark-mode user a
 * white flash on every single page load.
 *
 * Three states on purpose: 'light' and 'dark' are explicit choices that stick;
 * 'system' (the default) follows the OS and keeps following it, so a user can
 * always get back to "just match my device".
 */
(function () {
  var KEY = 'app-theme';
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function stored() {
    try { var v = localStorage.getItem(KEY); return (v === 'light' || v === 'dark' || v === 'system') ? v : 'system'; }
    catch (e) { return 'system'; }
  }
  function effective(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return media && media.matches ? 'dark' : 'light';
  }
  function apply(pref) {
    var t = effective(pref);
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0d1725' : '#f5f8fc');
    return t;
  }

  apply(stored());
  if (media && media.addEventListener) {
    media.addEventListener('change', function () { if (stored() === 'system') { apply('system'); refresh(); } });
  }

  function icon(pref) {
    if (pref === 'light') return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    if (pref === 'dark') return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 20h8M12 18v2"/></svg>';
  }
  function label(pref) {
    return pref === 'system' ? 'Theme: match device' : pref === 'light' ? 'Theme: light' : 'Theme: dark';
  }
  function refresh() {
    var pref = stored();
    var nodes = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].innerHTML = icon(pref);
      nodes[i].setAttribute('title', label(pref) + ' — click to change');
      nodes[i].setAttribute('aria-label', label(pref) + '. Click to change theme.');
    }
  }

  var Theme = {
    get: stored,
    resolved: function () { return effective(stored()); },
    set: function (pref) { try { localStorage.setItem(KEY, pref); } catch (e) {} apply(pref); refresh(); },
    // Cycle from what you are LOOKING AT, not from a fixed list.
    //
    // The fixed order was system → light → dark, so on a device set to light
    // (most of them) the FIRST click moved system → light and changed nothing
    // visible: the icon updated, the page did not, and it took two clicks to
    // see anything. Starting from the effective theme makes every click flip
    // the screen while keeping all three preferences reachable:
    //   device light: system → dark → light → system
    //   device dark:  system → light → dark → system
    cycle: function () {
      var pref = stored();
      var deviceIsDark = effective('system') === 'dark';
      var flipped = deviceIsDark ? 'light' : 'dark';
      if (pref === 'system') { Theme.set(flipped); return; }
      Theme.set(pref === flipped ? (deviceIsDark ? 'dark' : 'light') : 'system');
    },
    buttonHtml: function (id) {
      var pref = stored();
      return '<button class="theme-toggle" type="button"' + (id ? ' id="' + id + '"' : '') +
        ' title="' + label(pref) + ' — click to change" aria-label="' + label(pref) + '. Click to change theme.">' +
        icon(pref) + '</button>';
    },
  };

  // Wired by DELEGATION, once. Screens re-render their own headers, and binding
  // per-render silently misses whichever one is added next.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.theme-toggle') : null;
    if (!btn) return;
    e.preventDefault();
    Theme.cycle();
  });
  // AUTO-MOUNT, so the control exists even on a page that forgot to render one.
  //
  // The generated pages now ship a .theme-toggle explicitly, but for a long
  // while none of them did: theme.js was loaded on every screen, applied the
  // stored theme, and offered NO WAY TO CHANGE IT. The operator's report was
  // simply "no theme change light/dark". Auto-mounting into the page's header
  // means an EXISTING project picks the control up from a base-app upgrade
  // (theme.js is platform-owned) without rewriting pages a build may have
  // restyled — and a build that renders its own header gets one for free.
  //
  // Only ever ONE, and never on top of a control the page already has.
  function ensureToggle() {
    if (document.querySelector('.theme-toggle')) { refresh(); return; }
    var host = document.querySelector('header nav') || document.querySelector('header');
    if (!host) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle btn subtle sm';
    btn.setAttribute('data-theme-auto', '1');
    host.appendChild(btn);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureToggle);
  else ensureToggle();

  document.addEventListener('DOMContentLoaded', refresh);

  window.Theme = Theme;
})();
`;
}

/* ---------------------------------------------------------------------------
   Branding client — the sign-in footer and the legal pages.
   --------------------------------------------------------------------------- */
function platformDialogsJs() {
  return `
/* ---- Styled replacements for alert / confirm / prompt ----
 *
 * The browser's own dialogs are titled with the raw hostname
 * ("n2.example.com says"), ignore the app's design completely, and block the
 * page. A shipped build used prompt() for "New to-do" and it read as
 * unfinished — fairly, since the shell had just been styled to an approved
 * design. The no-native-dialogs gate now fails a build that uses them, so the
 * platform has to provide the alternative rather than just forbid the easy way.
 *
 * These use base.css's own .modal/.modal-backdrop, so they inherit the
 * approved palette for free. All three return a Promise.
 *
 *   await pp.alert('Saved')
 *   if (await pp.confirm('Delete this note?')) …
 *   const name = await pp.prompt('Name this list')   // null when cancelled
 */
(function () {
  var pp = window.pp || (window.pp = {});

  function dialog(opts) {
    return new Promise(function (resolve) {
      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      var box = document.createElement('div');
      box.className = 'modal';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      if (opts.title) {
        var h = document.createElement('h3');
        h.textContent = opts.title;
        h.style.cssText = 'margin:0 0 8px;font-size:1.05rem';
        box.appendChild(h);
      }
      var msg = document.createElement('p');
      msg.textContent = opts.message || '';
      msg.style.cssText = opts.title ? 'margin:0 0 14px' : 'margin:0 0 14px;font-weight:600';
      box.appendChild(msg);

      var input = null;
      if (opts.kind === 'prompt') {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'input';
        input.value = opts.value || '';
        input.style.cssText = 'width:100%;margin-bottom:14px';
        box.appendChild(input);
      }

      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap';
      function close(value) {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        resolve(value);
      }
      if (opts.kind !== 'alert') {
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn subtle';
        cancel.textContent = opts.cancelText || 'Cancel';
        cancel.style.minHeight = '44px';
        cancel.addEventListener('click', function () { close(opts.kind === 'prompt' ? null : false); });
        row.appendChild(cancel);
      }
      var ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'btn';
      ok.textContent = opts.okText || 'OK';
      ok.style.minHeight = '44px';
      ok.addEventListener('click', function () {
        close(opts.kind === 'prompt' ? (input.value || '') : true);
      });
      row.appendChild(ok);
      box.appendChild(row);

      function onKey(e) {
        if (e.key === 'Escape') close(opts.kind === 'prompt' ? null : false);
        if (e.key === 'Enter' && opts.kind === 'prompt') ok.click();
      }
      document.addEventListener('keydown', onKey);
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) close(opts.kind === 'prompt' ? null : false);
      });

      backdrop.appendChild(box);
      document.body.appendChild(backdrop);
      (input || ok).focus();
    });
  }

  // The second argument may be a plain string (the OK label — the original,
  // still-supported form) or { okText, cancelText, title }. An install
  // invitation needs "Install" / "Not now", which one label cannot express.
  function opts(arg, defaultOk) {
    if (arg && typeof arg === 'object') {
      return { okText: arg.okText || defaultOk, cancelText: arg.cancelText, title: arg.title };
    }
    return { okText: arg || defaultOk };
  }
  pp.alert = function (message, o) { return dialog(Object.assign({ kind: 'alert', message: message }, opts(o, 'OK'))); };
  pp.confirm = function (message, o) { return dialog(Object.assign({ kind: 'confirm', message: message }, opts(o, 'Confirm'))); };
  pp.prompt = function (message, value, o) { return dialog(Object.assign({ kind: 'prompt', message: message, value: value }, opts(o, 'Save'))); };
})();
`;
}

function platformClientJs() {
  return `'use strict';
/* Branding + legal pages (client).
 *
 * Both must work with NO session: they render on the sign-in screen, before
 * anyone has authenticated.
 */
(function () {
  var cache = null, pending = null, pageCache = {};

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // If the endpoint is unreachable the sign-in screen still needs a legally
  // complete footer, so synthesise one rather than render an empty bar.
  function fallback() {
    var y = new Date().getFullYear();
    return {
      orgName: 'Application', legalName: '', year: y,
      copyright: '© ' + y + ' Application. All rights reserved.',
      logoUrl: null, faviconUrl: null,
      legal: [{ slug: 'privacy', title: 'Privacy Policy' }, { slug: 'terms', title: 'Terms & Conditions' }],
    };
  }
  function get() { return cache || fallback(); }

  function load(force) {
    if (cache && !force) return Promise.resolve(cache);
    if (pending && !force) return pending;
    pending = fetch('/api/branding', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { cache = (d && d.branding) || fallback(); pending = null; applyDocument(); return cache; })
      .catch(function () { cache = cache || fallback(); pending = null; return cache; });
    return pending;
  }

  function applyDocument() {
    var b = get();
    if (!b.faviconUrl) return;
    var link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.setAttribute('rel', 'icon'); document.head.appendChild(link); }
    if (link.getAttribute('href') !== b.faviconUrl) link.setAttribute('href', b.faviconUrl);
  }

  // The year is recomputed on every read rather than trusting the cached
  // projection: a kiosk or a tab left open can outlive New Year, and a footer
  // that silently claims the wrong year is exactly what nobody notices.
  function copyright() {
    var b = get(), y = new Date().getFullYear();
    if (b.copyright && b.year === y) return b.copyright;
    return '© ' + y + ' ' + (b.legalName || b.orgName || 'Application') + '. All rights reserved.';
  }

  function footerHtml() {
    var b = get();
    var links = (b.legal || []).map(function (l) {
      return '<button type="button" class="legal-link" data-legal="' + esc(l.slug) + '">' + esc(l.title) + '</button>';
    }).join('<span class="legal-sep" aria-hidden="true">·</span>');
    return '<div class="legal-footer"><div class="legal-links">' + links + '</div>' +
      '<div class="legal-copy">' + esc(copyright()) + '</div></div>';
  }

  /* Body markup is a deliberately tiny subset — "## " headings, "- " bullets,
     blank-line paragraphs — rendered by escaping FIRST and then wrapping. No raw
     HTML from the database ever reaches innerHTML, so an admin with page-edit
     rights cannot turn the (unauthenticated) privacy page into a script host. */
  function renderBody(text) {
    var lines = String(text || '').split('\\n'), out = [], para = [], bullets = [];
    function flushP() { if (para.length) { out.push('<p>' + esc(para.join(' ')) + '</p>'); para = []; } }
    function flushL() { if (bullets.length) { out.push('<ul>' + bullets.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>'); bullets = []; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (!ln) { flushP(); flushL(); continue; }
      if (ln.slice(0, 3) === '## ') { flushP(); flushL(); out.push('<h2>' + esc(ln.slice(3).trim()) + '</h2>'); continue; }
      if (ln.slice(0, 2) === '- ') { flushP(); bullets.push(ln.slice(2).trim()); continue; }
      flushL(); para.push(ln);
    }
    flushP(); flushL();
    return out.join('');
  }

  function renderPage(container, slug, onBack) {
    container.innerHTML = '<div class="legal-page"><div class="legal-inner">Loading…</div></div>';
    return Promise.all([load(), fetch('/api/legal/' + encodeURIComponent(slug), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })])
      .then(function (r) {
        var b = r[0], pg = r[1] && r[1].page;
        if (!pg) {
          container.innerHTML = '<div class="legal-page"><div class="legal-inner">' +
            '<button type="button" class="btn ghost" id="legalBack">← Back</button>' +
            '<p class="legal-meta">That page could not be loaded.</p></div></div>';
        } else {
          var revised = pg.updatedAt ? 'Last updated ' + new Date(pg.updatedAt).toLocaleDateString() : 'Standard terms — not yet customised';
          container.innerHTML = '<div class="legal-page"><div class="legal-inner">' +
            '<button type="button" class="btn ghost" id="legalBack">← Back</button>' +
            '<h1>' + esc(pg.title) + '</h1>' +
            '<p class="legal-meta">' + esc(b.legalName || b.orgName) + ' · ' + esc(revised) + '</p>' +
            '<div class="legal-body">' + renderBody(pg.body) + '</div>' +
            '<div class="legal-foot">' + esc(copyright()) + '</div></div></div>';
        }
        var back = container.querySelector('#legalBack');
        if (back && onBack) back.onclick = onBack;
      });
  }

  // AUTO-MOUNT the legal footer.
  //
  // This module's whole reason for working without a session is that the
  // copyright notice and the Privacy/Terms links belong on the SIGN-IN screen.
  // It exposed footerHtml() and left mounting to each page — and no page did
  // it, so on every generated app the sign-in screen carried neither. Found by
  // running the app's own Playwright suite against a real server.
  //
  // One mechanism, not two: every \`[data-legal-footer]\` element gets the
  // footer, on DOMContentLoaded and again once branding has actually loaded
  // (the first render uses the fallback so the screen is never legally bare
  // while a fetch is in flight).
  function mountFooters() {
    var slots = document.querySelectorAll('[data-legal-footer]');
    for (var i = 0; i < slots.length; i++) slots[i].innerHTML = footerHtml();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountFooters);
  else mountFooters();
  load().then(mountFooters).catch(function () {});

  // One delegated handler covers every footer on every screen.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-legal]') : null;
    if (!btn) return;
    e.preventDefault();
    var host = document.getElementById('legalHost') || document.body;
    var restore = host.innerHTML;
    renderPage(host, btn.getAttribute('data-legal'), function () { host.innerHTML = restore; });
  });

  window.Branding = {
    load: load, get: get, copyright: copyright, footerHtml: footerHtml, mountFooters: mountFooters,
    renderPage: renderPage, renderBody: renderBody,
    invalidate: function () { cache = null; pageCache = {}; },
  };
  load();
})();
`;
}

/* ---------------------------------------------------------------------------
   Theme + legal + responsive CSS, appended to public/base.css.
   --------------------------------------------------------------------------- */
function platformCss() {
  return `

/* ===================== Platform: theme, legal, footer =====================
   The palette is declared TWICE — :root and [data-theme="dark"] — and both set
   color-scheme so native controls and scrollbars follow.

   ONE RULE that is easy to get wrong: surfaces use var(--surface), never a
   hardcoded white. A literal #fff background stays white in dark mode. */
:root{
  --bg:#f5f8fc; --surface:#ffffff; --surface-2:#f7fafd;
  --ink:#12263f; --slate:#5a6b81; --line:#e2e8f1;
  --accent:#1466b8; --accent-ink:#0b5cad; --accent-soft:#e7f1fb;
  --danger:#d24545; --ok:#1f9d57;
  --shadow:0 1px 2px rgba(16,42,72,.06),0 8px 24px rgba(16,42,72,.07);
  color-scheme:light;
}
[data-theme="dark"]{
  --bg:#0d1725; --surface:#131f30; --surface-2:#18263a;
  --ink:#e8eef8; --slate:#9db0c6; --line:#243347;
  --accent:#4c9bea; --accent-ink:#7db4ea; --accent-soft:rgba(76,155,234,.16);
  --danger:#f07070; --ok:#4ac489;
  --shadow:0 1px 2px rgba(0,0,0,.35),0 8px 24px rgba(0,0,0,.45);
  color-scheme:dark;
}

body{background:var(--bg);color:var(--ink)}

.theme-toggle{
  display:inline-flex;align-items:center;justify-content:center;
  width:38px;height:38px;border:1px solid var(--line);border-radius:9px;
  background:var(--surface);color:var(--ink);cursor:pointer;padding:0;flex-shrink:0;
}
.theme-toggle:hover{background:var(--surface-2)}
.theme-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:1px}

/* Sign-in / shell footer: the notice reads as text, the pages are real buttons
   so they are keyboard- and touch-reachable. */
.legal-footer{display:flex;flex-direction:column;align-items:center;gap:6px;padding:22px 16px 18px;text-align:center}
.legal-links{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:2px}
.legal-link{background:none;border:none;color:var(--accent-ink);font:inherit;font-size:12.5px;font-weight:600;padding:8px 10px;border-radius:7px;cursor:pointer}
.legal-link:hover{background:var(--accent-soft);text-decoration:underline}
.legal-sep{color:var(--slate);font-size:12px}
.legal-copy{font-size:12px;color:var(--slate);line-height:1.5;max-width:520px}

.legal-page{min-height:100vh;background:var(--bg);padding:32px 20px 64px}
.legal-inner{max-width:760px;margin:0 auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:34px 38px 40px}
.legal-inner h1{font-size:27px;line-height:1.2}
.legal-meta{font-size:12.5px;color:var(--slate);margin:8px 0 22px;padding-bottom:18px;border-bottom:1px solid var(--line)}
.legal-body{font-size:14.5px;line-height:1.68}
.legal-body h2{font-size:16.5px;margin:26px 0 9px}
.legal-body h2:first-child{margin-top:0}
.legal-body p{margin:0 0 13px}
.legal-body ul{margin:0 0 14px;padding-left:20px}
.legal-body li{margin-bottom:7px}
.legal-foot{margin-top:30px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--slate)}

/* Mobile. Every interactive control clears a 44px touch target. */
@media(max-width:768px){
  .theme-toggle{width:44px;height:44px}
  .legal-link{min-height:44px;display:inline-flex;align-items:center}
  .legal-page{padding:0}
  .legal-inner{border:none;border-radius:0;box-shadow:none;min-height:100vh;padding:22px 18px 48px}
  .legal-inner h1{font-size:23px}
  button,[role=button],input,select,textarea{min-height:44px}
}
@media(max-width:400px){
  .legal-links{flex-direction:column;gap:0}
  .legal-sep{display:none}
}

@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{
    animation-duration:.01ms !important;animation-iteration-count:1 !important;
    transition-duration:.01ms !important;scroll-behavior:auto !important}
}
`;
}

// buildPlatformRoutes — the HTTP surface. Split out because it is the ONLY
// platform file that imports the auth component (for the permission catalog and
// the admin guard), so it ships with the auth wiring rather than the base
// scaffold. Emitting it unconditionally made a project provisioned WITHOUT the
// auth component fail `tsc` on a missing '../auth/index.js' — tsconfig compiles
// everything under src/, whether or not anything imports it.
// public/platform-admin.html fragment — the ADMIN UI for the platform's own
// features. Everything below existed only as API endpoints: an operator could
// not change the app's name, edit the privacy policy, upload a logo, issue an
// API key or turn on read-only SQL from inside the app they were handed.
//
// Injected into the admin console by scaffold-auth (adminHtml), driven by
// platform-admin.js. Both are platform-owned, so they ride the upgrade path.
function platformAdminMarkup() {
  return `
  <div class="card sect">
    <div class="card-h"><h3>Branding</h3></div>
    <div class="card-b">
      <p class="note">The application's name and marks. These appear on the sign-in screen,
      in the footer and in the browser tab.</p>
      <div class="field"><label for="pf-org">Application name</label>
        <input id="pf-org" type="text" maxlength="120" autocomplete="off"></div>
      <div class="field"><label for="pf-legal">Legal entity name</label>
        <input id="pf-legal" type="text" maxlength="160" autocomplete="off"></div>
      <div class="field"><label for="pf-mark">Rights mark</label>
        <select id="pf-mark"><option value="">none</option><option value="(R)">registered</option><option value="TM">trademark</option></select></div>
      <div class="field"><label for="pf-year">Copyright start year</label>
        <input id="pf-year" type="number" min="1900" max="2200" inputmode="numeric"></div>
      <div class="field"><label for="pf-context">What this application is for</label>
        <textarea id="pf-context" rows="3" maxlength="2000"></textarea>
        <span class="hint">Shown to people who are new to it, and kept current as features are added.</span></div>
      <p><button class="btn" id="pf-save">Save branding</button></p>
      <p class="note" id="pf-note"></p>
    </div>
  </div>

  <div class="card sect">
    <div class="card-h"><h3>Privacy policy &amp; terms</h3></div>
    <div class="card-b">
      <p class="note">Linked from the sign-in screen and the footer. Edit the text for this application;
      reset restores the generic starting version.</p>
      <div class="tabs" id="pf-legal-tabs">
        <button class="btn subtle sm" data-slug="privacy" aria-pressed="true">Privacy policy</button>
        <button class="btn subtle sm" data-slug="terms" aria-pressed="false">Terms &amp; conditions</button>
      </div>
      <div class="field"><label for="pf-page-title">Title</label>
        <input id="pf-page-title" type="text" maxlength="160"></div>
      <div class="field"><label for="pf-page-body">Body</label>
        <textarea id="pf-page-body" rows="12"></textarea></div>
      <p><button class="btn" id="pf-page-save">Save page</button>
         <button class="btn subtle" id="pf-page-reset">Reset to default</button></p>
      <p class="note" id="pf-page-note"></p>
    </div>
  </div>

  <div class="card sect">
    <div class="card-h"><h3>Images &amp; assets</h3><span class="badge b-info" id="pf-assets-count"></span></div>
    <div class="card-b">
      <p class="note">The logo, the favicon (falls back to the logo) and any image the application shows.</p>
      <div class="field"><label for="pf-upload">Add an image</label>
        <input id="pf-upload" type="file" accept="image/*"></div>
      <div class="field"><label for="pf-upload-kind">Use it as</label>
        <select id="pf-upload-kind"><option value="image">an image</option><option value="logo">the logo</option><option value="favicon">the favicon</option></select></div>
      <div class="table-scroll">
        <table class="list">
          <thead><tr><th>Preview</th><th>Name</th><th>Kind</th><th>Size</th><th></th></tr></thead>
          <tbody id="pf-assets-body"></tbody>
        </table>
      </div>
      <p class="note" id="pf-assets-note"></p>
    </div>
  </div>

  <div class="card sect">
    <div class="card-h"><h3>API keys</h3><span class="badge b-info" id="pf-keys-count"></span></div>
    <div class="card-b">
      <p class="note">Let another application call this one. A key is shown ONCE, when it is created —
      it is stored only as a hash, so it cannot be shown again.</p>
      <div class="field"><label for="pf-key-name">Name the key</label>
        <input id="pf-key-name" type="text" maxlength="120" placeholder="e.g. Reporting service"></div>
      <p><button class="btn" id="pf-key-create">Create key</button></p>
      <p class="note" id="pf-key-token" hidden></p>
      <div class="table-scroll">
        <table class="list">
          <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
          <tbody id="pf-keys-body"></tbody>
        </table>
      </div>
      <p class="note" id="pf-keys-note"></p>
    </div>
  </div>

  <div class="card sect">
    <div class="card-h"><h3>Read-only database access</h3></div>
    <div class="card-b">
      <p class="note">A reporting tool can read curated views directly over SQL when that is faster than
      the API. READ ONLY: it can never write, and it sees only the views listed below — actions still go
      through the API.</p>
      <div class="switch"><input type="checkbox" id="pf-ro-enabled"><label for="pf-ro-enabled">Allow read-only SQL access</label></div>
      <p class="note" id="pf-ro-status"></p>
      <div class="field"><label for="pf-ro-url">Connection string</label>
        <input id="pf-ro-url" type="text" readonly></div>
      <p class="note" id="pf-ro-views"></p>
    </div>
  </div>
` + pushAdminMarkup();
}

// public/platform-admin.js — drives the platform admin cards against
// /api/admin/*. Vanilla JS, no build step, same shape as admin.js: every
// fetch rides the httpOnly session cookie.
function platformAdminJs() {
  return `'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  if (!$('pf-save')) return; // the platform cards are not on this page

  function note(el, msg, bad) {
    var n = $(el); if (!n) return;
    n.textContent = msg || '';
    n.className = 'note' + (bad ? ' err' : '');
  }
  async function api(path, opts) {
    var r = await fetch('/api/admin' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
    var body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    if (!r.ok) throw new Error((body && body.message) || ('Request failed (' + r.status + ')'));
    return body;
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtDate(s) { return s ? String(s).slice(0, 16).replace('T', ' ') : '—'; }

  // ---- branding + legal + assets all come from GET /branding ----
  var pages = {}, currentSlug = 'privacy';

  async function loadBranding() {
    var d = await api('/branding');
    var b = d.branding || d;
    $('pf-org').value = b.orgName || '';
    $('pf-legal').value = b.legalName || '';
    $('pf-mark').value = b.rightsMark || '';
    $('pf-year').value = b.copyrightStartYear || '';
    var ctx = b.appContext || {};
    $('pf-context').value = typeof ctx === 'string' ? ctx : (ctx.summary || '');
    pages = {};
    (d.pages || []).forEach(function (p) { pages[p.slug] = p; });
    showPage(currentSlug);
    renderAssets(d.assets || []);
  }

  $('pf-save').addEventListener('click', async function () {
    note('pf-note', 'Saving…');
    try {
      await api('/branding', { method: 'PUT', body: JSON.stringify({
        orgName: $('pf-org').value.trim(),
        legalName: $('pf-legal').value.trim(),
        rightsMark: $('pf-mark').value,
        copyrightStartYear: Number($('pf-year').value) || undefined,
        appContext: { summary: $('pf-context').value.trim() },
      }) });
      note('pf-note', 'Saved. The sign-in screen and footer update on next load.');
    } catch (e) { note('pf-note', e.message, true); }
  });

  // ---- legal pages ----
  function showPage(slug) {
    currentSlug = slug;
    var p = pages[slug] || { title: '', body: '' };
    $('pf-page-title').value = p.title || '';
    $('pf-page-body').value = p.body || '';
    var btns = $('pf-legal-tabs').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-slug') === slug ? 'true' : 'false');
    }
    note('pf-page-note', '');
  }
  $('pf-legal-tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-slug]');
    if (b) showPage(b.getAttribute('data-slug'));
  });
  $('pf-page-save').addEventListener('click', async function () {
    note('pf-page-note', 'Saving…');
    try {
      await api('/branding/pages/' + currentSlug, { method: 'PUT', body: JSON.stringify({
        title: $('pf-page-title').value.trim(), body: $('pf-page-body').value,
      }) });
      await loadBranding();
      note('pf-page-note', 'Saved.');
    } catch (e) { note('pf-page-note', e.message, true); }
  });
  $('pf-page-reset').addEventListener('click', async function () {
    if (!await pp.confirm('Replace this page with the generic starting text?')) return;
    try {
      await api('/branding/pages/' + currentSlug + '/reset', { method: 'POST' });
      await loadBranding();
      note('pf-page-note', 'Reset to the default text.');
    } catch (e) { note('pf-page-note', e.message, true); }
  });

  // ---- assets ----
  function renderAssets(list) {
    var body = $('pf-assets-body');
    body.textContent = '';
    $('pf-assets-count').textContent = list.length + (list.length === 1 ? ' asset' : ' assets');
    list.forEach(function (a) {
      var tr = document.createElement('tr');
      var img = document.createElement('img');
      img.src = '/api/assets/' + a.id;
      img.alt = a.alt || a.name;
      img.style.cssText = 'max-width:44px;max-height:44px;border-radius:6px';
      var tdImg = document.createElement('td'); tdImg.appendChild(img);
      tr.appendChild(tdImg);
      [a.name, a.kind, fmtBytes(a.size)].forEach(function (v) {
        var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      });
      var td = document.createElement('td');
      var del = document.createElement('button');
      del.className = 'btn subtle sm'; del.textContent = 'Remove';
      del.addEventListener('click', async function () {
        if (!await pp.confirm('Remove "' + a.name + '"?')) return;
        try { await api('/branding/assets/' + a.id, { method: 'DELETE' }); await loadBranding(); }
        catch (e) { note('pf-assets-note', e.message, true); }
      });
      td.appendChild(del); tr.appendChild(td);
      body.appendChild(tr);
    });
  }
  $('pf-upload').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      note('pf-assets-note', 'Uploading…');
      try {
        await api('/branding/assets', { method: 'POST', body: JSON.stringify({
          name: file.name, mime: file.type || 'application/octet-stream',
          data: String(reader.result).split(',')[1] || '',
          kind: $('pf-upload-kind').value,
        }) });
        $('pf-upload').value = '';
        await loadBranding();
        note('pf-assets-note', 'Uploaded.');
      } catch (e) { note('pf-assets-note', e.message, true); }
    };
    reader.readAsDataURL(file);
  });

  // ---- API keys ----
  async function loadKeys() {
    try {
      var d = await api('/api-keys');
      var list = d.keys || d || [];
      var body = $('pf-keys-body');
      body.textContent = '';
      $('pf-keys-count').textContent = list.length + (list.length === 1 ? ' key' : ' keys');
      list.forEach(function (k) {
        var tr = document.createElement('tr');
        [k.name, fmtDate(k.createdAt), fmtDate(k.lastUsedAt)].forEach(function (v) {
          var td = document.createElement('td'); td.textContent = v || '—'; tr.appendChild(td);
        });
        var td = document.createElement('td');
        if (!k.revokedAt) {
          var b = document.createElement('button');
          b.className = 'btn subtle sm'; b.textContent = 'Revoke';
          b.addEventListener('click', async function () {
            if (!await pp.confirm('Revoke "' + k.name + '"? Anything using it stops working immediately.')) return;
            try { await api('/api-keys/' + k.id, { method: 'DELETE' }); await loadKeys(); }
            catch (e) { note('pf-keys-note', e.message, true); }
          });
          td.appendChild(b);
        } else {
          td.textContent = 'revoked';
        }
        tr.appendChild(td);
        body.appendChild(tr);
      });
    } catch (e) { note('pf-keys-note', e.message, true); }
  }
  $('pf-key-create').addEventListener('click', async function () {
    var name = $('pf-key-name').value.trim();
    if (!name) { note('pf-keys-note', 'Give the key a name first.', true); return; }
    try {
      var d = await api('/api-keys', { method: 'POST', body: JSON.stringify({ name: name }) });
      var t = $('pf-key-token');
      t.hidden = false;
      t.textContent = 'Copy this now — it is not shown again: ' + (d.token || d.key || '');
      $('pf-key-name').value = '';
      await loadKeys();
    } catch (e) { note('pf-keys-note', e.message, true); }
  });

  // ---- read-only SQL ----
  async function loadReadonly() {
    try {
      var d = await api('/db/readonly');
      $('pf-ro-enabled').checked = !!d.enabled;
      $('pf-ro-url').value = d.connectionUrl || d.url || '';
      note('pf-ro-status', d.enabled ? 'Enabled.' : 'Not enabled.');
      var views = d.views || [];
      $('pf-ro-views').textContent = views.length
        ? 'Readable views: ' + views.map(function (v) { return v.name || v; }).join(', ')
        : 'No views are exposed yet.';
    } catch (e) { note('pf-ro-status', e.message, true); }
  }
  $('pf-ro-enabled').addEventListener('change', async function () {
    var on = this.checked;
    note('pf-ro-status', on ? 'Enabling…' : 'Disabling…');
    try {
      await api('/db/readonly', { method: on ? 'POST' : 'DELETE' });
      await loadReadonly();
    } catch (e) { this.checked = !on; note('pf-ro-status', e.message, true); }
  });

  loadBranding().catch(function (e) { note('pf-note', e.message, true); });
  loadKeys();
  loadReadonly();
})();
`;
}

export function buildPlatformRoutes() {
  return [{ path: 'src/platform/routes.ts', content: platformRoutesTs() }];
}

// buildPlatformFiles — the auth-independent half, always emitted.
export function buildPlatformFiles() {
  return [
    { path: 'src/platform/schema.ts', content: platformSchemaTs() },
    { path: 'src/platform/branding.ts', content: brandingTs() },
    { path: 'src/platform/api-keys.ts', content: apiKeysTs() },
    { path: 'src/platform/api-key-auth.ts', content: apiKeyAuthTs() },
    { path: 'src/platform/readonly.ts', content: readonlyTs() },
    // Web Push + the app-install invitation: platform-owned because three RFCs
    // of silent-failure crypto is not something a build should be re-deriving.
    { path: 'src/platform/push.ts', content: pushTs() },
    { path: 'public/push.js', content: pushClientJs() },
    { path: 'migrations/0100_platform.sql', content: platformMigrationSql() },
    { path: 'public/theme.js', content: themeJs() },
    { path: 'public/platform.js', content: platformClientJs() + platformDialogsJs() },
    { path: 'public/platform-admin.js', content: platformAdminJs() },
  ];
}

// The admin markup is injected into the console page by scaffold-auth rather
// than shipped as its own file, so it lands inside the existing layout.
export { platformAdminMarkup };

export const PLATFORM_CSS = platformCss() + PUSH_CSS;
