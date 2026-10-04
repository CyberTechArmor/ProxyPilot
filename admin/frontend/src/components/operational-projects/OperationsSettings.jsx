import { useCallback, useEffect, useId, useState } from 'react';
import { operationsSettingsApi } from '@/lib/api';
import { Action, Panel } from './shared';
import { operationsToggleLabel } from './run-readiness';

const when = iso => { if (!iso) return ''; const d = new Date(`${iso}`.includes('T') ? iso : `${iso}Z`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };

// Administrators only. Each switch requires the ones before it; a change asks
// for sudo (the api client opens the prompt) and is audited on the server.
export function OperationsSettings({ onChanged }) {
  const [state, setState] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const load = useCallback(async () => {
    try { setState(await operationsSettingsApi.get()); setError(''); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function change(toggle, enabled) {
    if (busy) return;
    setBusy(toggle.name); setError(''); setMessage('');
    try {
      const changed = await operationsSettingsApi.set(toggle.name, enabled);
      setState(previous => ({ ...changed, ...(previous?.source_memory ? { source_memory: previous.source_memory } : {}) }));
      setMessage(`${operationsToggleLabel(toggle)} turned ${enabled ? 'on' : 'off'}.`);
      window.dispatchEvent(new Event('pp-operations-changed'));
      await onChanged?.();
    } catch (e) {
      setError(e.status === 401 ? 'Sudo was not confirmed, so nothing changed.' : e.message);
    } finally { setBusy(''); }
  }
  async function setupSourceMemory() {
    if (busy) return;
    setBusy('source_memory'); setError(''); setMessage('');
    try {
      const changed = await operationsSettingsApi.setupSourceMemory(); setState(changed);
      setMessage(changed.source_memory?.state === 'reload_required' ? 'Private storage verified. The owner must restart the dashboard backend to activate Source Memory.'
        : changed.source_memory?.state === 'available' ? 'Private Source Memory is active.'
        : changed.source_memory?.message || 'Private Source Memory is unavailable. The owner must inspect it.');
      await onChanged?.();
    } catch (e) { setError(e.status === 401 ? 'Sudo was not confirmed, so nothing changed.' : e.message); }
    finally { setBusy(''); }
  }
  return <Panel title="Operations settings">
    <p className="text-sm">Administrators turn these on for everyone on this installation. Each needs the one above it. A change asks for your sudo confirmation and is recorded in the audit log.</p>
    {error && <p role="alert" className="text-destructive break-words">{error}</p>}
    <p role="status" aria-live="polite" className="text-sm">{busy ? 'Working…' : message}</p>
    {!state ? <p role="status">Loading settings…</p> : <ul className="space-y-3">{state.toggles.map(toggle =>
      <Toggle key={toggle.name} toggle={toggle} busy={!!busy} labels={Object.fromEntries(state.toggles.map(t => [t.name, operationsToggleLabel(t)]))}
        onChange={enabled => change(toggle, enabled)}/>)}</ul>}
    {state?.source_memory && <section className="rounded-md border p-3 min-w-0 space-y-3" aria-label="Source Memory setup">
      <div><h3 className="font-medium">Private Source Memory</h3><p className="text-sm break-words">{state.source_memory.state === 'available' ? 'Available · private storage is active.' : state.source_memory.state === 'reload_required' ? 'Verified · owner backend restart required before Source Memory is available.' : state.source_memory.state === 'not_configured' ? 'Not configured · public browsing remains available.' : state.source_memory.message}</p></div>
      {state.source_memory.can_setup && <>
        <p className="text-sm break-words">Review and enable the fixed local private directory for this installation. This explicit action reviews the default storage boundary while preserving the existing environment file. It verifies ownership, permissions and writing, reading, checksum and deletion before saving approval.</p>
        <p className="text-sm break-words">256 MiB installation quota; accounts and projects are capped at 128 MiB. Existing retention, source disclosure and action approvals still apply. This does not configure image or PDF parsers or start work.</p>
        <Action disabled={!!busy} className="w-full sm:w-auto sm:min-h-11" onClick={setupSourceMemory}>Review and enable local Source Memory</Action>
      </>}
      {state.source_memory.state === 'reload_required' && <p className="text-sm text-muted-foreground break-words">Ask the installation owner to restart the dashboard backend, or perform the ordinary app update that restarts it. Refresh this page afterward and check readiness. Refreshing the browser alone does not activate storage.</p>}
    </section>}
  </Panel>;
}

function Toggle({ toggle, busy, labels, onChange }) {
  const hint = useId();
  const label = operationsToggleLabel(toggle);
  const status = toggle.effective ? 'On' : toggle.stored ? `On, but waiting for ${toggle.blocked_by.map(n => labels[n]).join(' and ')}` : 'Off';
  const blocked = !toggle.stored && toggle.blocked_by.length > 0;
  return <li className="rounded-md border p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
    <div className="min-w-0 space-y-1">
      <p className="font-medium break-words">{label} · <span className={toggle.effective ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}>{status}</span></p>
      <p className="text-sm break-words">{toggle.description}</p>
      <p id={hint} className="text-sm text-muted-foreground break-words">
        {blocked ? `Turn on ${toggle.blocked_by.map(n => labels[n]).join(' and ')} first.`
          : toggle.last_change ? `Last changed ${when(toggle.last_change.at)} by ${toggle.last_change.by.username ?? 'an administrator'}.` : 'Never changed.'}
      </p>
    </div>
    <Action className="sm:shrink-0" variant={toggle.stored ? 'outline' : 'default'} disabled={busy || blocked} aria-describedby={hint}
      aria-label={`${toggle.stored ? 'Turn off' : 'Turn on'} ${label}`} onClick={() => onChange(!toggle.stored)}>
      {toggle.stored ? 'Turn off' : 'Turn on'}
    </Action>
  </li>;
}
