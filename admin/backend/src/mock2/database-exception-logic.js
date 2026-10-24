// Mock2 — "no SQLite without an explicit request" (app foundation, 2026-10).
// PURE decision layer: no I/O, no native modules (risk R9).
//
// PostgreSQL with pgvector, from the application foundation, is the only
// application database (constitution §2; docs/features/app-foundation.md
// "No SQLite without an explicit request"). Builds drifted to SQLite anyway,
// because the only check ran in full builds, read only `src/` import lines and
// never package.json, and the prompts barely said it. This module is the one
// place the rule's words, the engine list and the exception's shape live, so
// the prompts, the finish guard, the command policy and the routes cannot say
// different things. The `constitution-lint` gate (framework-seed/gates.json) is
// POSIX sh and cannot import this; the ratchet tests run it against the same
// engine samples as classifyEngineSpecifier so the two stay in step.
//
// THE EXCEPTION. The person records, on the project, that they explicitly asked
// for SQLite, in their own words (mock2_database_exceptions, migration 565;
// PUT /api/mock2/projects/:id/database-exception, sudo, audited). It is read
// from mock2.db by the host only: the gate learns it through
// MOCK2_DATABASE_EXCEPTION, which runGateBattery sets on the command line from
// that record. Nothing the build writes into the repository can create it, and
// no MCP tool sets it.
//
// Terminology (risk R7): nothing here is named "agent".

// The one rule, word for word, wherever a builder reads instructions.
export const DATABASE_RULE = 'Database: PostgreSQL with pgvector, from the application foundation, is the only database. '
  + 'Never switch to SQLite or another engine. If PostgreSQL is unreachable, report it and stop — do not work around it. '
  + 'Files and embeddings go through the foundation adapters in foundation/.';

// Where a person records the exception (shown in every refusal).
export const DATABASE_EXCEPTION_UI_PATH = 'Dev Studio → Foundation → Database exception';

// The env var the host sets on the gate command line. Never read from a file.
export const DATABASE_EXCEPTION_ENV = 'MOCK2_DATABASE_EXCEPTION';

// Engines a person can except. Only SQLite: every other engine stays refused.
export const DATABASE_EXCEPTION_ENGINES = Object.freeze(['sqlite']);
export const REQUEST_TEXT_MIN = 10;
export const REQUEST_TEXT_MAX = 2000;

// The refusal text shared by the gate, the finish guard and the command policy.
export function databaseRefusalText(found = '') {
  const f = String(found || '').trim();
  return 'PostgreSQL (with pgvector, from the application foundation) is the only application database (constitution §2).'
    + (f ? ` Found: ${f}.` : '')
    + ` If the user explicitly asked for SQLite, they record it on the project (${DATABASE_EXCEPTION_UI_PATH}); a build cannot.`;
}

// ---- the engine list ----
//
// A module specifier (an import / require / dynamic import() target) or a
// package.json dependency name. Relative and absolute paths are never engines:
// a local file called sqlite-store.ts is caught by what IT imports.
//
// `family: 'sqlite'` is what a recorded SQLite exception allows. "sqlite"
// anywhere in a package specifier covers sqlite3, better-sqlite3, sqlite,
// node:sqlite, bun:sqlite, @types/better-sqlite3, expo-sqlite, op-sqlite,
// wa-sqlite, connect-sqlite3 and drizzle-orm's better-sqlite3 / sqlite-core /
// bun-sqlite / expo-sqlite / op-sqlite / sqlite-proxy drivers. libsql / Turso,
// sql.js and Cloudflare D1 are SQLite under another name.
const ENGINE_RULES = Object.freeze([
  {
    engine: 'SQLite', family: 'sqlite',
    re: /sqlite|^@libsql\/|^libsql(?:$|\/)|^sql\.js(?:$|\/)|^drizzle-orm\/(?:libsql|d1|sql-js)(?:$|\/)/i,
  },
  // PGlite is Postgres compiled to WASM inside the app process: not the
  // foundation database, and a second copy of the data.
  { engine: 'PGlite', family: 'other', re: /^(?:@electric-sql\/pglite|drizzle-orm\/pglite)(?:$|\/)/i },
  {
    engine: 'MySQL', family: 'other',
    re: /^(?:mysql2?|drizzle-orm\/(?:mysql2|mysql-core|mysql-proxy|planetscale-serverless|tidb-serverless|singlestore(?:-core|-proxy)?))(?:$|\/)/i,
  },
  { engine: 'MongoDB', family: 'other', re: /^(?:mongoose|mongodb)(?:$|\/)/i },
  // Drizzle is the only data-access layer (constitution §2).
  { engine: 'another ORM', family: 'other', re: /^(?:typeorm|sequelize|knex|prisma|@prisma\/[^/]+)(?:$|\/)/i },
]);

// classifyEngineSpecifier(spec) → null | { name, engine, family }
export function classifyEngineSpecifier(spec) {
  const s = String(spec || '').trim();
  if (!s || s.startsWith('.') || s.startsWith('/')) return null;
  for (const r of ENGINE_RULES) {
    if (r.re.test(s)) return { name: s, engine: r.engine, family: r.family };
  }
  return null;
}

// Does a recorded exception allow this hit?
export function exceptionAllows(hit, exception) {
  const engine = typeof exception === 'string' ? exception : exception?.engine;
  return !!hit && hit.family === 'sqlite' && engine === 'sqlite';
}

// ---- reading source and package.json (the finish guard's half; the gate is sh) ----

// Files whose content is scanned. Docs (.md) are never read: a sentence about
// SQLite is not a dependency on it.
export const ENGINE_SOURCE_RE = /\.(?:[cm]?[jt]sx?)$/i;
export const DATABASE_URL_FILE_RE = /(?:\.(?:[cm]?[jt]sx?|json|ya?ml|toml|sh)|(?:^|\/)\.env[^/]*)$/i;
// Directories the scan never enters (generated, vendored, or the platform's own state/).
export const ENGINE_SCAN_EXCLUDE_RE = /(?:^|\/)(?:node_modules|dist|build|coverage|\.git)(?:\/|$)|^state\//;

const COMMENT_LINE_RE = /^\s*(?:\/\/|\/?\*|#)/;
// from 'x' · import 'x' · import('x') · require('x') — a specifier has no spaces.
const SPECIFIER_RE = /(?:^|[^A-Za-z0-9_$.])(?:from|require|import)\s*\(?\s*['"`]([^'"`\s]+)['"`]/g;
// DATABASE_URL set to a SQLite URL (sqlite: or file:) on the same line.
const DATABASE_URL_SQLITE_RE = /DATABASE_URL.*[=:'"`]\s*['"`]?(?:sqlite|file):/;

// sourceEngineHits(path, text) → [{ path, line, name, engine, family, key }]
export function sourceEngineHits(path, text) {
  const p = String(path || '');
  if (ENGINE_SCAN_EXCLUDE_RE.test(p)) return [];
  const out = [];
  const lines = String(text || '').split('\n');
  const scanSpecifiers = ENGINE_SOURCE_RE.test(p);
  const scanUrl = DATABASE_URL_FILE_RE.test(p);
  lines.forEach((line, i) => {
    if (COMMENT_LINE_RE.test(line)) return;
    if (scanSpecifiers) {
      for (const m of line.matchAll(SPECIFIER_RE)) {
        const c = classifyEngineSpecifier(m[1]);
        if (c) out.push({ path: p, line: i + 1, ...c, key: `spec:${c.name}` });
      }
    }
    if (scanUrl && DATABASE_URL_SQLITE_RE.test(line)) {
      out.push({ path: p, line: i + 1, name: 'DATABASE_URL', engine: 'SQLite', family: 'sqlite', key: 'url:DATABASE_URL' });
    }
  });
  return out;
}

const DEPENDENCY_BLOCKS = Object.freeze(['dependencies', 'devDependencies', 'optionalDependencies']);

// packageEngineHits(path, text) → hits for each refused dependency name. A
// package.json that does not parse yields one hit: an unreadable manifest is
// not a clean one.
export function packageEngineHits(path, text) {
  const p = String(path || '');
  if (ENGINE_SCAN_EXCLUDE_RE.test(p)) return [];
  if (!String(text || '').trim()) return [];
  let doc;
  try { doc = JSON.parse(String(text)); } catch {
    return [{ path: p, line: null, name: 'package.json', engine: 'an unreadable package.json', family: 'other', key: 'pkg:unparseable' }];
  }
  const out = [];
  for (const block of DEPENDENCY_BLOCKS) {
    const deps = doc && typeof doc === 'object' ? doc[block] : null;
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      const c = classifyEngineSpecifier(name);
      if (c) out.push({ path: p, line: null, ...c, block, key: `dep:${c.name}` });
    }
  }
  // DATABASE_URL=file:… inside an npm script is the same drift.
  return [...out, ...sourceEngineHits(p, text).filter((h) => h.key === 'url:DATABASE_URL')];
}

export function fileEngineHits(path, text) {
  return /(?:^|\/)package\.json$/i.test(String(path || '')) ? packageEngineHits(path, text) : sourceEngineHits(path, text);
}

// introducedEngineHits({ files: [{ path, base, current }], exception })
// → the refused-engine hits in `current` that `base` (the file at HEAD) did
// not already have, minus what a recorded exception allows. Pre-existing
// engines are the gate's business; this answers "did THIS build add one?".
export function introducedEngineHits({ files = [], exception = null } = {}) {
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    const had = new Set(fileEngineHits(f.path, f.base || '').map((h) => h.key));
    const seen = new Set();
    for (const h of fileEngineHits(f.path, f.current || '')) {
      if (had.has(h.key) || seen.has(h.key)) continue;
      seen.add(h.key);
      if (exceptionAllows(h, exception)) continue;
      out.push(h);
    }
  }
  return out;
}

export function describeEngineHit(h) {
  const where = h.line ? `${h.path}:${h.line}` : h.path;
  if (h.key === 'url:DATABASE_URL') return `${where} DATABASE_URL is a SQLite (sqlite:/file:) URL`;
  if (h.key === 'pkg:unparseable') return `${where} does not parse, so its dependencies cannot be checked`;
  return `${where} ${h.block ? `${h.block} ` : ''}${h.name} (${h.engine})`;
}

export function describeEngineHits(hits = [], max = 12) {
  const list = (Array.isArray(hits) ? hits : []).map(describeEngineHit);
  return list.length > max ? `${list.slice(0, max).join('; ')}; … ${list.length - max} more` : list.join('; ');
}

// ---- the exception record ----

// validateExceptionInput(body) → { ok: true, value: { engine, request_text } }
//                              | { ok: false, code, error }
export function validateExceptionInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!DATABASE_EXCEPTION_ENGINES.includes(b.engine)) {
    return { ok: false, code: 'ENGINE_NOT_EXCEPTABLE', error: 'engine must be "sqlite" — no other database can be excepted' };
  }
  if (b.acknowledge !== true) {
    return { ok: false, code: 'ACKNOWLEDGE_REQUIRED', error: 'acknowledge: true is required — the person confirms they explicitly asked for SQLite' };
  }
  if (typeof b.request_text !== 'string') {
    return { ok: false, code: 'REQUEST_TEXT_REQUIRED', error: 'request_text (the user\'s own words asking for SQLite) is required' };
  }
  // Keep the person's words; drop control characters other than newline/tab.
  const text = b.request_text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (text.length < REQUEST_TEXT_MIN || text.length > REQUEST_TEXT_MAX) {
    return { ok: false, code: 'REQUEST_TEXT_LENGTH', error: `request_text must be ${REQUEST_TEXT_MIN}–${REQUEST_TEXT_MAX} characters (the user's own words)` };
  }
  return { ok: true, value: { engine: b.engine, request_text: text } };
}

// The API shape. A row with an engine this revision does not know is not an
// exception (fail closed).
export function shapeException(row) {
  if (!row || !DATABASE_EXCEPTION_ENGINES.includes(row.engine)) return null;
  return {
    engine: row.engine,
    request_text: String(row.request_text || ''),
    recorded_by: row.recorded_by == null ? null : String(row.recorded_by),
    created_at: row.created_at || null,
  };
}

// The value runGateBattery puts on the gate command line: 'sqlite' or ''.
// Assigned on EVERY gate run (empty when nothing is recorded), so an
// environment the build could have touched never decides it.
export function gateExceptionValue(exception) {
  return shapeException(exception)?.engine || '';
}

function recordedDate(createdAt) {
  const m = String(createdAt || '').match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : 'date unknown';
}

// The line the build prompt carries: the rule, or the quoted request.
export function databaseRuleLine(exception) {
  const e = shapeException(exception);
  if (!e) return DATABASE_RULE;
  const words = e.request_text.replace(/\s+/g, ' ').trim();
  return `Database: The user explicitly asked for SQLite: "${words}" (recorded ${recordedDate(e.created_at)}). `
    + 'That recorded request allows SQLite for this project; every other engine is still refused, and files and '
    + 'embeddings still go through the foundation adapters in foundation/.';
}
