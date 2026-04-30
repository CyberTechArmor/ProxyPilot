import { listEntries } from '../../core/ssh-access/index.js';
import * as output from '../../output.js';

function fmtRelative(iso) {
  if (!iso) return '—';
  const ageSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

function shortFp(fp) {
  if (!fp) return '';
  if (fp.length <= 24) return fp;
  return fp.slice(0, 18) + '...' + fp.slice(-3);
}

export async function listCommand(opts, globalOpts) {
  try {
    const filter = opts.all ? 'all' : opts.revoked ? 'revoked' : 'active';
    const rows = listEntries({ filter });

    if (globalOpts.json) {
      output.json({ ok: true, filter, entries: rows });
      return;
    }

    if (rows.length === 0) {
      output.info(`no ${filter} ssh-access entries`);
      return;
    }

    const tableRows = rows.map(r => [
      r.id,
      r.unix_user,
      r.device_label ?? '',
      shortFp(r.fingerprint),
      fmtRelative(r.added_at),
      r.added_by ?? '',
      r.revoked_at ? `revoked ${fmtRelative(r.revoked_at)}` : 'active',
      fmtRelative(r.last_seen_at),
    ]);
    output.table(
      ['ID', 'USER', 'LABEL', 'FINGERPRINT', 'ADDED', 'BY', 'STATUS', 'LAST SEEN'],
      tableRows,
    );
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`ssh access list failed: ${e.message}`);
    process.exitCode = 1;
  }
}
