import { useEffect, useState, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Loader2, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff, ShieldQuestion } from 'lucide-react';

// Single CVE entry today; the shape stays an array so a future
// inbox-list endpoint can drop in without restructuring the page.
const TRACKED_CVES = [
  {
    id: 'CVE-2026-31431',
    name: 'Copy Fail',
    summary:
      'Linux kernel algif_aead local privilege escalation. Any unprivileged UID can write 4 bytes into the page cache of a setuid binary. Debian 13 fix: linux source ≥ 6.12.85-1.',
    sources: [
      { label: 'copy.fail', href: 'https://copy.fail' },
      { label: 'Debian tracker', href: 'https://security-tracker.debian.org/tracker/CVE-2026-31431' },
    ],
  },
];

const CLASSIFICATION_META = {
  resolved: {
    label: 'Resolved',
    Icon: ShieldCheck,
    tone: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30',
  },
  vulnerable: {
    label: 'Vulnerable',
    Icon: ShieldAlert,
    tone: 'text-red-500 bg-red-500/10 border-red-500/30',
  },
  'mitigated-pending-reboot': {
    label: 'Mitigated — reboot pending',
    Icon: ShieldCheck,
    tone: 'text-amber-500 bg-amber-500/10 border-amber-500/30',
  },
  'patched-pending-reboot': {
    label: 'Patched — reboot pending',
    Icon: ShieldCheck,
    tone: 'text-amber-500 bg-amber-500/10 border-amber-500/30',
  },
  blocked: {
    label: 'Blocked — operator action required',
    Icon: ShieldOff,
    tone: 'text-orange-500 bg-orange-500/10 border-orange-500/30',
  },
  unknown: {
    label: 'Unknown',
    Icon: ShieldQuestion,
    tone: 'text-muted-foreground bg-muted/40 border-border',
  },
};

function classificationKey(check) {
  if (!check) return 'unknown';
  // After patch the wire shape carries `status` (resolved /
  // patched-pending-reboot / mitigated-pending-reboot / blocked /
  // vulnerable). Pre-patch the shape carries `classification`
  // (resolved / vulnerable / unknown). The page renders both off
  // the same key.
  return check.status || check.classification || 'unknown';
}

function StatusBadge({ statusKey }) {
  const meta = CLASSIFICATION_META[statusKey] || CLASSIFICATION_META.unknown;
  const Icon = meta.Icon;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium border px-2 py-0.5 rounded ${meta.tone}`}>
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
    </span>
  );
}

function FactRow({ label, value, mono = false }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4 text-sm">
      <span className="sm:w-44 text-muted-foreground shrink-0">{label}</span>
      <span className={mono ? 'font-mono break-all' : 'break-words'}>{String(value)}</span>
    </div>
  );
}

function CveCard({ cve }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [check, setCheck] = useState(null);
  const [error, setError] = useState(null);
  const [patching, setPatching] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.cveCheck(cve.id);
      setCheck(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err?.message || 'failed to load'));
    } finally {
      setLoading(false);
    }
  }, [cve.id]);

  useEffect(() => { refresh(); }, [refresh]);

  const onPatch = async (params = {}) => {
    setPatching(true);
    try {
      const result = await api.cvePatch(cve.id, params);
      setCheck(result);
      toast({
        title: `Patch ${result.status || 'completed'}`,
        description: result.operator_action_required && result.operator_action_required !== 'none'
          ? `Operator action: ${result.operator_action_required}`
          : 'No further operator action required.',
      });
    } catch (err) {
      toast({
        title: 'Patch failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setPatching(false);
    }
  };

  const statusKey = classificationKey(check);
  const blocked = !!check?.blocked_reason;
  const actions = check?.actions_taken || [];

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="font-mono text-base">
            {cve.id} <span className="text-muted-foreground font-sans font-normal">— {cve.name}</span>
          </CardTitle>
          <CardDescription className="max-w-2xl">{cve.summary}</CardDescription>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground pt-1">
            {cve.sources.map((s) => (
              <a key={s.href} href={s.href} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                {s.label}
              </a>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {loading
            ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Probing host…</span>
            : <StatusBadge statusKey={statusKey} />}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="text-sm text-red-500 border border-red-500/30 bg-red-500/10 rounded px-3 py-2">
            {error}
          </div>
        )}

        {check && (
          <div className="space-y-1">
            <FactRow label="Host" value={check.host} mono />
            <FactRow label="Running kernel" value={check.running_kernel} mono />
            <FactRow label="Installed kernel" value={check.installed_kernel} mono />
            <FactRow
              label="AF_ALG aead bind"
              value={
                check.aead_bind_reachable
                  ? 'reachable (vulnerable surface exposed)'
                  : `unreachable${check.aead_bind_error ? ` (${check.aead_bind_error})` : ''}`
              }
            />
            <FactRow label="IPsec ESN in use" value={check.ipsec_esn_in_use ? 'yes' : 'no'} />
            <FactRow label="OpenSSL afalg engine" value={check.openssl_afalg_enabled ? 'enabled' : 'disabled'} />
            {blocked && <FactRow label="Blocked reason" value={check.blocked_reason} />}
            <FactRow label="Operator action" value={check.operator_action_required} />
            <FactRow label="Inbox file" value={check.inbox_path} mono />
          </div>
        )}

        {actions.length > 0 && (
          <details className="text-sm" open>
            <summary className="cursor-pointer text-muted-foreground select-none">
              Actions taken ({actions.length})
            </summary>
            <ol className="mt-2 list-decimal list-inside space-y-1 font-mono text-xs bg-muted/30 rounded p-3">
              {actions.map((a, i) => <li key={i} className="break-all">{a}</li>)}
            </ol>
          </details>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading || patching}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Re-check
          </Button>

          {/* Patch button — disabled when nothing to do or while busy. */}
          <Button
            size="sm"
            onClick={() => onPatch({})}
            disabled={loading || patching || statusKey === 'resolved' || (blocked && statusKey !== 'vulnerable')}
            title={blocked ? 'Blocked — use "Force apply" to override' : undefined}
          >
            {patching ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
            Apply patch / mitigation
          </Button>

          {/* Force override only surfaced when the host is currently
              blocked by the IPsec-ESN / OpenSSL-afalg safety gate. */}
          {blocked && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => onPatch({ force: true })}
              disabled={patching}
            >
              Force apply (accept ESN/afalg breakage)
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Security() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin'
    || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';

  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-amber-500" />
        <h1 className="text-lg font-semibold">Security advisories</h1>
      </div>
      <p className="text-xs text-muted-foreground max-w-2xl">
        Live host-side check and patch surface for CVEs ProxyPilot can resolve directly.
        Each card probes the host through the proxypilot-agent socket; "Apply patch / mitigation"
        is sudo-gated and writes a YAML record to the host CVE inbox.
      </p>

      <div className="space-y-4">
        {TRACKED_CVES.map((cve) => <CveCard key={cve.id} cve={cve} />)}
      </div>
    </div>
  );
}
