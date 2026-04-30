import { list } from '../../core/firewall/index.js';
import * as output from '../../output.js';

function pickFilter(opts) {
  if (opts.enabled) return 'enabled';
  if (opts.needsReview) return 'needs-review';
  if (opts.all) return 'all';
  return 'all';
}

function fmtPort(r) {
  if (r.port_end && r.port_end !== r.port_start) return `${r.port_start}-${r.port_end}`;
  return String(r.port_start);
}

export async function listCommand(opts, globalOpts) {
  const filter = pickFilter(opts);
  let rules = list(filter);

  // Default ordering: needs-review first, then enabled, then disabled.
  rules.sort((a, b) => {
    const rank = (r) => {
      if (!r.enabled && r._section !== 'base') return 0; // needs review
      if (r.enabled) return 1;
      return 2;
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });

  if (globalOpts.json) {
    output.json(rules);
    return;
  }

  if (rules.length === 0) {
    output.info(`No rules match filter '${filter}'`);
    return;
  }

  const headers = ['id', 'source', 'container', 'process', 'port', 'proto', 'scope', 'on', 'reason'];
  const rows = rules.map(r => [
    r.id,
    r._section,
    r.container ?? '-',
    r.process ?? '-',
    fmtPort(r),
    r.proto,
    r.source_cidrs ? `${r.scope}*` : r.scope,
    r.enabled ? 'yes' : 'no',
    r.reason ?? '-',
  ]);
  output.table(headers, rows);
}
