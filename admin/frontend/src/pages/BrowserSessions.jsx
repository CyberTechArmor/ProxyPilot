import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronRight, Monitor, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { operationsApi as api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Action, Choice } from '@/components/operational-projects/shared';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { canPrepareSession, isActiveSession, loadSessionBatch, sessionCounts, sessionDescription, sessionGroup, sessionRunUrl, sessionStateLabel } from '@/components/operational-projects/browser-sessions';

const filters = [['all','All'], ['help','Needs help'], ['running','Running'], ['paused','Paused'], ['ended','Ended']];
const quantity = value => Number.isFinite(value) && value >= 0 ? value.toLocaleString() : 'Unavailable';
function recordedTime(value) {const at = new Date(value); return value && Number.isFinite(at.getTime()) ? at.toLocaleString() : 'Not recorded';}

function SessionCard({project,run}) {
  const help = sessionGroup(run) === 'help';
  const title = typeof run.configuration_name === 'string' && run.configuration_name.trim() ? run.configuration_name : run.execution_mode === 'public_navigation' ? 'Public browsing' : 'Browser task';
  return <Link to={sessionRunUrl(project.id,run.id)} className={`operations-card group grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-md border-2 p-4 min-w-0 bg-card transition-colors hover:bg-muted/20 ${help?'border-amber-500 bg-amber-500/5':'border-muted-foreground/60'}`} data-session-card>
    <div className="min-w-0 flex flex-col gap-2">
      <div className="flex flex-1 min-h-[164px] flex-col justify-center gap-3 rounded border bg-muted/30 p-4">
        <Monitor className="h-7 w-7 text-muted-foreground" aria-hidden="true"/>
        <p className="font-semibold">Recorded session</p>
        <p className="text-sm text-muted-foreground">Open this run to inspect its browser, activity and evidence.</p>
        <dl className="text-xs space-y-1"><div className="flex flex-wrap gap-1"><dt>Requests:</dt><dd>{quantity(run.usage?.requests)}</dd></div><div className="flex flex-wrap gap-1"><dt>Actions:</dt><dd>{quantity(run.usage?.actions)}</dd></div></dl>
      </div>
      <p className="text-xs text-muted-foreground">{isActiveSession(run)?'Active record · inspect available controls':'Historical record · viewing has ended'}</p>
    </div>
    <div className="min-w-0 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="text-xl font-semibold tracking-tight break-words">{title}</h2><p className="mt-1 text-sm text-muted-foreground break-words">{project.name}{project.archived_at?' · Archived project':''}</p></div><ChevronRight className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/></div>
      <div><span className="operations-status text-foreground"><span className={`h-2.5 w-2.5 rounded-full ${help?'bg-amber-500':sessionGroup(run)==='running'?'bg-primary':'bg-muted-foreground'}`} aria-hidden="true"/>{sessionStateLabel(run)}</span></div>
      <p className="text-sm text-muted-foreground">{sessionDescription(run)}</p>
      <div className="mt-auto space-y-2 pt-2"><p className="text-xs text-muted-foreground break-words">Started {recordedTime(run.started_at)}</p><span className="sr-only">Run {run.id}</span><span className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary">{help?'Review run':'Inspect run'}<ArrowRight className="h-4 w-4" aria-hidden="true"/></span></div>
    </div>
  </Link>;
}

function StartTask({projects,enabled,more,onMore,busy}) {
  const [open,setOpen] = useState(false), [projectId,setProjectId] = useState('');
  const permitted = projects.filter(canPrepareSession);
  const valid = permitted.some(project => project.id === projectId);
  return <Dialog open={open} onOpenChange={value=>{setOpen(value); if(!value) setProjectId('');}}>
    <DialogTrigger asChild><Button disabled={!enabled} className="gap-2 min-h-11 bg-[color-mix(in_srgb,hsl(var(--primary)),black_25%)] hover:bg-[color-mix(in_srgb,hsl(var(--primary)),black_35%)]"><Plus className="h-4 w-4" aria-hidden="true"/>Start task</Button></DialogTrigger>
    <DialogContent className="operations-dialog max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-md flex flex-col overflow-y-auto p-6 [&>button]:h-11 [&>button]:w-11">
      <DialogHeader className="pr-8"><DialogTitle className="operations-heading">Start a task</DialogTitle><DialogDescription>Choose a project, then review its website and task settings. Continuing does not start a browser.</DialogDescription></DialogHeader>
      <Choice label="Project" value={projectId} onChange={event=>setProjectId(event.target.value)}><option value="">Choose a project</option>{permitted.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</Choice>
      {!permitted.length&&<p className="text-sm text-muted-foreground">No loaded project allows you to start work. Open Projects to create one or request access.</p>}
      {more&&<Action variant="outline" disabled={busy} onClick={onMore}>Load more projects</Action>}
      <p className="text-sm text-muted-foreground">The shared runtime runs one browser attempt at a time.</p>
      <div className="flex flex-col sm:flex-row sm:justify-end gap-2"><Action variant="outline" onClick={()=>setOpen(false)}>Cancel</Action>{valid?<Link className="inline-flex min-h-11 items-center justify-center rounded-md bg-[color-mix(in_srgb,hsl(var(--primary)),black_25%)] px-4 text-sm font-medium text-primary-foreground" to={`/operational-projects/${encodeURIComponent(projectId)}?section=Agents`}>Continue to task setup</Link>:<Action disabled>Continue to task setup</Action>}</div>
    </DialogContent>
  </Dialog>;
}

export default function BrowserSessions() {
  const {user,loading}=useAuth();
  if(loading)return <p role="status">Checking your session…</p>;
  if(!user)return <p>Sign in to see your permitted browser sessions.</p>;
  return <BrowserSessionRecords key={JSON.stringify([user.id,user.role,user.permissions])}/>;
}

function BrowserSessionRecords() {
  const [enabled,setEnabled]=useState(null),[projects,setProjects]=useState([]),[rows,setRows]=useState([]),[cursor,setCursor]=useState(null),[failures,setFailures]=useState([]);
  const [busy,setBusy]=useState(true),[error,setError]=useState(''),[filter,setFilter]=useState('all');
  const controller=useRef(null),lock=useRef(false),generation=useRef(0);
  function clear() {setProjects([]);setRows([]);setCursor(null);setFailures([]);}
  async function load(after=null) {
    if(lock.current)return;
    lock.current=true;const epoch=++generation.current,abort=new AbortController();controller.current?.abort();controller.current=abort;
    setBusy(true);setError('');
    if(!after)clear();
    try {
      const capability=await api.get('/capabilities',abort.signal);
      const available=capability.enabled&&capability.ui_available&&capability.agents_metadata_enabled&&capability.agent_runs_enabled&&capability.selected_browser_contract==='selected-browser.v1';
      if(abort.signal.aborted||epoch!==generation.current)return;setEnabled(!!available);
      if(!available){clear();return;}
      const batch=await loadSessionBatch(api,after,abort.signal);
      if(abort.signal.aborted||epoch!==generation.current)return;
      setProjects(old=>after?[...old,...batch.projects]:batch.projects);setRows(old=>after?[...old,...batch.rows]:batch.rows);setFailures(old=>after?[...old,...batch.failures]:batch.failures);setCursor(batch.cursor);
    } catch(e) {if(!abort.signal.aborted&&epoch===generation.current){setError(e.message);if([401,403,404].includes(e.status))clear();}}
    finally {if(epoch===generation.current){setBusy(false);lock.current=false;}}
  }
  useEffect(()=>{load();return()=>{generation.current++;lock.current=false;controller.current?.abort();};},[]);
  const counts=sessionCounts(rows),visible=rows.filter(row=>filter==='all'||sessionGroup(row.run)===filter).sort((a,b)=>['help','running','paused','ended'].indexOf(sessionGroup(a.run))-['help','running','paused','ended'].indexOf(sessionGroup(b.run))||String(b.run.started_at).localeCompare(String(a.run.started_at))||a.run.id.localeCompare(b.run.id));
  return <div className="operations-ui operations-shell w-full max-w-screen-2xl mx-auto gap-5 min-w-0" data-browser-sessions>
    <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4"><div className="min-w-0"><h1 className="operations-title">Agents</h1><p className="mt-2 text-base text-muted-foreground">{counts.active} active session{counts.active===1?'':'s'} in loaded records</p></div><StartTask projects={projects} enabled={enabled} more={cursor} onMore={()=>load(cursor)} busy={busy}/></header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-4 pb-2">
      <nav aria-label="Filter agent sessions" className="operations-tabs">{filters.map(([key,label])=><button type="button" className={`min-h-11 shrink-0 border-b-2 px-2 pb-2 text-sm ${filter===key?'border-primary text-primary font-semibold':'border-transparent text-muted-foreground'}`} key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}<span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{counts[key]}</span></button>)}</nav>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"><p className="text-xs text-muted-foreground">Latest 50 runs per loaded project. Counts cover {projects.length} loaded project{projects.length===1?'':'s'}. One browser attempt runs at a time.</p><Action variant="outline" disabled={busy} className="shrink-0 gap-2" onClick={()=>load()}><RefreshCw className="h-4 w-4" aria-hidden="true"/>Refresh sessions</Action></div>
      {error&&<p role="alert" className="text-destructive break-words">{error}</p>}
      {failures.length>0&&<p role="status" className="rounded-md border p-3 text-sm text-muted-foreground">{failures.length} loaded project{failures.length===1?' has':'s have'} unavailable run records. Refresh to recheck access or retry.</p>}
      {busy&&<p role="status" className="text-sm text-muted-foreground">Loading session records…</p>}
      {enabled===false?<div className="rounded-md border bg-card p-6 space-y-3"><p>Browser sessions are unavailable for this installation. An administrator can check the Operations settings.</p><Link to="/operational-projects" className="inline-flex min-h-11 items-center text-primary underline">Open Projects</Link></div>:<>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3" data-session-grid>{visible.map(row=><SessionCard key={`${row.project.id}:${row.run.id}`} {...row}/>)}</div>
        {!busy&&!visible.length&&<div className="rounded-md border bg-card p-6 space-y-2"><h2 className="text-lg font-semibold">{rows.length?'No sessions match this filter':'No browser sessions in loaded projects'}</h2><p className="text-muted-foreground">{rows.length?'Choose another status to inspect recorded work.':'Choose Start task to open a project’s setup, or load more projects below.'}</p></div>}
        {cursor&&<Action variant="outline" disabled={busy} onClick={()=>load(cursor)}>Load more projects and sessions</Action>}
      </>}
    </div>
  </div>;
}
