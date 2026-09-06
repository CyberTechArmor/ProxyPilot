// Lean BEAF Pro — data-source Connections (placeholder).
//
// This is the surface where the metrics band's real feeds will eventually be
// wired up. Nothing here runs a live integration yet: each source can be
// marked connected / disconnected with an endpoint + note, saved as placeholder
// config. Every member can see the wiring state; only an admin can change it.
// Mobile-first per MOBILE_FIRST.md.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, ArrowLeft, Plug, CheckCircle2, CircleSlash } from 'lucide-react';

function ConnectionCard({ source, isAdmin, onSaved }) {
  const { toast } = useToast();
  const [status, setStatus] = useState(source.status);
  const [endpoint, setEndpoint] = useState(source.endpoint || '');
  const [notes, setNotes] = useState(source.notes || '');
  const [saving, setSaving] = useState(false);

  const connected = source.status === 'connected';
  const dirty = status !== source.status
    || (endpoint || '') !== (source.endpoint || '')
    || (notes || '') !== (source.notes || '');

  const save = async () => {
    setSaving(true);
    try {
      await api.lbpSaveConnection(source.key, { status, endpoint: endpoint.trim() || null, notes: notes.trim() || null });
      toast({ title: 'Connection saved', description: `${source.label} · ${status === 'connected' ? 'connected' : 'disconnected'} (placeholder)` });
      onSaved?.();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not save', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start gap-2">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${connected ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}>
          <Plug className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-sm">{source.label}</b>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{source.category}</span>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${connected ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-muted text-muted-foreground'}`}>
              {connected ? <CheckCircle2 className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
              {connected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{source.description}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Feeds: <span className="font-semibold">{source.feeds.join(', ')}</span>
          </p>
        </div>
      </div>

      {isAdmin ? (
        <div className="mt-3 space-y-3 border-t pt-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor={`ep-${source.key}`}>Endpoint / host (placeholder)</Label>
              <Input id={`ep-${source.key}`} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="e.g. https://ehr.internal/api" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor={`nt-${source.key}`}>Notes</Label>
              <Input id={`nt-${source.key}`} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Owner, credentials location, …" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-lg border bg-muted/40 p-0.5">
              {['connected', 'disconnected'].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
                    status === s ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
                  }`}
                >
                  {s === 'connected' ? 'Connected' : 'Disconnected'}
                </button>
              ))}
            </div>
            <Button className="ml-auto h-10" onClick={save} disabled={saving || !dirty}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
            </Button>
          </div>
          {source.updated_at && (
            <p className="text-[11px] text-muted-foreground">
              Last changed {new Date(source.updated_at).toLocaleString()}{source.updated_by ? ` · ${source.updated_by}` : ''}
            </p>
          )}
        </div>
      ) : (
        source.notes && <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">{source.notes}</p>
      )}
    </div>
  );
}

export default function LbpConnections() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [connections, setConnections] = useState(null);
  const [err, setErr] = useState('');
  const isAdmin = user?.role === 'admin';

  const load = useCallback(() => {
    api.lbpConnections().then((d) => setConnections(d.connections || [])).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div>
        <button type="button" onClick={() => navigate('/lean-beaf')} className="mb-2 inline-flex items-center gap-1 text-sm font-semibold text-muted-foreground">
          <ArrowLeft className="h-4 w-4" /> Projects
        </button>
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Plug className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight">Connections</h1>
            <p className="text-xs text-muted-foreground">Where the dashboard metrics get their data · placeholder — no live sync yet</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
        The business-metrics band on the dashboard is showing <b>sample numbers</b>. These connections are a placeholder for
        wiring up the real feeds — saving one records intent but does not sync any data yet.
        {!isAdmin && ' Only an admin can change connections.'}
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}
      {!connections && !err && <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}

      {connections && connections.map((source) => (
        <ConnectionCard key={source.key} source={source} isAdmin={isAdmin} onSaved={load} />
      ))}
    </div>
  );
}
