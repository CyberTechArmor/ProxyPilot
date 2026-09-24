// `proxypilot recover` — the non-destructive root recovery command.
//
//   proxypilot recover status
//   proxypilot recover admin <username> --password [--totp] [--unlock] …
//   proxypilot recover admin <username> --create --password
//
// Runs on the host as root, over SSH or the console, against the backend's
// live SQLite file — it needs neither the dashboard, nor Docker, nor any
// identity provider to be up. It changes rows for ONE named account (the
// plan in src/recovery/plan.js) and touches nothing else: no other account,
// no application data, no .env, no encryption key.
//
// The new password never appears on a command line: it comes from
// --password-file, --password-stdin, or is generated and printed once.
// Nothing secret is written to the audit row or to this command's output
// except that one-time print.

import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';
import { resolveInstall } from '../recovery/install.js';
import { planRecovery, applyRecovery, accountInventory, ACTIONS, RecoveryChangedError } from '../recovery/plan.js';
import { generatePassword, hashPassword, readPasswordSource, validatePassword } from '../recovery/password.js';
import * as output from '../output.js';

export const EXIT = Object.freeze({ OK: 0, ERROR: 1, REFUSED: 2, NOT_ROOT: 3 });

class RecoverExit extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

async function defaultOpenDb(dbPath) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { fileMustExist: true, timeout: 5000 });
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

function defaultDeps() {
  return {
    openDb: defaultOpenDb,
    getuid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
    isTTY: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
    hostname: () => os.hostname(),
    tty: () => { try { return fs.readlinkSync('/proc/self/fd/0'); } catch { return null; } },
    now: () => new Date().toISOString(),
    confirm: async (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try { return (await rl.question(question)).trim(); } finally { rl.close(); }
    },
    stdout: (line) => console.log(line),
    fs,
  };
}

function actionsFromOptions(opts) {
  const map = { password: 'password', totp: 'totp', unlock: 'unlock', passkeys: 'passkeys', revokeMcpKeys: 'revoke-mcp-keys', promote: 'promote', create: 'create' };
  const out = Object.entries(map).filter(([k]) => opts[k]).map(([, v]) => v);
  // A supplied password is a password action even without the bare flag.
  if ((opts.passwordFile || opts.passwordStdin) && !out.includes('password')) out.unshift('password');
  return out;
}

function requireRoot(deps) {
  if (deps.getuid() !== 0) {
    throw new RecoverExit(EXIT.NOT_ROOT, 'root recovery must run as root on the ProxyPilot host (sudo proxypilot recover …)');
  }
}

// backupDatabase(db, dbPath, deps) → backup path. A consistent copy taken by
// SQLite itself (VACUUM INTO), next to the database, readable by root only.
export function backupDatabase(db, dbPath, deps) {
  const stamp = deps.now().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dest = `${dbPath}.recovery-${stamp}.bak`;
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  try { deps.fs.chmodSync(dest, 0o600); } catch { /* best effort on odd filesystems */ }
  return dest;
}

function describeStep(s) {
  switch (s.step) {
    case 'create-local-admin': return `create local administrator '${s.username}' (${s.details})`;
    case 'set-password': return `set a new password${s.details ? ` — ${s.details}` : ''}`;
    case 'clear-totp': return `clear the second factor — ${s.details}`;
    case 'unlock': return `clear the lockout (${s.failedAttempts} failed attempts${s.lockedUntil ? `, locked until ${s.lockedUntil}` : ''})`;
    case 'promote': return `promote from '${s.from}' to '${s.to}'`;
    case 'delete-passkeys': return `delete ${s.count} passkey(s)`;
    case 'revoke-mcp-keys': return `revoke ${s.count} MCP key(s)`;
    case 'revoke-sessions': return `revoke ${s.count} live session(s), closing ${s.sudoGrants} elevation grant(s)`;
    case 'forget-trusted-devices': return `forget ${s.count} trusted device(s) that skip TOTP`;
    default: return s.step;
  }
}

// recoverAdminCommand(username, opts, globalOpts, deps) → exit code. `deps`
// is for the suite (a node:sqlite handle, a fake uid, a scripted prompt).
export async function recoverAdminCommand(username, opts = {}, globalOpts = {}, depsIn = {}) {
  const deps = { ...defaultDeps(), ...depsIn };
  const json = !!globalOpts.json;
  const say = (line) => { if (!json) deps.stdout(line); };
  let db = null;
  try {
    requireRoot(deps);
    const install = resolveInstall({ installDir: opts.installDir, envPath: opts.env, dbPath: opts.db }, deps.fs);
    if (!install.ok) throw new RecoverExit(EXIT.REFUSED, install.message);
    const actions = actionsFromOptions(opts);
    db = await deps.openDb(install.dbPath);
    const plan = planRecovery(db, { username, actions });
    if (!plan.ok) {
      if (json) deps.stdout(JSON.stringify({ ok: false, refused: plan.refusals, warnings: plan.warnings, database: install.dbPath }, null, 2));
      else for (const r of plan.refusals) output.error(r.message);
      return EXIT.REFUSED;
    }

    say(`Database: ${install.dbPath}`);
    say(`Account:  ${plan.username}${plan.account ? ` (${plan.account.auth_source || 'local'} ${plan.account.role}${plan.account.has_totp ? ', TOTP enrolled' : ', no TOTP'}${plan.account.has_password ? '' : ', NO PASSWORD'})` : ' (new local administrator)'}`);
    say('Plan:');
    for (const s of plan.steps) say(`  - ${describeStep(s)}`);
    for (const w of plan.warnings) output.warn(w);
    say('Untouched: every other account, all application data, the .env and its encryption keys.');

    if (opts.dryRun) {
      if (json) deps.stdout(JSON.stringify({ ok: true, dryRun: true, plan: { username: plan.username, mode: plan.mode, steps: plan.steps, warnings: plan.warnings }, database: install.dbPath }, null, 2));
      else output.info('Dry run: nothing was changed.');
      return EXIT.OK;
    }

    if (!opts.yes) {
      if (!deps.isTTY()) throw new RecoverExit(EXIT.REFUSED, 'no terminal to confirm on; re-run with --yes to apply this plan');
      const typed = await deps.confirm(`Type the username to apply this plan (${plan.username}): `);
      if (typed !== plan.username) throw new RecoverExit(EXIT.REFUSED, 'confirmation did not match; nothing was changed');
    }

    let passwordHash = null;
    let generated = null;
    let passwordSource = null;
    if (plan.steps.some((s) => s.step === 'set-password')) {
      const src = await readPasswordSource({ file: opts.passwordFile, stdin: opts.passwordStdin }, deps);
      passwordSource = src.source;
      let pw = src.password;
      if (pw == null) { pw = generatePassword(); generated = pw; }
      const v = validatePassword(pw);
      if (!v.ok) throw new RecoverExit(EXIT.REFUSED, v.reason);
      passwordHash = await hashPassword(pw);
    }

    let backup = null;
    if (opts.backup !== false) {
      backup = backupDatabase(db, install.dbPath, deps);
      say(`Backup:   ${backup}`);
    }

    const result = applyRecovery(db, plan, {
      passwordHash,
      now: deps.now(),
      invokedBy: { uid: deps.getuid(), host: deps.hostname(), tty: deps.tty() },
    });

    const loginUrl = install.domain ? `https://${install.domain}` : null;
    const next = [];
    if (plan.steps.some((s) => s.step === 'set-password')) next.push('sign in with the password below and change it when asked');
    if (plan.steps.some((s) => s.step === 'clear-totp' || s.step === 'create-local-admin')) next.push('enrol a new authenticator when the login asks for TOTP setup');
    next.push('re-prove (sudo) before the next destructive action — every elevation grant was closed');

    if (json) {
      deps.stdout(JSON.stringify({
        ok: true,
        username: plan.username,
        mode: plan.mode,
        applied: result.applied,
        audit: result.audit.id,
        backup,
        database: install.dbPath,
        loginUrl,
        passwordSource,
        // The generated password reaches the operator only here, once.
        ...(generated ? { password: generated } : {}),
        next,
      }, null, 2));
    } else {
      output.success(`Recovered '${plan.username}' — audit ${result.audit.id}`);
      for (const a of result.applied) say(`  ${a.step}: ${a.changes} row(s)`);
      if (generated) {
        say('');
        say(`  Username: ${plan.username}`);
        say(`  Password: ${generated}`);
        say('  (shown once; not stored anywhere in the clear)');
        say('');
      } else if (passwordSource) {
        say(`  Password taken from ${passwordSource}.`);
      }
      if (loginUrl) say(`Sign in at ${loginUrl}`);
      for (const n of next) say(`  - ${n}`);
    }
    return EXIT.OK;
  } catch (e) {
    if (e instanceof RecoverExit) {
      if (json) deps.stdout(JSON.stringify({ ok: false, error: e.message }));
      else output.error(e.message);
      return e.exitCode;
    }
    if (e instanceof RecoveryChangedError) {
      if (json) deps.stdout(JSON.stringify({ ok: false, error: e.message, code: e.code }));
      else output.error(`${e.message}; nothing was changed — re-run to plan again`);
      return EXIT.REFUSED;
    }
    if (json) deps.stdout(JSON.stringify({ ok: false, error: e.message }));
    else output.error(`recovery failed: ${e.message}`);
    return EXIT.ERROR;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// recoverStatusCommand(opts, globalOpts, deps) → exit code. Read-only.
export async function recoverStatusCommand(opts = {}, globalOpts = {}, depsIn = {}) {
  const deps = { ...defaultDeps(), ...depsIn };
  const json = !!globalOpts.json;
  let db = null;
  try {
    requireRoot(deps);
    const install = resolveInstall({ installDir: opts.installDir, envPath: opts.env, dbPath: opts.db }, deps.fs);
    if (!install.ok) throw new RecoverExit(EXIT.REFUSED, install.message);
    db = await deps.openDb(install.dbPath);
    const inv = accountInventory(db);
    if (!inv.ok) throw new RecoverExit(EXIT.REFUSED, `this database is missing ${inv.schema.missing.join(', ')}; not a ProxyPilot backend database at the current schema`);
    if (json) {
      deps.stdout(JSON.stringify({ ok: true, database: install.dbPath, env: install.envPath, envPresent: install.envPresent, hasTotpKey: install.hasTotpKey, hasJwtSecret: install.hasJwtSecret, ...inv, schema: undefined }, null, 2));
      return EXIT.OK;
    }
    deps.stdout(`Database: ${install.dbPath}`);
    deps.stdout(`Env:      ${install.envPath}${install.envPresent ? '' : ' (missing)'}${install.hasTotpKey ? '' : ' — TOTP_ENCRYPTION_KEY not set'}`);
    output.table(
      ['USERNAME', 'ROLE', 'SOURCE', 'PASSWORD', 'TOTP', 'LOCKED', 'SESSIONS', 'PASSKEYS', 'MCP KEYS'],
      inv.accounts.map((a) => [a.username, a.role, a.authSource, a.hasPassword ? 'set' : 'NONE', a.hasTotp ? 'enrolled' : 'none', a.locked ? 'yes' : 'no', a.activeSessions ?? '-', a.passkeys ?? '-', a.mcpKeys ?? '-'])
    );
    if (inv.setupExposed.length) output.warn(`administrator(s) with no password — initial-setup requires a root-issued installation credential: ${inv.setupExposed.join(', ')}. Run: proxypilot recover admin <name> --password`);
    if (!inv.localAdmins.length) output.warn('no local administrator exists; with the directory down, nobody can sign in. Run: proxypilot recover admin <name> --create --password');
    return EXIT.OK;
  } catch (e) {
    if (e instanceof RecoverExit) {
      if (json) deps.stdout(JSON.stringify({ ok: false, error: e.message }));
      else output.error(e.message);
      return e.exitCode;
    }
    if (json) deps.stdout(JSON.stringify({ ok: false, error: e.message }));
    else output.error(`status failed: ${e.message}`);
    return EXIT.ERROR;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export const RECOVERY_ACTIONS = ACTIONS;

// Safe unattended installer entrypoint: only issues installation proof for an
// unclaimed account. Existing-account recovery retains its separate ceremony.
export async function recoverBootstrapCommand(username,opts={},depsIn={}) {
  const deps={...defaultDeps(),...depsIn};let db;
  try{
    requireRoot(deps);
    const install=resolveInstall({installDir:opts.installDir,envPath:opts.env,dbPath:opts.db},deps.fs);
    if(!install.ok)throw new Error(install.message);
    db=await deps.openDb(install.dbPath);
    const {issueBootstrap}=await import('../recovery/bootstrap.js');
    const issued=issueBootstrap(db,username,{directory:deps.bootstrapDirectory||'/run/proxypilot-bootstrap'});
    deps.stdout(`Installation credential file: ${issued.credentialFile}`);
    deps.stdout(`Valid until ${issued.expiresAt}. Read it locally as root, enter it in setup, then remove the file. Issuing again retires the previous credential.`);
    return EXIT.OK;
  }catch(e){deps.stdout(e.message);return e.exitCode || EXIT.REFUSED;}finally{db?.close();}
}
