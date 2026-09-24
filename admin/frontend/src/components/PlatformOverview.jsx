import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw, ExternalLink, ShieldCheck, ShieldAlert, HelpCircle as CircleHelp, Ban as CircleSlash, Loader2, Lock, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ServiceAccess } from '@/components/PlatformAccess';

// Platform overview (top of the Platform section): the mcp.platform switch,
// then one row per service. Everything shown comes from ONE backend call
// (GET /api/setup/platform/overview) built from the same functions the MCP
// tools use; actions call the shared backend functions. Secrets, SSO
// activation and reset stay in their Platform Setup forms (linked).

const REFRESH_MS = 30000;
const label = (v) => String(v || 'unknown').replaceAll('_', ' ');
const when = (v) => (v ? new Date(v).toLocaleString() : 'never');
const ownershipLabel = { managed: 'Managed', external: 'External', not_selected: 'Not selected' };

function HealthBadge({ status }) {
  const map = {
    healthy: ['Healthy', 'text-primary border-primary/40', ShieldCheck],
    broken: ['Broken', 'text-destructive border-destructive/50', ShieldAlert],
    not_installed: ['Not installed', 'text-muted-foreground', CircleSlash],
    external: ['External', 'text-muted-foreground', CircleHelp],
    not_selected: ['Not selected', 'text-muted-foreground', CircleSlash],
    unknown: ['Unknown', 'text-muted-foreground', CircleHelp],
  };
  const [text, cls, Icon] = map[status] || map.unknown;
  return <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${cls}`}><Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{text}</span>;
}

function Field({ title, children }) {
  return <div className="min-w-0 space-y-1"><p className="text-xs font-medium text-muted-foreground">{title}</p><div className="text-sm break-words">{children}</div></div>;
}

function DnsLine({ dns }) {
  if (!dns) return <span className="text-muted-foreground">No hostname</span>;
  const show = (r) => (r?.addresses?.length ? r.addresses.join(', ') : `nothing${r?.error ? ` (${r.error})` : ''}`);
  return <div className="space-y-1">
    <p className={dns.ok ? 'text-primary' : 'text-destructive'}>{dns.ok ? `Points at the Caddy host (${dns.expected?.address})` : 'Does not point at the Caddy host'}</p>
    <p className="text-xs text-muted-foreground break-all">Host resolver: {show(dns.host)} {dns.points?.host ? '✓' : '✗'} · 1.1.1.1: {show(dns.public)} {dns.points?.public ? '✓' : '✗'}{!dns.agree ? ' · resolvers disagree (cache or local override)' : ''}</p>
    <p className="text-xs text-muted-foreground">{dns.zone?.managed ? `Zone ${dns.zone.zone} is on the stored Cloudflare token` : 'Zone managed outside ProxyPilot'}</p>
  </div>;
}

function McpToggle({ flag, onChanged, busy, setBusy, setError }) {
  if (!flag) return null;
  const change = async (enabled) => {
    setBusy('flag'); setError('');
    try { onChanged(await api.setPlatformMcpFlag(enabled)); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  return <Card>
    <CardHeader className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div className="space-y-1.5 min-w-0">
        <CardTitle aria-level={2}>Platform MCP access</CardTitle>
        <CardDescription>Master switch for every Platform MCP tool, read-only ones included. Only an administrator can change it here; MCP clients cannot. Dashboard actions are not affected.</CardDescription>
      </div>
      <label className="flex items-center gap-3 min-h-11 shrink-0 cursor-pointer">
        <Switch checked={flag.enabled} disabled={busy === 'flag'} onCheckedChange={change} aria-label="Platform MCP access" />
        <span className="font-medium">{flag.enabled ? 'On' : 'Off'}</span>
      </label>
    </CardHeader>
    <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
      <Field title="Current state">{flag.enabled ? 'MCP clients can call Platform tools (subject to mcp.destructive / mcp.platform.purge).' : 'Every Platform MCP tool refuses before doing any work.'}</Field>
      <Field title="Last changed">{flag.last_change ? `${flag.last_change.by?.username || flag.last_change.by?.id || 'system'} · ${when(flag.last_change.at)}${flag.last_change.via ? ` · ${flag.last_change.via}` : ''}` : `Never changed (default ${flag.default ? 'on' : 'off'})`}</Field>
      <Field title="Platform jobs queued or running">
        {flag.active_jobs?.count ? <ul className="space-y-1">{flag.active_jobs.jobs.map((j) => <li key={j.id}><a className="underline break-all" href={`#platform-job-${j.id}`} onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent('platform-open-job', { detail: j.id })); }}>{j.app} · {label(j.status)}{j.phase ? ` · ${label(j.phase)}` : ''}</a></li>)}</ul> : '0'}
        <p className="text-xs text-muted-foreground mt-1">Turning MCP access off does not cancel these.</p>
      </Field>
    </CardContent>
  </Card>;
}

function JobLog({ id, onClose }) {
  const [detail, setDetail] = useState(null), [error, setError] = useState('');
  useEffect(() => { if (id) api.getSetupJob(id).then(setDetail).catch((e) => setError(e.message)); }, [id]);
  return <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
    <DialogContent className="max-w-full h-full rounded-none sm:max-w-3xl sm:h-[85vh] sm:rounded-lg flex flex-col">
      <DialogHeader><DialogTitle>Job log</DialogTitle><DialogDescription className="break-all">{id}</DialogDescription></DialogHeader>
      <div className="flex-1 overflow-y-auto min-w-0 space-y-3 text-sm">
        {error && <p role="alert" className="text-destructive break-words">{error}</p>}
        {!detail && !error && <p role="status">Loading…</p>}
        {detail && <>
          <p className="font-medium break-words">{detail.job.app}: {label(detail.job.status)}{detail.job.phase ? ` · ${label(detail.job.phase)}` : ''}</p>
          <p className="break-words">{detail.job.reason || 'No reason recorded.'}</p>
          <ol className="space-y-3">{detail.events.map((e) => <li key={e.id} className="border-t pt-2 min-w-0"><p className="text-xs text-muted-foreground">{when(e.at || e.created_at)} · {label(e.kind)}</p><p className="break-words">{e.message}</p>{e.data && <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">{JSON.stringify(e.data, null, 2)}</pre>}</li>)}</ol>
        </>}
      </div>
    </DialogContent>
  </Dialog>;
}

function ServiceRow({ s, onOpen }) {
  return <li className="rounded-lg border p-4 min-w-0">
    <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4 gap-3">
      <div className="min-w-0 sm:col-span-2 2xl:col-span-4 space-y-1">
        <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{s.name}</span><HealthBadge status={s.health?.status} /><span className="text-xs text-muted-foreground">{ownershipLabel[s.ownership] || label(s.ownership)}</span></div>
        {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm underline break-all">{s.url}<ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" /></a> : <p className="text-sm text-muted-foreground">No hostname</p>}
        {s.health?.reason && <p className="text-xs text-destructive break-words">{s.health.reason}</p>}
      </div>
      <Field title="Verification">{s.health?.verification ? `${label(s.health.verification.status)}${s.health.verification.verified_at ? ` · ${when(s.health.verification.verified_at)}` : ''}` : '—'}</Field>
      <Field title="Upstream">{s.upstream ? `${s.upstream.address} ${s.upstream.listening === true ? 'listening' : s.upstream.listening === false ? 'NOT listening' : 'unknown'}` : '—'}</Field>
      <Field title="Route / DNS">{s.route?.recorded ? 'Route created' : 'Route not created yet'} · {s.dns ? (s.dns.ok ? 'DNS ok' : 'DNS points elsewhere') : '—'}</Field>
      <Field title="Last job / MCP">{s.last_job ? `${label(s.last_job.status)}${s.last_job.reason_code ? ` · ${s.last_job.reason_code}` : ''}` : '—'}<span className="block text-xs text-muted-foreground">MCP: {s.mcp?.callable?.length ? `${s.mcp.callable.length} tools callable` : 'none callable'}</span></Field>
    </div>
    <div className="mt-3 flex justify-end"><Button variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => onOpen(s.id)}>Manage {s.name}</Button></div>
  </li>;
}

function Confirm({ review, title, confirmText, onCancel, onConfirm, busy, destructive = false }) {
  const [ok, setOk] = useState(false);
  useEffect(() => setOk(false), [review]);
  if (!review) return null;
  return <section aria-label={title} className="rounded-lg border p-4 space-y-3 min-w-0">
    <h4 className="font-semibold break-words">{title}</h4>
    {review.effects?.length > 0 && <ul className="list-disc pl-5 space-y-1 text-sm">{review.effects.map((e) => <li key={e} className="break-words">{e}</li>)}</ul>}
    {review.blockers?.map((b) => <p role="alert" key={b} className="text-sm text-destructive break-words">{b}</p>)}
    {!review.blockers?.length && <label className="flex gap-2 items-start min-h-11 text-sm"><input type="checkbox" className="mt-1" checked={ok} onChange={(e) => setOk(e.target.checked)} /><span>{confirmText}</span></label>}
    <div className="flex flex-col sm:flex-row gap-2">
      <Button className="min-h-11" variant={destructive ? 'destructive' : 'default'} disabled={!ok || !!busy || review.blockers?.length > 0} onClick={onConfirm}>{busy ? 'Working…' : 'Confirm'}</Button>
      <Button className="min-h-11" variant="outline" disabled={!!busy} onClick={onCancel}>Cancel</Button>
    </div>
  </section>;
}

function ServicePanel({ id, onClose, onChanged, openJob }) {
  const [s, setS] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState('');
  const [review, setReview] = useState(null), [logs, setLogs] = useState(null), [preflight, setPreflight] = useState(null), [verify, setVerify] = useState(null);
  const load = useCallback(async (refresh = false) => { try { setS(await api.getPlatformService(id, refresh)); setError(''); } catch (e) { setError(e.message); } }, [id]);
  useEffect(() => { if (id) { setS(null); setReview(null); setLogs(null); setPreflight(null); setVerify(null); setNotice(''); load(); } }, [id, load]);
  const run = async (name, fn) => { setBusy(name); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const act = (aid) => s?.actions?.find((a) => a.id === aid);
  const ActionButton = ({ aid, children, onClick, variant = 'outline' }) => {
    const a = act(aid); if (!a) return null;
    return <div className="space-y-1 min-w-0"><Button variant={variant} className="min-h-11 w-full sm:w-auto h-auto whitespace-normal" disabled={!a.enabled || !!busy} onClick={onClick}>{busy === aid ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" /> : null}{children || a.label}</Button>{!a.enabled && a.reason && <p className="text-xs text-muted-foreground break-words">{a.reason}</p>}</div>;
  };
  const reviewContainer = (container, verb) => run(`${verb}:${container}`, async () => setReview({ kind: 'container', ...(await api.platformContainerReview(id, { container, action: verb })) }));
  const reviewLifecycle = (verb) => run(verb, async () => setReview({ kind: 'lifecycle', ...(await api.fullPlatformLifecycleReview({ service: id, action: verb })) }));
  const confirm = () => run('confirm', async () => {
    if (review.kind === 'container') { const r = await api.platformContainerControl(id, { container: review.container, action: review.action, reviewToken: review.reviewToken, reviewed: true }); setNotice(`${review.action} ${review.container}: ${r.stopped ? 'stopped' : `running (${r.health})`}`); }
    if (review.kind === 'lifecycle') { const r = await api.fullPlatformLifecycle({ revision: review.revision, service: review.service, action: review.action, reviewToken: review.reviewToken, reviewed: true, retainData: review.retainData !== false }); setNotice(`${review.action} queued as ${r.job.id}.`); }
    if (review.kind === 'recover') { const r = await api.keycloakRecover({ revision: review.revision, reviewToken: review.reviewToken, reviewed: true }); setNotice(`Recovery queued as ${r.job.id}; the saved setup continues after it.`); }
    setReview(null); await load(true); onChanged();
  });
  return <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
    <DialogContent className="max-w-full h-full rounded-none sm:max-w-4xl sm:h-[90vh] sm:rounded-lg flex flex-col">
      <DialogHeader><DialogTitle>{s?.name || 'Service'}</DialogTitle><DialogDescription className="break-all">{s?.url || ''}</DialogDescription></DialogHeader>
      <div className="flex-1 overflow-y-auto min-w-0 space-y-5 pr-1">
        {error && <p role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive break-words">{error}</p>}
        {notice && <p role="status" className="rounded-lg border p-3 text-sm break-words">{notice}</p>}
        {!s ? <p role="status">Loading…</p> : <>
          {s.operation && <p role="status" className="rounded-lg border p-3 text-sm break-words">Operation {s.operation.id} is {label(s.operation.status)}{s.operation.phase ? ` (${label(s.operation.phase)})` : ''}. Actions are disabled until it finishes.</p>}
          <div className="flex justify-end"><Button variant="outline" className="min-h-11" disabled={!!busy} onClick={() => run('refresh', () => load(true))}><RefreshCw className="h-4 w-4 mr-2" aria-hidden="true" />Refresh</Button></div>
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field title="Health"><HealthBadge status={s.health.status} />{s.health.reason && <span className="block mt-1 text-destructive">{s.health.reason}</span>}{s.health.runtime_error && <span className="block mt-1 text-destructive">Docker unreachable: {s.health.runtime_error}</span>}</Field>
            <Field title="Verification">{label(s.health.verification?.status)}{s.health.verification?.verified_at ? ` · ${when(s.health.verification.verified_at)}` : ''}<span className="block text-xs text-muted-foreground">{s.health.verification?.label}</span>{s.health.live_check && <span className="block text-xs">Last live check: {s.health.live_check.ok ? 'passed' : 'failed'} · {when(s.health.live_check.at)}</span>}</Field>
            <Field title="Upstream">{s.upstream.address} — {s.upstream.listening === true ? 'listening' : s.upstream.listening === false ? 'not listening (route is broken)' : 'unknown'}</Field>
            <Field title="Route">{s.route.hostname || '—'} · {s.route.recorded ? 'created' : 'not created yet (the service adapter creates it)'}<span className="block text-xs text-muted-foreground break-all">Restricted to: {(s.route.restricted_networks || []).join(', ') || '—'}</span></Field>
            <Field title="DNS"><DnsLine dns={s.dns} />{s.dns && !s.dns.ok && (s.dns.links?.kind === 'cloudflare' ? <a className="text-xs underline" href="/domains">Open the DNS tools (zone {s.dns.links.zone})</a> : s.dns.links?.record && <p className="text-xs">Set at the external DNS host: <code className="break-all">{s.dns.links.record}</code></p>)}</Field>
            <Field title="Last job">{s.last_job ? <><span>{label(s.last_job.status)}{s.last_job.phase ? ` · ${label(s.last_job.phase)}` : ''}{s.last_job.reason_code ? ` · ${s.last_job.reason_code}` : ''} · {when(s.last_job.updated_at)}</span><span className="block text-xs break-words">{s.last_job.reason}</span>{s.last_job.dns_blocked && <span className="block text-xs text-destructive break-words">{s.last_job.dns_blocked}</span>}<button type="button" className="text-xs underline min-h-11 sm:min-h-0" onClick={() => openJob(s.last_job.id)}>View job log</button></> : '—'}</Field>
          </section>
          {s.health.containers?.length > 0 && <section className="space-y-2"><h4 className="font-semibold">Containers</h4><ul className="space-y-2">{s.health.containers.map((c) => <li key={c.name} className="rounded-lg border p-3 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 min-w-0">
            <div className="min-w-0 text-sm"><p className="font-medium break-all">{c.name}</p><p className="text-xs text-muted-foreground break-all">{c.pending ? label(c.status) : c.present === false ? 'Expected but missing' : c.present === null ? 'Not inspected' : `${c.id || ''} · ${label(c.status)} · ${c.health}${c.exit_code != null ? ` · exit ${c.exit_code}` : ''}${c.log_driver ? ` · logs: ${c.log_driver}` : ''}`}</p>{c.error && <p className="text-xs text-destructive break-words">{c.error}</p>}</div>
            <div className="flex flex-col sm:flex-row gap-2 shrink-0">{['start', 'stop', 'restart'].map((verb) => { const a = act(`${verb}:${c.name}`); return a ? <Button key={verb} variant="outline" className="min-h-11 capitalize" disabled={!a.enabled || !!busy} title={a.reason || undefined} onClick={() => reviewContainer(c.name, verb)}>{verb}</Button> : null; })}</div>
          </li>)}</ul>{s.actions.some((a) => a.kind === 'container' && !a.enabled && a.reason?.includes('dependents')) && <p className="text-xs text-muted-foreground break-words">{s.actions.find((a) => a.kind === 'container' && a.reason?.includes('dependents')).reason}</p>}</section>}
          <ServiceAccess service={id} />
          <section className="space-y-3"><h4 className="font-semibold">Actions</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <ActionButton aid="retry" onClick={() => run('retry', async () => { const r = await api.platformServiceRetry(id); setNotice(`Adapter job queued: ${r.job.id}.`); await load(true); onChanged(); })} />
              <ActionButton aid="verify" onClick={() => run('verify', async () => { setVerify(await api.platformServiceVerify(id)); await load(); })} />
              <ActionButton aid="preflight" onClick={() => run('preflight', async () => setPreflight(await api.platformServicePreflight(id)))} />
              <ActionButton aid="logs" onClick={() => run('logs', async () => setLogs(await api.getPlatformServiceLogs(id, 50)))} />
              {['repair', 'reinstall', 'remove'].map((verb) => <ActionButton key={verb} aid={verb} variant={verb === 'remove' ? 'destructive' : 'outline'} onClick={() => reviewLifecycle(verb)} />)}
              <ActionButton aid="reset_data" variant="destructive" onClick={() => reviewLifecycle('reset_data')} />
              <ActionButton aid="recover_bootstrap" onClick={() => run('recover_bootstrap', async () => setReview({ kind: 'recover', ...(await api.keycloakRecoveryReview()) }))} />
            </div>
          </section>
          {review && <Confirm review={review} busy={busy === 'confirm'} destructive={['stop', 'remove', 'reset_data'].includes(review.action)}
            title={review.action === 'reset_data' ? `Reset ${s.name} data` : review.kind === 'container' ? `${review.action} ${review.container}` : review.kind === 'recover' ? 'Recover the Keycloak bootstrap administrator' : `${review.action} ${s.name}`}
            confirmText={review.action === 'reset_data' ? 'I understand every Infisical account, organization, project, machine identity and secret is deleted (after a verified backup), and that I will create a new administrator with Reinstall.' : review.kind === 'recover' ? 'I reviewed this recovery. ProxyPilot generates and stores the new credential; I will retire the bootstrap in stage B.' : 'I reviewed the affected runtime and the downtime. Keep all persistent data and credentials.'}
            onCancel={() => setReview(null)} onConfirm={confirm} />}
          {verify && <section className="rounded-lg border p-4 space-y-2 text-sm min-w-0"><h4 className="font-semibold">Verification {verify.ok ? 'passed' : 'failed'} · {when(verify.at)}</h4><ul className="space-y-1">{verify.checks.map((c) => <li key={c.id} className={`break-words ${c.ok ? '' : 'text-destructive'}`}>{c.ok ? '✓' : '✗'} {label(c.id)}: {c.detail}</li>)}</ul></section>}
          {preflight && <section className="rounded-lg border p-4 space-y-2 text-sm min-w-0"><h4 className="font-semibold">Preflight {preflight.ready ? 'ready' : 'not ready'}</h4><ul className="space-y-1">{preflight.checks.map((c) => <li key={c.id} className={`break-words ${c.ok ? '' : 'text-destructive'}`}>{c.ok ? '✓' : '✗'} {c.id}: {c.detail}</li>)}</ul></section>}
          {logs && <section className="space-y-2 min-w-0"><div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"><h4 className="font-semibold">Logs (last {logs.lines} lines, redacted)</h4><div className="flex gap-2">{[50, 200].map((n) => <Button key={n} variant={logs.lines === n ? 'secondary' : 'outline'} className="min-h-11" disabled={!!busy} onClick={() => run('logs', async () => setLogs(await api.getPlatformServiceLogs(id, n)))}>{n}</Button>)}</div></div>
            {logs.reason && <p className="text-sm text-destructive break-words">{logs.reason}</p>}
            {logs.containers.map((c) => <div key={c.container} className="rounded-lg border min-w-0"><p className="px-3 py-2 text-xs font-medium border-b break-all">{c.container}{c.driver ? ` · ${c.driver}` : ''}{c.source ? ` · ${c.source}` : ''}</p>{c.readable === false ? <p className="p-3 text-sm text-destructive break-words">Logs cannot be read: {c.reason}</p> : <pre className="max-h-80 overflow-auto p-3 text-xs whitespace-pre">{c.lines.length ? c.lines.join('\n') : 'No log lines.'}</pre>}</div>)}
          </section>}
          <section className="rounded-lg border p-4 text-sm space-y-1"><h4 className="font-semibold">Kept out of this view</h4><p>Secret inputs stay in their Platform Setup forms · SSO activation is Platform Setup stage E · Reset (data kept or purge) is Platform Setup → Reset Full Platform, behind its own preview.</p><p className="text-xs text-muted-foreground">MCP: {s.mcp?.summary}</p></section>
        </>}
      </div>
    </DialogContent>
  </Dialog>;
}

/**
 * The restricted allowlist = built-in VPN networks (derived from the VPN
 * configuration: locked rows) ∪ additional addresses (an editable list).
 * A change is reviewed, needs fresh local step-up, and is live when its
 * Caddy step finishes — also after SSO is active.
 */
export function RestrictedNetworks({ vpn = [], additional = [], edit, onChanged }) {
  const [list, setList] = useState(additional), [draft, setDraft] = useState(''), [review, setReview] = useState(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => { setList(additional); setReview(null); }, [additional.join(',')]);
  const run = async (name, fn) => { setBusy(name); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const dirty = list.join(',') !== additional.join(',');
  const disabled = !edit?.enabled || !!busy;
  const add = () => { const v = draft.trim(); if (!v) return; if (/\/0$/.test(v)) { setError('Unrestricted access (/0) is refused.'); return; } if (!list.includes(v)) setList([...list, v]); setDraft(''); setReview(null); setError(''); };
  return <div className="rounded-lg border p-4 space-y-3 min-w-0">
    <h3 className="font-semibold">Restricted networks</h3>
    <p className="text-sm text-muted-foreground">Local recovery and every restricted service route accept these addresses only: the VPN networks plus any additional addresses.</p>
    <ul className="space-y-2" aria-label="Restricted networks">
      {vpn.map((n) => <li key={`vpn-${n}`} className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 min-h-11 min-w-0"><span className="font-mono text-sm break-all">{n}</span><span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Lock className="h-3.5 w-3.5" aria-hidden="true" />VPN · automatic</span></li>)}
      {vpn.length === 0 && <li className="rounded-md border px-3 py-2 text-sm text-muted-foreground">The VPN is not enabled on this host, so the additional addresses are the whole allowlist.</li>}
      {list.map((n) => <li key={`extra-${n}`} className="flex items-center justify-between gap-3 rounded-md border px-3 min-h-11 min-w-0"><span className="font-mono text-sm break-all">{n}</span><Button variant="ghost" className="min-h-11 min-w-11 shrink-0" disabled={disabled} aria-label={`Remove ${n}`} onClick={() => { setList(list.filter((x) => x !== n)); setReview(null); }}><X className="h-4 w-4" aria-hidden="true" /></Button></li>)}
    </ul>
    <div className="flex flex-col sm:flex-row gap-2">
      <div className="flex-1 min-w-0"><Label htmlFor="platform-additional-network" className="sr-only">Additional address or CIDR</Label><Input id="platform-additional-network" value={draft} placeholder="203.0.113.7 or 203.0.113.0/28" disabled={disabled} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} autoComplete="off" spellCheck={false} className="min-h-11" /></div>
      <Button variant="outline" className="min-h-11" disabled={disabled || !draft.trim()} onClick={add}>Add address</Button>
    </div>
    {!edit?.enabled && edit?.reason && <p className="text-xs text-muted-foreground break-words">{edit.reason}</p>}
    <Button className="min-h-11 w-full sm:w-auto" disabled={disabled || !dirty} onClick={() => run('review', async () => setReview(await api.platformNetworksReview(list)))}>Save additional addresses</Button>
    {review && <>
      {review.routes?.length > 0 && <ul className="text-xs space-y-1">{review.routes.map((r) => <li key={r.route_id} className="break-all">{r.hostname}: {(r.before || []).join(', ') || '—'} → {r.after.join(', ')}</li>)}</ul>}
      <Confirm review={review} title="Change the additional addresses" busy={busy === 'save'} confirmText="I reviewed every route and record listed above. This needs a fresh local password + TOTP or passkey." onCancel={() => setReview(null)} onConfirm={() => run('save', async () => { const r = await api.platformNetworksChange({ revision: review.revision, reviewToken: review.reviewToken, additionalNetworks: review.additional_networks, reviewed: true }); setReview(null); setNotice(`Change queued as ${r.job.id}; it is live once the Caddy step finishes.`); onChanged?.(); })} />
    </>}
    {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
    {notice && <p role="status" className="text-sm break-words">{notice}</p>}
  </div>;
}

/**
 * Names the VPN resolver (10.100.0.1) answers with the VPN address, so VPN
 * peers reach them through the tunnel and the restricted routes see their VPN
 * address: the Full Platform hostnames (locked) plus extra domains (editable).
 */
export function VpnDnsNames({ view, onChanged }) {
  const extraNow = view?.extra || [];
  const [list, setList] = useState(extraNow), [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => { setList(extraNow); }, [extraNow.join(',')]);
  if (!view) return null;
  const dirty = list.join(',') !== extraNow.join(',');
  const add = () => { const v = draft.trim().toLowerCase(); if (!v) return; if (!list.includes(v)) setList([...list, v]); setDraft(''); setError(''); };
  const save = async () => { setBusy(true); setError(''); setNotice(''); try { const r = await api.platformVpnDnsSave(list); setNotice(r.push?.ok ? 'Saved and sent to the VPN resolver.' : `Saved; the host resolver was not updated yet (${r.push?.error || 'unknown error'}). It retries every five minutes.`); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  return <div className="rounded-lg border p-4 space-y-3 min-w-0">
    <h3 className="font-semibold">Reached through the VPN</h3>
    <p className="text-sm text-muted-foreground">On the VPN, these names resolve to {view.address}, so the browser goes through the tunnel and restricted routes see its VPN address. Other names resolve normally.</p>
    <ul className="space-y-2" aria-label="Names resolved through the VPN">
      {view.managed.map((n) => <li key={`m-${n}`} className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 min-h-11 min-w-0"><span className="font-mono text-sm break-all">{n}</span><span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Lock className="h-3.5 w-3.5" aria-hidden="true" /><span className="sm:hidden">auto</span><span className="hidden sm:inline">Platform · automatic</span></span></li>)}
      {list.map((n) => <li key={`x-${n}`} className="flex items-center justify-between gap-3 rounded-md border px-3 min-h-11 min-w-0"><span className="font-mono text-sm break-all">{n}</span><Button variant="ghost" className="min-h-11 min-w-11 shrink-0" disabled={busy} aria-label={`Remove ${n}`} onClick={() => setList(list.filter((x) => x !== n))}><X className="h-4 w-4" aria-hidden="true" /></Button></li>)}
    </ul>
    {view.skipped?.length > 0 && <ul className="text-xs text-muted-foreground space-y-1">{view.skipped.map((x) => <li key={x.name} className="break-words">Not sent through the VPN: {x.name} — {x.reason}</li>)}</ul>}
    <div className="flex flex-col sm:flex-row gap-2">
      <div className="flex-1 min-w-0"><Label htmlFor="platform-vpn-dns-name" className="sr-only">Extra hostname</Label><Input id="platform-vpn-dns-name" value={draft} placeholder="app.example.com or *.example.com" disabled={busy} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} autoComplete="off" spellCheck={false} className="min-h-11" /></div>
      <Button variant="outline" className="min-h-11" disabled={busy || !draft.trim()} onClick={add}>Add domain</Button>
    </div>
    <Button className="min-h-11 w-full sm:w-auto" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save extra domains'}</Button>
    <p className="text-xs text-muted-foreground break-words">{view.peer_config}{view.pushed ? ` Resolver ${view.pushed.in_sync ? 'up to date' : view.pushed.ok ? 'update pending' : `not updated: ${view.pushed.error}`}.` : ''}</p>
    {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
    {notice && <p role="status" className="text-sm break-words">{notice}</p>}
  </div>;
}

function SectionActions({ overview, onChanged }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [resync, setResync] = useState(null);
  const run = async (name, fn) => { setBusy(name); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const edit = overview.section_actions?.find((a) => a.id === 'edit_networks'), rs = overview.section_actions?.find((a) => a.id === 'resync_plan');
  return <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
    <RestrictedNetworks vpn={overview.vpn_networks || []} additional={overview.additional_networks || []} edit={edit} onChanged={onChanged} />
    <VpnDnsNames view={overview.vpn_dns} onChanged={onChanged} />
    <div className="rounded-lg border p-4 space-y-3 min-w-0">
      <h3 className="font-semibold">Shared service plan</h3>
      <p className="text-sm">{overview.shared_plan?.in_sync ? 'In sync with the Full Platform revision.' : `The shared plan changed to revision ${overview.shared_plan?.shared_revision} after this Full Platform revision recorded ${overview.shared_plan?.recorded_revision}.`}</p>
      {!rs?.enabled && rs?.reason && <p className="text-xs text-muted-foreground break-words">{rs.reason}</p>}
      <Button variant="outline" className="min-h-11" disabled={!rs?.enabled || !!busy} onClick={() => run('resync-review', async () => setResync(await api.platformResyncReview()))}>Resync shared plan</Button>
      {resync && <Confirm review={resync} title="Resync the shared plan" busy={busy === 'resync'} confirmText="Create a new Full Platform revision from the saved values." onCancel={() => setResync(null)} onConfirm={() => run('resync', async () => { const r = await api.platformResync(resync.revision); setResync(null); setNotice(`Revision ${r.revision} created. Continue the saved setup to write the shared plan again.`); onChanged(); })} />}
    </div>
    {error && <p role="alert" className="lg:col-span-2 text-sm text-destructive break-words">{error}</p>}
    {notice && <p role="status" className="lg:col-span-2 text-sm break-words">{notice}</p>}
  </div>;
}

export default function PlatformOverview() {
  const [overview, setOverview] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [params, setParams] = useSearchParams();
  const [panel, setPanel] = useState(params.get('panel') || ''), [job, setJob] = useState(params.get('job') || '');
  const request = useRef(0);
  const load = useCallback(async (refresh = false) => {
    const id = ++request.current;
    try { const next = await api.getPlatformOverview(refresh); if (id === request.current) { setOverview(next); setError(''); } }
    catch (e) { if (id === request.current) setError(e.message); }
  }, []);
  useEffect(() => {
    load();
    // Refresh every 30 s while the page is visible; host facts are cached for 15 s server-side.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    const onJob = (e) => setJob(e.detail);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('platform-open-job', onJob);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('platform-open-job', onJob); request.current++; };
  }, [load]);
  const closePanel = () => { setPanel(''); if (params.get('panel')) { params.delete('panel'); setParams(params, { replace: true }); } };
  return <section aria-labelledby="platform-overview-title" className="space-y-4 min-w-0">
    <McpToggle flag={overview?.flag} busy={busy} setBusy={setBusy} setError={setError} onChanged={() => load(true)} />
    <Card>
      <CardHeader className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="space-y-1.5 min-w-0"><CardTitle id="platform-overview-title" aria-level={2}>Platform overview</CardTitle><CardDescription>Live health, routes, DNS and the last job for each service. Select a service to manage it.</CardDescription></div>
        <Button variant="outline" className="min-h-11 shrink-0" disabled={busy === 'refresh'} onClick={async () => { setBusy('refresh'); await load(true); setBusy(''); }}><RefreshCw className={`h-4 w-4 mr-2 ${busy === 'refresh' ? 'animate-spin' : ''}`} aria-hidden="true" />Refresh</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert" className="text-sm text-destructive break-words">The overview could not be loaded: {error}</p>}
        {!overview && !error && <p role="status">Loading overview…</p>}
        {overview && !overview.saved && <p className="text-sm">{overview.note}</p>}
        {overview?.saved && <>
          {overview.docker && !overview.docker.ok && <p role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive break-words">{overview.docker.error} Container health below is unknown.</p>}
          {overview.docker?.note && <p className="text-xs text-muted-foreground break-words">{overview.docker.note}</p>}
          {overview.operation && <p role="status" className="rounded-lg border p-3 text-sm break-words">Operation {overview.operation.id} is {label(overview.operation.status)}{overview.operation.phase ? ` (${label(overview.operation.phase)})` : ''}; actions are disabled while it runs. <button type="button" className="underline" onClick={() => setJob(overview.operation.id)}>View job log</button></p>}
          <p className="text-xs text-muted-foreground break-words">MCP access: {overview.mcp_access?.summary}</p>
          <ul className="space-y-3">{overview.services.map((s) => (s.id === 'recovery'
            ? <li key={s.id} className="rounded-lg border p-4"><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"><div className="min-w-0 space-y-1"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{s.name}</span><HealthBadge status={s.health?.status} /></div>{s.url && <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm underline break-all">{s.url}<ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" /></a>}{s.health?.reason && <p className="text-xs text-muted-foreground break-words">{s.health.reason}</p>}</div><Field title="Upstream">{s.upstream.address} {s.upstream.listening === true ? 'listening' : s.upstream.listening === false ? 'NOT listening' : 'unknown'}</Field><Field title="Route">{s.route.recorded ? 'Created' : 'Not created yet'}<span className="block text-xs text-muted-foreground break-all">{(s.route.restricted_networks || []).join(', ')}</span></Field><Field title="DNS"><DnsLine dns={s.dns} /></Field></div></li>
            : <ServiceRow key={s.id} s={s} onOpen={setPanel} />))}</ul>
          <SectionActions overview={overview} onChanged={() => load(true)} />
        </>}
      </CardContent>
    </Card>
    <ServicePanel id={panel} onClose={closePanel} onChanged={() => load(true)} openJob={setJob} />
    <JobLog id={job} onClose={() => { setJob(''); if (params.get('job')) { params.delete('job'); setParams(params, { replace: true }); } }} />
  </section>;
}
