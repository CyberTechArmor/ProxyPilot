import { showEntry } from '../../core/ssh-access/index.js';
import * as output from '../../output.js';

export async function showCommand(id, _opts, globalOpts) {
  try {
    const row = showEntry(id);
    if (globalOpts.json) {
      output.json({ ok: true, entry: row });
      return;
    }
    output.info(`id:           ${row.id}`);
    output.info(`unix user:    ${row.unix_user}`);
    output.info(`label:        ${row.device_label ?? '—'}`);
    output.info(`fingerprint:  ${row.fingerprint}`);
    output.info(`public key:   ${row.public_key}`);
    output.info(`added:        ${row.added_at} by ${row.added_by ?? '—'}`);
    if (row.revoked_at) {
      output.info(`revoked:      ${row.revoked_at} by ${row.revoked_by ?? '—'} reason=${row.revoked_reason ?? '—'}`);
    } else {
      output.info(`revoked:      no`);
    }
    output.info(`last seen:    ${row.last_seen_at ?? '—'}`);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`ssh access show failed: ${e.message}`);
    process.exitCode = 1;
  }
}
