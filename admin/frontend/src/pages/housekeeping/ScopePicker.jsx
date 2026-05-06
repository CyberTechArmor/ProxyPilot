// Per-service backup scope picker.
//
// Two modes:
//   * 'all'  → no filter, packer grabs everything in the chosen
//              tier (legacy default).
//   * 'pick' → multi-select against the registered services.
//              Resulting body field on submit is a JSON-stringified
//              { service_ids: [...] }.
//
// Only meaningful for tier=config_plus_data + tier=full — the
// config tier captures dashboard state (DB / .env / cve-inbox)
// which is not per-service.  Parent decides whether to render
// this component based on the selected tier.

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

// Public API:
//   value          either null/'' for 'all', or a JSON-stringified
//                  { service_ids: [...] }.  Matches what the
//                  backend stores in the scope column.
//   onChange(v)    fires with the same shape on every selection.
export default function ScopePicker({ value, onChange, disabled }) {
  const [services, setServices] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Parse the incoming JSON shape into an in-memory Set so the
  // checkboxes render in O(1).  An empty set + mode='all' is the
  // legacy default.
  const parsed = (() => {
    if (!value || value === 'all') return { mode: 'all', ids: new Set() };
    try {
      const obj = JSON.parse(value);
      if (Array.isArray(obj?.service_ids) && obj.service_ids.length > 0) {
        return { mode: 'pick', ids: new Set(obj.service_ids) };
      }
    } catch { /* fall through */ }
    return { mode: 'all', ids: new Set() };
  })();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.backupsScopeOptions();
        if (!cancelled) setServices(r.services || []);
      } catch (err) {
        if (!cancelled) setLoadError(err?.message || 'failed to load services');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setMode = (mode) => {
    if (mode === 'all') {
      onChange(null);
    } else {
      // Switching to 'pick' with no selections yet keeps the
      // legacy 'all' semantics until the operator checks at
      // least one service — better than silently switching to
      // 'pack nothing' (which the backend treats as all anyway).
      onChange(parsed.ids.size > 0
        ? JSON.stringify({ service_ids: [...parsed.ids] })
        : null);
    }
  };

  const toggle = (id) => {
    const next = new Set(parsed.ids);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next.size > 0
      ? JSON.stringify({ service_ids: [...next] })
      : null);
  };

  return (
    <div className="space-y-1.5">
      <Label>Scope</Label>
      <div className="flex gap-2 flex-wrap">
        <Button
          type="button" size="sm"
          variant={parsed.mode === 'all' ? 'default' : 'outline'}
          onClick={() => setMode('all')}
          disabled={disabled}
        >
          All services
        </Button>
        <Button
          type="button" size="sm"
          variant={parsed.mode === 'pick' ? 'default' : 'outline'}
          onClick={() => setMode('pick')}
          disabled={disabled}
        >
          Pick services
        </Button>
      </div>

      {parsed.mode === 'pick' && (
        <div className="border rounded p-2 max-h-40 overflow-y-auto text-xs">
          {loadError && <p className="text-red-500">{loadError}</p>}
          {!loadError && services === null && <p className="text-muted-foreground">Loading…</p>}
          {services && services.length === 0 && (
            <p className="text-muted-foreground italic">No services registered.</p>
          )}
          {(services || []).map((s) => (
            <label
              key={s.id}
              className={`flex items-center gap-2 py-1 ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-muted/40 rounded px-1'}`}
            >
              <input
                type="checkbox"
                checked={parsed.ids.has(s.id)}
                onChange={() => toggle(s.id)}
                disabled={disabled}
              />
              <span className="font-medium truncate flex-1">{s.name}</span>
              <span className="text-muted-foreground font-mono text-[10px]">
                {s.kind === 'static_site' ? 'static' : (s.runtime || 'proxy')}
                {s.lxc_container_name ? ` · ${s.lxc_container_name}` : ''}
                {s.container_name ? ` · ${s.container_name}` : ''}
              </span>
            </label>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Filters which per-service file roots, Docker volumes, and Incus instances land
        in the artifact. The dashboard's own state (SQLite + .env + cve-inbox) is always
        included.
      </p>
    </div>
  );
}
