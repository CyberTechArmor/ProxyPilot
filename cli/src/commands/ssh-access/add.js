import fs from 'node:fs';
import { addEntry } from '../../core/ssh-access/index.js';
import * as output from '../../output.js';

/**
 * Read the public key from --pubkey. The flag accepts:
 *   - "-"          read from stdin (this is what the bootstrap script
 *                  heredoc form expects)
 *   - <path>       read from a file
 *   - <inline>     treat the value as the literal pubkey
 */
async function resolvePubkey(arg) {
  if (!arg) {
    throw new Error('--pubkey is required (path, "-" for stdin, or the literal key)');
  }
  if (arg === '-') {
    return await new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', chunk => { buf += chunk; });
      process.stdin.on('end', () => resolve(buf));
      process.stdin.on('error', reject);
    });
  }
  if (arg.startsWith('ssh-') || arg.startsWith('ecdsa-') || arg.startsWith('sk-')) {
    return arg;
  }
  // Treat as a path. Don't fall through to "literal" if the file exists
  // is missing — surface a clear error rather than feeding a non-key
  // string into ssh-keygen.
  if (!fs.existsSync(arg)) {
    throw new Error(`--pubkey: not a path and not a recognised key prefix: "${arg.slice(0, 40)}..."`);
  }
  return fs.readFileSync(arg, 'utf-8');
}

export async function addCommand(id, opts, globalOpts) {
  try {
    if (!opts.user) throw new Error('--user is required');
    const pubkey = await resolvePubkey(opts.pubkey);
    const result = await addEntry({
      id,
      unixUser: opts.user,
      pubkey,
      label: opts.label ?? null,
    });

    if (globalOpts.json) {
      output.json({
        ok: true,
        id: result.id,
        unix_user: result.unix_user,
        fingerprint: result.fingerprint,
        device_label: result.device_label,
        added_at: result.added_at,
        reconcile: result.reconcile,
      });
      return;
    }

    output.success(`ssh-access "${id}" added  user=${result.unix_user}  fingerprint=${result.fingerprint}`);
    const userInfo = result.reconcile.users.find(u => u.user === result.unix_user);
    if (userInfo?.changed) {
      output.info(`authorized_keys for ${result.unix_user} rewritten (${userInfo.before_count} → ${userInfo.after_count} managed lines)`);
    }
    for (const w of result.reconcile.warnings) {
      output.warn(`reconcile warning [${w.unix_user}]: ${w.message}`);
    }
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`ssh access add failed: ${e.message}`);
    process.exitCode = 1;
  }
}
