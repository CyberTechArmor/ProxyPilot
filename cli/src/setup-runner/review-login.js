// Host runner — the review-account login the application-owned credential
// check signs in with. Read on the HOST from the registry database
// (mock2.db, next to the backend's database) and decrypted with the
// installation's at-rest key from .env, exactly as the backend does
// (mock2/review-account.js). It exists only in memory, for one script; it is
// never written to a job row, an event or the journal.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnvFile } from '../recovery/install.js';

// hostReviewLogin({ dbPath, envPath, openDb }) → async (container) → { email, password } | null
export function hostReviewLogin({ dbPath, envPath, openDb = null, log = () => {} }) {
  const mock2Path = join(dirname(dbPath), 'mock2.db');
  return async (container) => {
    let env = new Map();
    try { env = parseEnvFile(readFileSync(envPath, 'utf8')); } catch { /* no .env: no key */ }
    const key = env.get('TOTP_ENCRYPTION_KEY');
    if (!key) { log('reviewLogin', 'TOTP_ENCRYPTION_KEY absent; cannot decrypt the review login'); return null; }
    if (!process.env.TOTP_ENCRYPTION_KEY) process.env.TOTP_ENCRYPTION_KEY = key;
    let db;
    try {
      if (openDb) db = await openDb(mock2Path);
      else {
        const { default: Database } = await import('better-sqlite3');
        db = new Database(mock2Path, { readonly: true, fileMustExist: true });
      }
    } catch (e) { log('reviewLogin', `no registry database at ${mock2Path}: ${e?.message || e}`); return null; }
    try {
      const row = db.prepare(`SELECT review_login_email, review_login_password_enc FROM mock2_projects WHERE container_name = ?`).get(String(container));
      if (!row?.review_login_email || !row?.review_login_password_enc) return null;
      const { decryptSecret } = await import('../../../admin/backend/src/lib/secrets.js');
      const password = decryptSecret(row.review_login_password_enc);
      return password ? { email: row.review_login_email, password } : null;
    } catch (e) {
      log('reviewLogin', `could not read the review login: ${e?.message || e}`);
      return null;
    } finally {
      try { db.close(); } catch { /* */ }
    }
  };
}
