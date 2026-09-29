import { useCallback, useEffect, useId, useState } from 'react';
import { operationsSettingsApi } from '@/lib/api';
import { Action, Panel } from './shared';

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
      setState(await operationsSettingsApi.set(toggle.name, enabled));
      setMessage(`${toggle.label} turned ${enabled ? 'on' : 'off'}.`);
      window.dispatchEvent(new Event('pp-operations-changed'));
      await onChanged?.();
    } catch (e) {
      setError(e.status === 401 ? 'Sudo was not confirmed, so nothing changed.' : e.message);
    } finally { setBusy(''); }
  }
  return <Panel title="Operations settings">
    <p className="text-sm">Administrators turn these on for everyone on this installation. Each needs the one above it. A change asks for your sudo confirmation and is recorded in the audit log.</p>
    {error && <p role="alert" className="text-destructive break-words">{error}</p>}
    <p role="status" aria-live="polite" className="text-sm">{busy ? 'Working…' : message}</p>
    {!state ? <p role="status">Loading settings…</p> : <ul className="space-y-3">{state.toggles.map(toggle =>
      <Toggle key={toggle.name} toggle={toggle} busy={!!busy} labels={Object.fromEntries(state.toggles.map(t => [t.name, t.label]))}
        onChange={enabled => change(toggle, enabled)}/>)}</ul>}
  </Panel>;
}

function Toggle({ toggle, busy, labels, onChange }) {
  const hint = useId();
  const status = toggle.effective ? 'On' : toggle.stored ? `On, but waiting for ${toggle.blocked_by.map(n => labels[n]).join(' and ')}` : 'Off';
  const blocked = !toggle.stored && toggle.blocked_by.length > 0;
  return <li className="rounded-md border p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
    <div className="min-w-0 space-y-1">
      <p className="font-medium break-words">{toggle.label} · <span className={toggle.effective ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}>{status}</span></p>
      <p className="text-sm break-words">{toggle.description}</p>
      <p id={hint} className="text-sm text-muted-foreground break-words">
        {blocked ? `Turn on ${toggle.blocked_by.map(n => labels[n]).join(' and ')} first.`
          : toggle.last_change ? `Last changed ${when(toggle.last_change.at)} by ${toggle.last_change.by.username ?? 'an administrator'}.` : 'Never changed.'}
      </p>
    </div>
    <Action className="sm:shrink-0" variant={toggle.stored ? 'outline' : 'default'} disabled={busy || blocked} aria-describedby={hint}
      aria-label={`${toggle.stored ? 'Turn off' : 'Turn on'} ${toggle.label}`} onClick={() => onChange(!toggle.stored)}>
      {toggle.stored ? 'Turn off' : 'Turn on'}
    </Action>
  </li>;
}
