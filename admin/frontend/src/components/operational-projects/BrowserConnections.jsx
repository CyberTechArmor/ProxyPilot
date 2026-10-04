import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Globe, LockKeyhole, Plus, RefreshCw, X } from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useAuth } from '@/context/AuthContext';
import { browserAgentsApi as api } from '@/lib/api';
import { Dialog, DialogPortal, DialogOverlay, DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Action } from './shared';

const blank = () => ({ name: '', kind: 'website-login', origin: '', account_hint: '' });
const control = 'min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const manages = connection => connection?.own_rights?.includes('manage_metadata');
const unavailableText = 'Website sign-in and OAuth enrollment are unavailable. Saved plans provide no credentials or browser access. Public browsing works without a connection.';

// A per-person, per-project instance discards all private metadata immediately
// when identity/authority changes, including requests still returning in flight.
export function BrowserConnections(props) {
  const { user } = useAuth();
  return <BrowserConnectionPlans key={JSON.stringify([props.base, user?.id, user?.role, props.project.own_role, !!props.project.archived_at, !!props.privateUnavailable])} {...props} />;
}

function BrowserConnectionPlans({ base, project, disabled = false, privateUnavailable = false, onChanged, onCatalogueChange }) {
  const path = `${base}/browser-connections`;
  const [rows, setRows] = useState([]), [caps, setCaps] = useState(null), [next, setNext] = useState(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [lost, setLost] = useState(privateUnavailable);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [mode, setMode] = useState(null), [selected, setSelected] = useState(null), [draft, setDraft] = useState(blank);
  const [revision, setRevision] = useState(null), [conflict, setConflict] = useState(false), [formError, setFormError] = useState('');
  const [history, setHistory] = useState(null), [confirmRevoke, setConfirmRevoke] = useState(false);
  const mounted = useRef(false), denied = useRef(privateUnavailable), epoch = useRef(0), requests = useRef(new Set()), opener = useRef(null);
  const canCreate = ['owner', 'editor', 'operator', 'reviewer'].includes(project.own_role) && !project.archived_at;
  const blocked = disabled || busy || loading || lost;
  function clearPrivate() {
    denied.current = true; epoch.current++;
    for (const controller of requests.current) controller.abort();
    setRows([]); setCaps(null); setNext(null); setHistory(null); setSelected(null); setMode(null); setDraft(blank());
    setRevision(null); setFormError(''); setConflict(false); setConfirmRevoke(false); setBusy(false); setLoading(false); setLost(true); onCatalogueChange?.([]);
  }
  async function request(operation) {
    const generation = epoch.current, controller = new AbortController(); requests.current.add(controller);
    const current = () => mounted.current && !denied.current && !controller.signal.aborted && generation === epoch.current;
    try {
      if (!current()) throw new DOMException('Private context changed', 'AbortError');
      const result = await operation(controller.signal);
      if (!current()) throw new DOMException('Private context changed', 'AbortError');
      return result;
    } catch (e) {
      if (!current()) throw new DOMException('Private context changed', 'AbortError');
      if ([401, 403, 404].includes(e.status)) { clearPrivate(); setError('Connection plans are no longer available to this session. Private details have been cleared.'); }
      throw e;
    } finally { requests.current.delete(controller); }
  }
  const read = url => request(signal => api.get(url, signal));
  const write = (url, body, expected, method) => request(signal => api.write(url, body, expected, method, signal));
  async function load(after = null) {
    setLoading(true); setError('');
    try {
      const capability = await read(`${path}/capabilities`);
      setCaps(capability);
      if (!capability.metadata_available) { setRows([]); setNext(null); onCatalogueChange?.([]); return; }
      const result = await read(`${path}${after ? `?after=${encodeURIComponent(after)}` : ''}`);
      const connections = after ? [...rows, ...result.connections] : result.connections;
      setRows(connections); setNext(result.next_cursor); onCatalogueChange?.(connections);
    } catch (e) {
      if (e.name !== 'AbortError' && !denied.current) { setRows([]); setCaps(null); setNext(null); onCatalogueChange?.([]); setError(e.status === 410 ? 'Connection plans have been retired on this server.' : e.message); }
    } finally { if (mounted.current && !denied.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true; if (!privateUnavailable) load(); else setLoading(false);
    return () => { mounted.current = false; epoch.current++; for (const controller of requests.current) controller.abort(); };
  }, []);
  function open(modeValue, connection, target) {
    opener.current = target; setMode(modeValue); setSelected(connection || null); setDraft(connection ? { name: connection.name, kind: connection.kind, origin: connection.origin, account_hint: connection.account_hint } : blank());
    setRevision(connection?.revision ?? project.revision); setConflict(false); setFormError(''); setConfirmRevoke(false); setHistory(null);
  }
  function close() { setMode(null); setSelected(null); setDraft(blank()); setFormError(''); setConflict(false); setConfirmRevoke(false); setHistory(null); }
  async function save(event) {
    event.preventDefault(); if (blocked || conflict || !caps?.metadata_available) return;
    setBusy(true); setFormError('');
    try {
      // Whitelist metadata fields. No password, token, vault handle or active
      // assignment ever passes through this form or the central API client.
      const body = { name: draft.name, origin: draft.origin, account_hint: draft.account_hint, ...(mode === 'new' ? { kind: draft.kind } : {}) };
      await write(mode === 'new' ? path : `${path}/${selected.id}`, body, revision, mode === 'new' ? 'POST' : 'PATCH');
      close(); setNotice('Connection plan saved. No sign-in, OAuth authorization or assignment was created.'); await load(); onChanged?.();
    } catch (e) {
      if (e.name !== 'AbortError' && !denied.current) { setConflict(e.status === 409); setFormError(e.status === 409 ? 'The saved revision changed. Your edits are retained. Refresh the revision and review before saving again.' : e.message); }
    } finally { if (mounted.current && !denied.current) setBusy(false); }
  }
  async function refreshRevision() {
    if (blocked) return; setBusy(true); setFormError('');
    try {
      const result = await read(mode === 'new' ? base : `${path}/${selected.id}`);
      const current = mode === 'new' ? result.project : result.connection;
      if (mode !== 'new' && (!manages(current) || current.status !== 'draft')) { close(); setNotice('This plan can no longer be edited.'); await load(); return; }
      setRevision(current.revision); if (mode !== 'new') setSelected(current);
      setConfirmRevoke(false); setConflict(false); setFormError('Current revision refreshed. Your edits are retained. Review them and submit explicitly.');
    } catch (e) { if (e.name !== 'AbortError' && !denied.current) setFormError(e.message); }
    finally { if (mounted.current && !denied.current) setBusy(false); }
  }
  async function versions(connection, after = null) {
    setBusy(true); setError('');
    try {
      const result = await read(`${path}/${connection.id}/versions${after ? `?after=${encodeURIComponent(after)}` : ''}`);
      setHistory({ id: connection.id, versions: after ? [...history.versions, ...result.versions] : result.versions, next: result.next_cursor });
    } catch (e) { if (e.name !== 'AbortError' && !denied.current) setError(e.message); }
    finally { if (mounted.current && !denied.current) setBusy(false); }
  }
  async function revoke() {
    if (blocked || !selected || !manages(selected)) return;
    setBusy(true); setFormError('');
    try { await write(`${path}/${selected.id}/revoke`, {}, revision); close(); setNotice('Plan revoked. Historical metadata versions are retained.'); await load(); onChanged?.(); }
    catch (e) { if (e.name !== 'AbortError' && !denied.current) { setConflict(e.status === 409); setFormError(e.status === 409 ? 'This plan changed. Refresh the revision and review before revoking.' : e.message); } }
    finally { if (mounted.current && !denied.current) setBusy(false); }
  }
  return <section className="browser-connections min-w-0 space-y-4" aria-label="Optional connection plans">
    <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="text-base font-semibold">Application access</h3><p className="text-sm text-muted-foreground">Optional connection plans</p></div><Action type="button" variant="outline" disabled={blocked || !canCreate || !caps?.metadata_available} onClick={e => open('new', null, e.currentTarget)}><Plus className="mr-2 h-4 w-4" aria-hidden="true"/>Add connection</Action></header>
    <p className="text-sm text-muted-foreground">{unavailableText}</p>
    {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
    {notice && <p role="status" className="text-sm break-words">{notice}</p>}
    {loading ? <p role="status" className="text-sm">Loading connection plans…</p> : <>
      {!rows.length && !lost && <p className="rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">No permitted plans to show. Plans are private to their contributor unless explicitly shared.</p>}
      <ul className="space-y-2">{rows.map(connection => <li key={connection.id} className="operations-card rounded-md border p-3 min-w-0"><div className="flex flex-col sm:flex-row sm:items-center gap-3"><div className="flex gap-3 items-start min-w-0 flex-1"><Globe className="h-5 w-5 mt-0.5 shrink-0" aria-hidden="true"/><div className="min-w-0"><h4 className="text-sm font-medium break-words">{connection.name}</h4><p className="text-xs text-muted-foreground break-all">{connection.origin}</p><p className="text-xs text-muted-foreground">{connection.kind === 'oauth' ? 'OAuth plan' : 'Website sign-in plan'} · {connection.status === 'revoked' ? 'Revoked' : 'Draft · not enrolled'} · metadata v{connection.version}</p>{connection.account_hint && <p className="text-xs text-muted-foreground break-words">Account label: {connection.account_hint}</p>}</div></div><div className="flex flex-wrap gap-2">{manages(connection) ? <><Action type="button" variant="outline" disabled={blocked || connection.status !== 'draft' || !!project.archived_at} onClick={e => open('edit', connection, e.currentTarget)}>Edit</Action><Action type="button" variant="outline" disabled={blocked} onClick={() => versions(connection)}>History</Action>{connection.status !== 'revoked' && <Action type="button" variant="outline" disabled={blocked} onClick={e => open('revoke', connection, e.currentTarget)}>Revoke</Action>}</> : <span className="text-xs text-muted-foreground">Explicit metadata share · no manage access</span>}</div></div>
      {history?.id === connection.id && <div className="border-t mt-3 pt-3 space-y-3"><h5 className="text-sm font-semibold">Retained metadata versions</h5><ul className="space-y-2">{history.versions.map(v => <li key={v.version} className="text-xs space-y-1 break-words"><p className="font-medium">Version {v.version} · {v.name}</p><p className="break-all">{v.origin}</p>{v.account_hint && <p>Account label: {v.account_hint}</p>}<p className="text-muted-foreground">Saved {new Date(v.saved_at).toLocaleString()}</p></li>)}</ul>{history.next && <Action type="button" variant="outline" disabled={blocked} onClick={() => versions(connection, history.next)}>More versions</Action>}<Action type="button" variant="outline" onClick={() => setHistory(null)}>Close history</Action></div>}</li>)}</ul>
      {next && <Action type="button" variant="outline" disabled={blocked} onClick={() => load(next)}>More plans</Action>}
    </>}
    {!lost && <Action type="button" variant="outline" disabled={blocked} onClick={() => load()}><RefreshCw className="mr-2 h-4 w-4" aria-hidden="true"/>Refresh plans</Action>}
    <Dialog open={!!mode} onOpenChange={value => { if (!value) close(); }}>
      <ConnectionDialogContent onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}>
        <div className="pr-10 space-y-1"><DialogTitle className="text-2xl leading-tight">{mode === 'new' ? 'Add a connection' : mode === 'revoke' ? 'Revoke connection plan' : 'Edit connection plan'}</DialogTitle><DialogDescription>{mode === 'revoke' ? 'Revocation preserves the contributor’s historical metadata.' : 'Save optional setup details for this project. No credentials are collected.'}</DialogDescription></div>
        {mode === 'revoke' ? <div className="space-y-4"><p className="text-sm break-words">Revoke {selected?.name}? All metadata shares for this plan will be revoked. No existing browser execution is changed.</p>{formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}{conflict && <Action type="button" variant="outline" disabled={busy || disabled} onClick={refreshRevision}>Refresh revision for review</Action>}<label className="flex items-start gap-3 text-sm min-h-11"><input className="h-5 w-5 mt-0.5 shrink-0" type="checkbox" checked={confirmRevoke} onChange={e => setConfirmRevoke(e.target.checked)} />I reviewed this plan and want to revoke its metadata shares.</label><div className="border-t pt-4 flex flex-col sm:flex-row sm:justify-between gap-3"><Action type="button" variant="outline" onClick={close}>Cancel</Action><Action type="button" disabled={blocked || conflict || !confirmRevoke} onClick={revoke}>Revoke plan</Action></div></div> : <form className="space-y-4" onSubmit={save}>
          <div className="border-b pb-3 text-sm font-medium text-primary">Connection details</div>
          <FormRow label="Connection name">{id => <input id={id} className={control} autoComplete="off" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={200} required />}</FormRow>
          <FormRow label="Connection type">{id => <div id={id} role="group" aria-label="Connection type" className="flex flex-wrap gap-2">{[['website-login', 'Browser sign-in'], ['oauth', 'OAuth plan']].map(([kind, label]) => <Action type="button" key={kind} aria-pressed={draft.kind === kind} variant={draft.kind === kind ? 'default' : 'outline'} className="flex-1 min-h-11" disabled={mode === 'edit'} onClick={() => setDraft({ ...draft, kind })}>{label}</Action>)}</div>}</FormRow>
          <FormRow label="Service address" hint="Exact HTTPS origin only, for example https://billing.example. Saving does not contact it or grant reachability.">{id => <input id={id} className={control} type="url" autoComplete="off" spellCheck="false" maxLength={2048} value={draft.origin} onChange={e => setDraft({ ...draft, origin: e.target.value })} required />}</FormRow>
          <FormRow label="Account label" hint="Optional descriptive label. Never enter a password, access token or secret.">{id => <input id={id} className={control} autoComplete="off" maxLength={200} value={draft.account_hint} onChange={e => setDraft({ ...draft, account_hint: e.target.value })} />}</FormRow>
          <FormRow label="Available to" hint="Project ownership or administration does not inherit access.">{id => <p id={id} className="rounded-md border bg-muted/20 px-3 py-3 text-sm">Private to you as the contributor</p>}</FormRow>
          <div className="rounded-md border p-4 space-y-1"><p className="text-sm font-medium">No active assignment</p><p className="text-xs text-muted-foreground">Website sign-in, OAuth enrollment and use by an agent require a separately implemented and verified adapter.</p></div>
          <details className="group rounded-md border px-4"><summary className="flex min-h-11 items-center justify-between gap-3 cursor-pointer text-sm font-medium">Advanced connection settings<ChevronDown className="h-4 w-4 shrink-0 group-open:rotate-180" aria-hidden="true"/></summary><p className="pb-4 text-xs text-muted-foreground">Editing creates a retained metadata version and revokes prior version shares. Metadata grants never authorize secret disclosure, sign-in or browser execution. Credential custody and provider configuration are not available.</p></details>
          <p className="flex items-start gap-2 rounded-md bg-accent p-3 text-xs"><LockKeyhole className="h-4 w-4 shrink-0" aria-hidden="true"/>Only metadata is saved. Public browsing does not need this plan.</p>
          {formError && <p role="alert" className="text-sm text-destructive break-words">{formError}</p>}
          {conflict && <Action type="button" variant="outline" disabled={busy || disabled} onClick={refreshRevision}>Refresh revision for review</Action>}
          <div className="border-t pt-4 flex flex-col sm:flex-row sm:justify-between gap-3"><Action type="button" variant="outline" onClick={close}>Cancel</Action><Action type="submit" disabled={blocked || conflict || !caps?.metadata_available}>{busy ? 'Saving…' : 'Save connection plan'}</Action></div>
        </form>}
      </ConnectionDialogContent>
    </Dialog>
  </section>;
}

function FormRow({ label, hint, children }) {
  const id = useId();
  return <div className="grid grid-cols-1 sm:grid-cols-[8rem_minmax(0,1fr)] gap-2 sm:gap-4 sm:items-start"><label htmlFor={id} className="text-sm sm:pt-3">{label}</label><div className="space-y-1.5 min-w-0">{children(id)}{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div></div>;
}

function ConnectionDialogContent({ children, ...props }) {
  return <DialogPortal><DialogOverlay className="bg-slate-950/35"/><DialogPrimitive.Content {...props} className="operations-dialog broker-colors fixed left-1/2 top-1/2 z-50 grid w-full h-full max-w-full -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto border bg-background p-6 shadow-xl sm:max-w-[600px] sm:max-h-[90vh] sm:h-auto sm:rounded-md">
    {children}<DialogClose className="absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="h-5 w-5" aria-hidden="true"/><span className="sr-only">Close</span></DialogClose>
  </DialogPrimitive.Content></DialogPortal>;
}
