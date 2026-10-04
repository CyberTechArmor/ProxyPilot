import { useEffect, useId, useRef, useState } from 'react';
import { Cpu, Globe, KeyRound } from 'lucide-react';
import { operationsApi as api } from '@/lib/api';
import { Action, Choice, Field, Panel } from './shared';
import { newBrowserConfiguration } from './browser-configuration-defaults';
import { BrowserConnections } from './BrowserConnections';
import { browserConfigurationActions as actions, browserConfigurationBudgets as budgets, draftIssueText,
  editableConfiguration, parseBrowserConfiguration, prettyConfiguration as pretty, readinessText } from './browser-configuration-ui';

// Optional runtime hooks consume this editor's exact current selection. They may
// edit a local draft, but validation, review and persistence stay here.
export function BrowserConfigurations({ base, project, onChanged, client = api, externalBusy = false,
  privateUnavailable = false, onPrivateClear, renderPreparation, renderRuntime }) {
  const path = `${base}/browser-agent-configurations`;
  const helpId = useId(), guideId = useId(), workHelpId = useId(), stepHelpId = useId();
  const [items,setItems] = useState([]), [next,setNext] = useState(null), [saved,setSaved] = useState(null);
  const [step,setStep] = useState(0), [expected,setExpected] = useState('');
  const [json,setJson] = useState(''), [source,setSource] = useState(''), [ready,setReady] = useState(null);
  const [website,setWebsite] = useState(''), [taskRules,setTaskRules] = useState(''), [includeRules,setIncludeRules] = useState(false);
  const requestSource = [website.trim() ? `Website: ${website.trim()}` : '', source, expected.trim() ? `Expected result:\n${expected}` : '', includeRules && taskRules.trim() ? `Additional task rules:\n${taskRules}` : ''].filter(Boolean).join('\n\n');
  const resetRequestFields = () => { setWebsite('');setTaskRules('');setIncludeRules(false);setExpected(''); };
  const [validated,setValidated] = useState(''), [reviewed,setReviewed] = useState(false), [conflict,setConflict] = useState(false);
  const [working,setBusy] = useState(false), [loading,setLoading] = useState(true), [lost,setLost] = useState(false);
  const [error,setError] = useState(''), [issues,setIssues] = useState([]), [message,setMessage] = useState('');
  const mounted = useRef(false), request = useRef(null), alert = useRef(null), draftGeneration = useRef(0);
  const requestGeneration = useRef(0), denied = useRef(false), authority = useRef([project.own_role,project.archived_at]);
  const editable = ['owner','editor'].includes(project.own_role) && !project.archived_at;
  const busy = working || externalBusy;
  const unavailable = lost || privateUnavailable || denied.current;
  let parsed = null;
  try { parsed = parseBrowserConfiguration(json); } catch { /* Partially edited JSON stays visible. */ }
  const config = parsed?.configuration;
  const key = JSON.stringify([json,requestSource,project.revision,project.current_version?.id,project.current_version?.content_hash]);
  const valid = validated === key;
  const invalidate = () => { draftGeneration.current++;setValidated(''); setReviewed(false); setReady(null); };
  const dirty = !saved ? !!json || !!requestSource : json !== pretty(saved.configuration) || requestSource !== saved.source_text;
  function clearPrivate() { denied.current=true;requestGeneration.current++;request.current?.abort();setItems([]);setNext(null);setSaved(null);setJson('');setSource('');resetRequestFields();invalidate();setIssues([]);setLost(true);setBusy(false);setLoading(false);onPrivateClear?.(); }
  function current(generation, signal) { return mounted.current&&!denied.current&&!privateUnavailable&&generation===requestGeneration.current&&!signal?.aborted; }
  async function guarded(operation, signal) {
    const generation=requestGeneration.current;
    if(!current(generation,signal))throw new DOMException('Private request context changed.','AbortError');
    let result;
    try { result=await operation(); } catch(error) { if(!current(generation,signal))throw new DOMException('Private request context changed.','AbortError');throw error; }
    if(!current(generation,signal))throw new DOMException('Private request context changed.','AbortError');
    return result;
  }
  const read=(url,signal)=>guarded(()=>client.get(url,signal),signal);
  const write=(url,body,revision,method,signal)=>guarded(()=>client.write(url,body,revision,method,signal),signal);
  function apply(result) {
    const record = result.configuration;
    draftGeneration.current++;
    setSaved(record);setJson(pretty(record.configuration));setSource(record.source_text);resetRequestFields();setReady(result.readiness);
    setValidated('');setReviewed(false);setConflict(false);setIssues([]);
  }
  async function load(signal, after = null) {
    const result = await read(`${path}${after ? `?after=${encodeURIComponent(after)}` : ''}`,signal);
    if (!mounted.current) return;
    setItems(old => after ? [...old,...result.configurations] : result.configurations);setNext(result.next_cursor);setLost(false);
  }
  useEffect(() => {
    mounted.current = true;denied.current=privateUnavailable;requestGeneration.current++;request.current = new AbortController();const generation=requestGeneration.current;
    load(request.current.signal).catch(e => { if (current(generation,request.current.signal) && e.name !== 'AbortError') { setError(e.message);if ([401,403,404].includes(e.status)) clearPrivate(); } }).finally(() => { if (mounted.current && generation===requestGeneration.current) setLoading(false); });
    return () => { mounted.current = false;requestGeneration.current++;request.current.abort(); };
  },[base]);
  useEffect(() => {
    const next=[project.own_role,project.archived_at];
    if(next.every((value,i)=>value===authority.current[i]))return;
    authority.current=next;requestGeneration.current++;request.current?.abort();request.current=new AbortController();setBusy(false);
  },[project.own_role,project.archived_at]);
  useEffect(() => { setValidated('');setReviewed(false);if (!editable) { setSaved(null);setJson('');setSource('');resetRequestFields();setReady(null); } },[project.own_role,project.archived_at,project.revision,project.current_version?.id]);
  useEffect(() => { if (privateUnavailable) clearPrivate(); },[privateUnavailable]);
  useEffect(() => { if (error) alert.current?.focus(); },[error]);
  async function perform(fn, success) {
    if (busy || denied.current || privateUnavailable) return;
    setBusy(true);setError('');setIssues([]);setMessage('');
    const generation=requestGeneration.current,signal=request.current.signal;
    try { await fn(signal);if (current(generation,signal)) setMessage(success); }
    catch (e) {
      if (!current(generation,signal) || e.name === 'AbortError') return;
      invalidate();setError(draftIssueText[e.code] || e.message);setIssues(Array.isArray(e.issues) ? e.issues : []);
      if (e.status === 412) { setConflict({ project_revision:project.revision });setValidated('');setReviewed(false);setError(`${e.message}. Your edits are retained. ${saved ? 'Reload the saved configuration to review its current revision before validating and reviewing again.' : 'Refresh project details, then explicitly accept the refreshed project revision before validating and reviewing again.'}`); }
      if ([401,403,404].includes(e.status) && !['ELEVATION_REQUIRED','AGENT_CONTROL_VERIFICATION_REQUIRED'].includes(e.code)) { clearPrivate();try { await onChanged?.(); } catch { /* Private input has already been cleared. */ } }
    } finally { if (mounted.current && generation===requestGeneration.current) setBusy(false); }
  }
  function input() {
    const imported = parseBrowserConfiguration(json);
    const original = requestSource || (Object.hasOwn(imported,'source_text') ? imported.source_text : json);
    if (new TextEncoder().encode(original).length > 100000) throw new Error('Original source exceeds 100,000 UTF-8 bytes.');
    return { configuration: imported.configuration, source_text: original };
  }
  const change = nextConfig => { setJson(pretty(nextConfig));invalidate(); };
  const at = (section,field,value) => change({ ...config,[section]:{ ...config[section],[field]:value } });
  const edit = id => perform(async signal => { apply(await read(`${path}/${id}`,signal));setStep(3); },'Saved configuration loaded for review.');
  function prepareSettings() {
    try { const value = newBrowserConfiguration({ website, objective:source, expected, rules:includeRules?taskRules:'' });
      change(value);setError('');setIssues([]);setMessage('Fields copied into editable settings. No interpretation, save, connection assignment or run started.');
    } catch(e) { setError(e.message); }
  }
  const draft = { saved, configuration:config, source:requestSource, dirty, conflict:!!conflict, busy, editable, lost,
    generation:JSON.stringify([draftGeneration.current,saved?.id,saved?.revision,key]),
    updateConfiguration:change,
    placeSuggestion(nextConfiguration, original) {
      if (busy || !editable || lost || conflict) return;
      setJson(pretty(nextConfiguration));setSource(original);resetRequestFields();invalidate();setMessage('Suggestion placed in the local editor. Validate and review before saving.');
    },
    markConflict() { setConflict({ project_revision:project.revision });invalidate(); },
  };
  return <Panel className="browser-configurations" title="Browser task setup" icon={Globe} description={renderRuntime ? 'Review selected-site settings; running the saved policy requires separate readiness and approval.' : 'Prepare selected-site browser settings as a saved, non-executable draft.'}>
    <p className="text-sm text-muted-foreground">Describe the work, choose optional connections, set limits and review. {renderRuntime ? 'Public browsing is available separately without a model, guide or credential.' : 'Browser execution is unavailable in this view; saving a draft starts no run.'}</p>
    {error && <div ref={alert} tabIndex={-1} role="alert" className="space-y-2 text-sm text-destructive break-words [overflow-wrap:anywhere]"><p>{error}</p>{issues.length > 0 && <ul className="list-disc pl-5">{issues.map((issue,i) => <li key={i}><span className="font-mono">{issue.path.join('.')}</span>: {issue.message}</li>)}</ul>}</div>}
    <p role="status" aria-live="polite" className="text-sm">{busy ? 'Working…' : loading ? 'Loading configurations…' : message}</p>
    <div className="flex flex-wrap gap-2"><Action variant="outline" disabled={busy || unavailable} onClick={() => perform(async signal => { await onChanged?.();await load(signal);invalidate(); },'Project and configuration list refreshed. Local edits retained; any revision conflict still requires reconciliation.')}>Refresh project details</Action>
      {editable && !unavailable && <Action variant="outline" disabled={busy} onClick={() => { setSaved(null);setJson('');setSource('');resetRequestFields();setConflict(false);invalidate();setStep(0);setMessage('Describe the website, objective and expected result.'); }}>New browser configuration</Action>}</div>
    {!unavailable && <><details className="border-b pb-3"><summary className="cursor-pointer min-h-11 flex items-center text-sm font-medium">Saved configurations ({items.length})</summary><ul className="space-y-2">{items.map(item => <li key={item.id} className="rounded-md border p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0"><div className="min-w-0"><h3 className="font-medium break-words">{item.name}</h3><p className="text-xs text-muted-foreground">Draft · Revision {item.revision} · {renderRuntime ? 'Saved policy' : 'Execution disabled'}</p></div><Action variant="outline" disabled={busy} onClick={() => edit(item.id)}>Review configuration<span className="sr-only"> {item.name}</span></Action></li>)}</ul>
      {!items.length && !loading && <p className="text-sm text-muted-foreground">No saved browser configurations.</p>}
      {next && <Action variant="outline" disabled={busy} onClick={() => perform(signal => load(signal,next),'More configurations loaded.')}>Load more configurations</Action>}
      </details>
      {(editable || saved) && <div className="border-t pt-4 space-y-4 min-w-0">
        <h3 className="font-semibold">{saved ? `Configuration revision ${saved.revision}` : 'Prepare a browser configuration'}</h3>
        <nav aria-label="Browser setup sections" className="border-b"><ol className="grid grid-cols-2 sm:flex items-start gap-1">{['Work','Connections','Controls','Review'].map((label,i)=><li key={label} className="min-w-0 flex-1"><button type="button" disabled={busy} aria-label={`${i+1}. ${label}`} aria-current={step===i?'step':undefined} onClick={()=>setStep(i)} className={`min-h-11 w-full min-w-0 flex flex-col 2xl:flex-row items-center justify-center gap-1 sm:gap-2 border-b-2 pb-2 text-xs sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${step===i?'border-primary text-primary font-semibold':'border-transparent text-muted-foreground'}`}><span aria-hidden="true" className={`h-6 w-6 shrink-0 rounded-full flex items-center justify-center ${step===i?'bg-primary text-primary-foreground':'border'}`}>{i+1}.</span>{' '}<span className="min-w-0 max-w-full [overflow-wrap:anywhere]">{label}</span></button></li>)}</ol></nav>
        <section style={{display:step!==0?'none':undefined}} aria-label="Browser work" className="space-y-4">
        <h3 className="text-lg font-semibold">Work</h3>
        <Field label="Website URL (optional if included in your request)" type="url" placeholder="https://website.example/" value={website} disabled={!editable || busy} onChange={e => { setWebsite(e.target.value);invalidate(); }}/>
        <Field label="Objective" textarea rows={5} placeholder="Describe what you want done and what a successful result looks like. You can use your device's keyboard dictation." value={source} disabled={!editable || busy} onChange={e => { setSource(e.target.value);invalidate(); }}/>
        <p className="text-sm text-muted-foreground">Type or dictate your request in plain language. Keep passwords out of instructions; sign in privately during the browser session when needed.</p>
        <Choice label="Additional task rules" value={includeRules ? 'custom' : 'skip'} disabled={!editable || busy} onChange={e => { setIncludeRules(e.target.value === 'custom');invalidate(); }}><option value="skip">Skip — no additional task rules</option><option value="custom">Set rules for this task</option></Choice>
        {includeRules && <Field label="Task rules in plain language" textarea rows={3} placeholder="For example: use only the current month; exclude archived records." value={taskRules} disabled={!editable || busy} onChange={e => { setTaskRules(e.target.value);invalidate(); }}/>}
        <p className="text-xs text-muted-foreground">Optional task rules are included in the request sent for interpretation. Review their translation into the draft. Skipping them does not remove destination permissions, action approvals or resource limits.</p>
        <Field label="Expected result" textarea rows={2} placeholder="How will you know the task succeeded?" value={expected} disabled={!editable || busy} onChange={e=>{setExpected(e.target.value);invalidate();}}/>
        {editable&&<Action variant="outline" aria-describedby={workHelpId} disabled={busy||!website.trim()||!source.trim()||!expected.trim()} onClick={prepareSettings}>Prepare settings from fields</Action>}
        <p id={workHelpId} className="text-xs text-muted-foreground">Enter a website, objective and expected result to prepare settings. Copies your fields into the draft with read-only actions and finite limits. Optional model interpretation and files are separate below; settings still need review.</p>
        {renderPreparation?.(draft)}
        </section>
        <section style={{display:step!==1?'none':undefined}} aria-label="Browser connections" className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_13rem] gap-4">
          <div className="space-y-4 min-w-0"><header><h3 className="text-lg font-semibold">Connections & credentials</h3><p className="text-sm text-muted-foreground">Optional capabilities for this task. Public browsing needs none.</p></header>
          <article className="rounded-md border p-3 space-y-2"><h4 className="font-medium text-sm flex items-center gap-2"><Cpu className="h-5 w-5" aria-hidden="true"/>Model provider</h4><p className="text-sm">{config?.model?.name||'Not selected'}</p><p className="text-xs text-muted-foreground">A requested model is not a verified connection. The saved revision needs current runtime checks and exact owner disclosure consent in Review.</p></article>
          <article className="rounded-md border p-3 space-y-2"><h4 className="font-medium text-sm flex items-center gap-2"><KeyRound className="h-5 w-5" aria-hidden="true"/>Website sign-in</h4><p className="text-sm text-muted-foreground">Reusable browser-account and OAuth assignment is unavailable here. Private sign-in requires an available controlled session and explicit verification. Keep credentials out of these fields.</p></article>
          {step===1&&<BrowserConnections base={base} project={project} disabled={busy} privateUnavailable={unavailable} onChanged={onChanged}/>}
          </div><aside className="rounded-md border bg-card p-3 space-y-3 self-start" aria-label="Browser connection summary"><h4 className="text-sm font-semibold">Assigned to this agent</h4><p className="text-sm text-muted-foreground">No reusable credential connections are assigned by this setup.</p><p className="text-xs text-muted-foreground">Saving a draft grants no connection or website access.</p></aside>
        </section>
        <section style={{display:step!==2?'none':undefined}} aria-label="Browser controls" className="space-y-4"><h3 className="text-lg font-semibold">Controls</h3>
        {editable && editableConfiguration(config) && <div className="space-y-4">
          <details className="rounded-md border p-3"><summary className="min-h-11 cursor-pointer flex items-center text-sm font-medium">Edit prepared work</summary><div className="space-y-3"><Field label="Configuration name" value={config.name} maxLength={200} disabled={busy} onChange={e => change({ ...config,name:e.target.value })}/>
          <Field label="Browser task instructions" textarea rows={4} value={config.work.instructions} disabled={busy} onChange={e => at('work','instructions',e.target.value)}/>
          <Field label="Success criteria (one per line)" textarea rows={3} value={config.work.success_criteria.join('\n')} disabled={busy} onChange={e => at('work','success_criteria',e.target.value.split(/\r?\n/))}/>
          </div></details><details className="rounded-md border p-3"><summary className="min-h-11 cursor-pointer flex items-center text-sm font-medium">Destination policy</summary><div className="space-y-3"><Field label="Entry URLs (one per line)" textarea rows={3} value={config.destinations.entry_urls.join('\n')} disabled={busy} onChange={e => at('destinations','entry_urls',e.target.value.split(/\r?\n/))}/>
          <fieldset className="space-y-3 min-w-0"><legend className="font-medium text-sm">Exact destination origins</legend>{config.destinations.allowed_origins.map((destination,i) => {
            const update = value => at('destinations','allowed_origins',config.destinations.allowed_origins.map((old,n) => n === i ? { ...old,...value } : old));
            return <div key={i} className="border rounded-md p-3 space-y-3 min-w-0"><Field label={`Destination ${i+1} ID`} value={destination.id} disabled={busy} onChange={e => update({ id:e.target.value })}/>
              <Field label={`Destination ${i+1} origin`} value={destination.origin} disabled={busy} onChange={e => update({ origin:e.target.value })}/>
              <fieldset><legend className="text-sm">Destination {i+1} roles</legend><div className="flex flex-wrap gap-x-4">{['navigation','resource','authentication'].map(role => <label key={role} className="min-h-11 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={destination.roles.includes(role)} disabled={busy} onChange={e => update({ roles:e.target.checked ? [...destination.roles,role] : destination.roles.filter(v => v !== role) })}/>{role}</label>)}</div></fieldset>
              <Choice label={`Destination ${i+1} session headers`} value={destination.session_headers} disabled={busy} onChange={e => update({ session_headers:e.target.value })}><option value="omit">Omit session headers</option><option value="this_origin_session">This origin's session only</option></Choice>
              <Action variant="outline" disabled={busy} onClick={() => at('destinations','allowed_origins',config.destinations.allowed_origins.filter((_,n) => n !== i))}>Remove destination {i+1}</Action></div>;
          })}<Action variant="outline" disabled={busy} onClick={() => at('destinations','allowed_origins',[...config.destinations.allowed_origins,{ id:`site-${config.destinations.allowed_origins.length+1}`,origin:'',roles:['navigation'],session_headers:'omit' }])}>Add exact destination</Action></fieldset></div></details>
          <details className="rounded-md border p-3"><summary className="min-h-11 cursor-pointer flex items-center text-sm font-medium">Requested browser actions</summary><fieldset><legend className="sr-only">Requested browser actions</legend><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-3">{actions.map(action => <label key={action} className="min-h-11 flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={config.permissions.actions.includes(action)} onChange={e => at('permissions','actions',e.target.checked ? [...config.permissions.actions,action] : config.permissions.actions.filter(v => v !== action))}/>{action}</label>)}</div></fieldset></details>
          <fieldset className="min-w-0"><legend className="font-medium text-sm mb-3">Finite resource budgets</legend><div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{budgets.filter(([field])=>['max_seconds','max_actions','max_usd'].includes(field)).map(([field,label,min,max]) => <Field key={field} label={label} type="number" min={min} max={max} step={field === 'max_usd' ? '0.001' : '1'} disabled={busy} value={config.budgets[field] ?? ''} onChange={e => at('budgets',field,e.target.value === '' ? null : Number(e.target.value))}/>)}</div></fieldset>
          <details className="rounded-md border p-3"><summary className="min-h-11 cursor-pointer flex items-center text-sm font-medium">Additional resource limits</summary><div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{budgets.filter(([field])=>!['max_seconds','max_actions','max_usd'].includes(field)).map(([field,label,min,max])=><Field key={field} label={label} type="number" min={min} max={max} disabled={busy} value={config.budgets[field]??''} onChange={e=>at('budgets',field,e.target.value===''?null:Number(e.target.value))}/>)}</div></details>
          <details className="rounded-md border p-3"><summary className="min-h-11 cursor-pointer flex items-center text-sm font-medium">Approved guide for model tasks</summary><div className="space-y-2"><p className="font-medium text-sm">Approved guide pin</p><Hash label="Guide ID" value={config.work.guide_ref?.id}/><Hash label="Guide SHA-256" value={config.work.guide_ref?.sha256}/>
            <Action variant="outline" aria-describedby={guideId} disabled={busy || !project.current_version} onClick={() => at('work','guide_ref',{ id:project.current_version.id,sha256:project.current_version.content_hash })}>Use current approved guide</Action>
            <p id={guideId} className="text-sm text-muted-foreground">{project.current_version ? 'Selecting the guide updates this local draft; validation and save remain separate.' : 'Save an approved guide in Guide first. The configuration can remain an unfinished draft.'}</p></div></details>
          <p className="text-sm text-muted-foreground">Per-action approval is required for consequential changes. Off-list contact requires an exact destination and purpose, with no wildcard or permanent grant. Manual sign-in and its session are limited to one attempt. {renderRuntime ? 'These are requested settings; runtime readiness is checked separately.' : 'These are requested settings; execution remains unavailable.'}</p>
        </div>}
        <details className="rounded-md border p-3"><summary className="min-h-11 cursor-pointer py-3 font-medium">Advanced: import or edit JSON</summary>
        <Field label="Browser configuration JSON" textarea rows={10} spellCheck={false} value={json} disabled={!editable || busy} onChange={e => { setJson(e.target.value);invalidate();try { const value = parseBrowserConfiguration(e.target.value);if (Object.hasOwn(value,'source_text')) setSource(value.source_text);else if (!source) setSource(e.target.value); } catch { /* Preserve unfinished input. */ } }}/>
        </details>
        </section><section style={{display:step!==3?'none':undefined}} aria-label="Browser review" className="space-y-4"><h3 className="text-lg font-semibold">Review</h3>
        <dl className="text-sm divide-y">{[['Website',config?.destinations?.entry_urls?.join(', ')||'Not entered'],['Objective',config?.work?.instructions||'Not prepared'],['Connections','No reusable credential assigned'],['Limits',config?`${config.budgets?.max_actions} actions / ${config.budgets?.max_seconds} seconds`:'Not prepared']].map(([label,value])=><div key={label} className="grid grid-cols-1 sm:grid-cols-[6rem_minmax(0,1fr)] gap-1 sm:gap-3 py-2"><dt className="text-muted-foreground">{label}</dt><dd className="break-words [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
        {editable && <><p id={helpId} className="text-sm text-muted-foreground">{busy ? 'Wait for the current request to finish.' : conflict ? (saved ? 'The saved configuration changed. Reload its current revision before validating and reviewing again. Refresh keeps your local edits and this conflict.' : 'Refresh project details, then explicitly accept the refreshed project revision. Your local edits are retained.') : !json ? (renderPreparation ? 'Prepare editable settings in Work before validating and saving.' : 'Prepare editable settings in Work, or import JSON under Controls.') : !valid ? 'Validate the current settings before reviewing and saving.' : !reviewed ? 'Review the validated settings and check the confirmation before saving.' : 'The reviewed settings can now be saved as a draft.'}</p><div className="flex flex-wrap gap-2"><Action variant="outline" aria-describedby={helpId} disabled={busy || !json || !!conflict} onClick={() => perform(async signal => { const payload = input();const result = await write(`${path}/validate`,payload,null,'POST',signal);setSource(payload.source_text);resetRequestFields();setReady(result.readiness);setValidated(JSON.stringify([json,payload.source_text,project.revision,project.current_version?.id,project.current_version?.content_hash]));setReviewed(false); },'Configuration validated. Review before explicitly saving.')}>Validate configuration</Action>
          {saved && <Action variant="outline" disabled={busy} onClick={() => edit(saved.id)}>Reload saved configuration</Action>}
          {conflict && !saved && <Action variant="outline" aria-describedby={helpId} disabled={busy || project.revision===conflict.project_revision} onClick={() => { setConflict(false);invalidate();setMessage('Refreshed project revision accepted for this local draft. Validate and review before saving.'); }}>Accept refreshed project revision for this draft</Action>}</div>
          {conflict && !saved && <p className="text-sm">Project revision: {project.revision}. Acceptance retains these local settings and source; it does not save them.</p>}
          <label className="min-h-11 flex items-start gap-3 py-2 text-sm"><input className="mt-1 shrink-0" type="checkbox" checked={reviewed} disabled={busy || !valid || conflict} onChange={e => setReviewed(e.target.checked)}/><span>I reviewed this configuration's selected destinations, task, limits and guide.</span></label>
          <Action aria-describedby={helpId} disabled={busy || !valid || !reviewed || conflict} onClick={() => perform(async signal => { const result = await write(saved ? `${path}/${saved.id}` : path,input(),saved?.revision ?? project.revision,saved ? 'PATCH' : 'POST',signal);apply(result);await load(signal); },'Configuration saved as a non-executable draft. No run started.')}>Save browser configuration</Action>
          {!valid && <p className="text-sm text-muted-foreground">Validate after every edit or project change, then review before saving.</p>}</>}
        {saved && <details className="space-y-3"><summary className="min-h-11 cursor-pointer font-medium py-3">Saved identity and integrity</summary><Hash label="Configuration ID" value={saved.id}/><Hash label="Saved configuration SHA-256" value={saved.configuration_sha256}/><Hash label="Saved source SHA-256" value={saved.source_sha256}/><p className="text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{saved.source_text}</p></details>}
        {ready && <section aria-label="Browser configuration readiness" className="border rounded-md p-3 space-y-3 min-w-0"><h3 className="font-semibold">{renderRuntime ? 'Saved configuration checks' : 'Readiness: execution unavailable'}</h3><ul className="space-y-2 text-sm">{ready.checks.map(check => <li key={check.kind} className="break-words"><span className="font-medium capitalize">{check.kind.replaceAll('_',' ')}: {check.state}</span><p className="text-muted-foreground">{readinessText[check.code] || check.code}</p></li>)}</ul>
          {saved && <Action variant="outline" disabled={busy} onClick={() => perform(async signal => setReady((await read(`${path}/${saved.id}/readiness`,signal)).readiness),renderRuntime ? 'Saved configuration checks refreshed. Runtime readiness is reviewed separately.' : 'Readiness checked. Execution remains unavailable.')}>Check configuration readiness</Action>}</section>}
        {renderRuntime?.(draft)}
        </section><footer className="border-t pt-4 flex flex-col sm:flex-row sm:justify-between gap-3"><p id={stepHelpId} className="sr-only">{busy?'Wait for the current request to finish.':step===0?'Work is the first setup step.':'Return to the previous setup step.'}</p><Action variant="outline" aria-describedby={stepHelpId} disabled={busy||step===0} onClick={()=>setStep(step-1)}>Back</Action>{step<3&&<Action disabled={busy} onClick={()=>setStep(step+1)}>Continue to {['Work','connections','controls','review'][step+1]}</Action>}</footer>
      </div>}
    </>}
  </Panel>;
}
function Hash({ label,value }) { return <dl className="text-sm min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="font-mono text-xs break-all">{typeof value === 'string' ? value : 'Not selected'}</dd></dl>; }
