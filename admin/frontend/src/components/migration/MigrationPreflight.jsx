// Migrations → Readiness. The four things that decide whether a source host
// can be adopted at all: an agent build to download, a URL to call back, the
// certificate the agent pins, and — only for incus-migrate — whether Incus
// listens on the network.
//
// The listener is the one check with a fix the product can perform, so it has
// a button. The address it proposes is the Incus BRIDGE GATEWAY: guests and
// LAN hosts can reach it, the internet cannot. A bind on every interface is
// refused by the server unless the operator says the source really is out
// there (allow_public), and this panel only offers that tick box once the
// address typed would actually be a public bind.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, Network, RefreshCw } from 'lucide-react';
import { BTN, Checkbox, Chip, Notice, SectionHeader } from '@/components/migration/shared';

const LEVEL = { pass: 'ok', warn: 'warn', fail: 'fail' };
const TRANSPORT_NOTE = {
  'incus-migrate': 'whole-machine, from a physical host or a VM',
  'rootfs-tar': 'whole-machine, from a container (Proxmox LXC)',
  'file-sync': 'application mode',
};

/** Would this address bind on every interface, public ones included? */
export function isPublicBind(address) {
  const host = String(address || '').trim().replace(/:\d+$/, '');
  return host === '' || host === '0.0.0.0' || host === '::' || host === '[::]' || host === '*';
}

export default function MigrationPreflight({ onChanged }) {
  const { toast } = useToast();
  const [pf, setPf] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [allowPublic, setAllowPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const r = await api.migrations.preflight();
      setPf(r);
      setAddress((a) => a || r?.incus?.suggested || '');
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? (e.body?.error || e.message) : e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // A failure is worth seeing without being asked for; a clean report is not.
  useEffect(() => { if (pf?.summary?.fail) setOpen(true); }, [pf?.summary?.fail]);

  const enable = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.migrations.incusListener({ address: address.trim() || undefined, allowPublic });
      setDone(r);
      toast({
        title: r.already ? `Incus already listens on ${r.address}` : `Incus now listens on ${r.address}`,
        description: r.reverse_with ? `Undo with: ${r.reverse_with}` : undefined,
      });
      await load({ quiet: true });
      onChanged?.();
    } catch (e) {
      setError(e instanceof ApiError ? (e.body?.error || e.message) : e.message);
    } finally { setBusy(false); }
  };

  const summary = pf?.summary || { pass: 0, warn: 0, fail: 0 };
  const listening = pf?.incus?.listening;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-2 flex-wrap text-left min-h-[44px] min-w-0"
            aria-expanded={open}
          >
            {open ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
            <span className="font-medium">Readiness</span>
            {loading && !pf ? <Loader2 className="h-4 w-4 animate-spin" /> : (
              <span className="flex flex-wrap gap-1.5">
                {summary.fail > 0 && <Chip level="fail">{summary.fail} blocking</Chip>}
                {summary.warn > 0 && <Chip level="warn">{summary.warn} to know about</Chip>}
                {summary.fail === 0 && summary.warn === 0 && <Chip level="ok">all clear</Chip>}
              </span>
            )}
          </button>
          <Button variant="outline" className={BTN} onClick={() => load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />Re-check
          </Button>
        </div>

        {error && <Notice level="error"><p className="break-words">{error}</p></Notice>}

        {open && pf && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2">
              {pf.checks.map((c) => (
                <div key={c.id} className="rounded border p-2.5 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip level={LEVEL[c.status] || 'muted'}>{c.status}</Chip>
                    <span className="font-mono text-xs break-all">{c.id}</span>
                  </div>
                  <p className="text-sm break-words">{c.detail}</p>
                  {c.remedy && <p className="text-xs text-muted-foreground break-words">{c.remedy}</p>}
                </div>
              ))}
            </div>

            <div className="space-y-1.5">
              <SectionHeader title="What can run now" />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {Object.entries(pf.ready_for || {}).map(([t, ready]) => (
                  <div key={t} className="rounded border p-2.5 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Chip level={ready ? 'ok' : 'muted'} mono>{t}</Chip>
                    </div>
                    <p className="text-xs text-muted-foreground break-words">{TRANSPORT_NOTE[t]}</p>
                  </div>
                ))}
              </div>
            </div>

            {!listening && (
              <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3 space-y-3">
                <div className="flex items-start gap-2">
                  <Network className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                  <div className="space-y-1 min-w-0">
                    <p className="font-medium">Incus does not listen on the network</p>
                    <p className="text-sm text-muted-foreground break-words">
                      <span className="font-mono">incus-migrate</span> connects to Incus <em>directly</em> from the
                      source host, so a whole-machine migration of a physical host or a VM needs a listener.
                      {pf.incus.bridge_gateway
                        ? ` The address below is the Incus bridge gateway (${pf.incus.bridge || 'the bridge'}) — reachable from your LAN and from guests, not from the internet.`
                        : ' No Incus bridge gateway could be read, so type the address a source host can reach.'}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 sm:items-end">
                  <label className="space-y-1 min-w-0">
                    <span className="text-xs text-muted-foreground">Listen on</span>
                    <Input
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder={pf.incus.suggested || '10.0.0.1:8443'}
                      className="font-mono min-h-[44px]"
                      inputMode="text"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </label>
                  <Button className={BTN} onClick={enable} disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Network className="h-4 w-4 mr-1.5" />}
                    Enable the listener
                  </Button>
                </div>
                {isPublicBind(address) && (
                  <Checkbox
                    checked={allowPublic}
                    onChange={setAllowPublic}
                    label="That address listens on every interface, including any public one."
                    hint="Tick this only if the source host really is on the internet, and put the Incus port behind your firewall."
                  />
                )}
                <p className="text-xs text-muted-foreground break-words">
                  A container source needs none of this — it uses <span className="font-mono">rootfs-tar</span>,
                  which goes through ProxyPilot.
                </p>
              </div>
            )}

            {listening && (
              <div className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-500" />
                <p className="break-words text-muted-foreground">
                  {pf.incus.note}
                  {done?.reverse_with && <> Undo with <span className="font-mono break-all">{done.reverse_with}</span>.</>}
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
