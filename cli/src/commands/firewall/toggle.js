import { enable, disable, setScope, addManual, removeManual, addServiceL4, removeServiceL4, list } from '../../core/firewall/index.js';
import { reconcile } from '../../core/firewall/index.js';
import * as output from '../../output.js';

function fmtPort(r) {
  return r.port_end && r.port_end !== r.port_start ? `${r.port_start}-${r.port_end}` : String(r.port_start);
}

/**
 * Run a toggle followed by a reconcile. The toggle writes state; the
 * reconcile applies it. We surface reconcile-time problems (lockout
 * check, nft errors) so the operator doesn't see "rule changed" while
 * silently leaving the live ruleset stale.
 */
function surfaceRuleWarnings(result) {
  const w = result?._warnings;
  if (!Array.isArray(w)) return;
  for (const line of w) output.warn(line);
}

async function applyAndReconcile({ result, action, globalOpts }) {
  let rec;
  try {
    rec = await reconcile({});
  } catch (err) {
    output.warn(`State updated but reconcile threw: ${err.message}`);
    if (globalOpts.json) output.json({ ok: false, action, rule: result, reconcile_error: err.message });
    process.exitCode = 1;
    return;
  }

  if (globalOpts.json) {
    output.json({
      ok: rec.ok && rec.applied,
      action,
      rule: result,
      warnings: [...(result?._warnings ?? []), ...(rec.warnings ?? [])],
      reconcile: {
        applied: rec.applied,
        checksum: rec.checksum,
        rule_count: rec.ruleCount,
        rejection: rec.rejection ?? null,
      },
    });
    if (!rec.ok || !rec.applied) process.exitCode = 1;
    return;
  }

  surfaceRuleWarnings(result);
  for (const w of (rec.warnings ?? [])) output.warn(w);
  if (rec.ok && rec.applied) {
    output.success(`${action} ${result.id} → reconciled (${rec.ruleCount} rules, ${rec.checksum})`);
  } else if (!rec.ok) {
    output.warn(`${action} ${result.id} written but reconcile rejected: ${rec.rejection?.reason ?? 'unknown'}`);
    if (rec.rejection?.rules) for (const r of rec.rejection.rules) output.warn(`  ${r.id}: scope=${r.scope}`);
    process.exitCode = 1;
  }
}

export async function enableCommand(id, opts, globalOpts) {
  const sourceCidrs = (opts.sourceCidr ?? []);
  const scope = opts.scope ?? null;

  // Confirmation when opening to the public internet, unless --yes.
  if (!opts.yes && !globalOpts.json && (scope === 'public' || (scope === null && (() => {
    // scope unchanged → look up current
    const cur = list('all').find(r => r.id === id);
    return cur && cur.scope === 'public' && (!sourceCidrs || sourceCidrs.length === 0);
  })()))) {
    const cur = list('all').find(r => r.id === id);
    if (!cur) {
      output.error(`No rule with id ${id}`);
      process.exitCode = 1;
      return;
    }
    const { confirm } = await import('../../output.js');
    const ok = await confirm(`Open ${cur.container ?? 'host'}/${cur.process ?? '?'} ${fmtPort(cur)}/${cur.proto} to the public internet?`);
    if (!ok) {
      output.info('Aborted.');
      return;
    }
  }

  let result;
  try {
    result = enable({ id, scope, sourceCidrs, service: opts.service });
  } catch (err) {
    output.error(err.message);
    process.exitCode = 1;
    return;
  }
  await applyAndReconcile({ result, action: 'enable', globalOpts });
}

export async function disableCommand(id, opts, globalOpts) {
  let result;
  try {
    result = disable({ id });
  } catch (err) {
    output.error(err.message);
    process.exitCode = 1;
    return;
  }
  await applyAndReconcile({ result, action: 'disable', globalOpts });
}

export async function setScopeCommand(id, scope, opts, globalOpts) {
  const sourceCidrs = opts.sourceCidr ?? [];
  let result;
  try {
    result = setScope({ id, scope, sourceCidrs, service: opts.service });
  } catch (err) {
    output.error(err.message);
    process.exitCode = 1;
    return;
  }
  await applyAndReconcile({ result, action: 'set-scope', globalOpts });
}

export async function addManualCommand(opts, globalOpts) {
  const port = parseInt(opts.port, 10);
  const portEnd = opts.portEnd != null ? parseInt(opts.portEnd, 10) : null;
  let result;
  try {
    result = addManual({
      port,
      portEnd,
      proto: opts.proto,
      scope: opts.scope,
      reason: opts.reason,
      sourceCidrs: opts.sourceCidr ?? [],
      service: opts.service,
    });
  } catch (err) {
    output.error(err.message);
    process.exitCode = 1;
    return;
  }
  await applyAndReconcile({ result, action: 'add-manual', globalOpts });
}

export async function removeManualCommand(id, opts, globalOpts) {
  let result;
  try {
    result = removeManual({ id });
  } catch (err) {
    output.error(err.message);
    process.exitCode = 1;
    return;
  }
  await applyAndReconcile({ result, action: 'remove-manual', globalOpts });
}

/**
 * Machine-managed L4 forward rule add/remove. Called only by the
 * admin backend's L4 reconciler — operators never touch these
 * commands directly. The operator-supplied id namespace
 * (`service-l4-<forward_id>`) is enforced in the core function so
 * the admin can compute add/remove pairs without first looking up
 * the row.
 */
export async function addServiceL4Command(opts, globalOpts) {
  const port = parseInt(opts.port, 10);
  const portEnd = opts.portEnd != null ? parseInt(opts.portEnd, 10) : null;
  let result;
  try {
    result = addServiceL4({
      id: opts.id,
      port,
      portEnd,
      proto: opts.proto,
      scope: opts.scope,
      reason: opts.reason,
      sourceCidrs: opts.sourceCidr ?? [],
      service: opts.service,
    });
  } catch (err) {
    output.error(err.message);
    process.exitCode = 1;
    return;
  }
  await applyAndReconcile({ result, action: 'add-service-l4', globalOpts });
}

export async function removeServiceL4Command(id, opts, globalOpts) {
  let result;
  try {
    result = removeServiceL4({ id });
  } catch (err) {
    // NOT_FOUND is recoverable — the reconciler treats "already gone"
    // as success so partial cleanup paths converge. Surface as ok:true
    // in JSON mode so the admin doesn't error out on idempotent retries.
    if (err.code === 'NOT_FOUND' && globalOpts.json) {
      output.json({ ok: true, action: 'remove-service-l4', rule: { id }, already_absent: true });
      return;
    }
    output.error(err.message);
    process.exitCode = 1;
    return;
  }
  await applyAndReconcile({ result, action: 'remove-service-l4', globalOpts });
}
