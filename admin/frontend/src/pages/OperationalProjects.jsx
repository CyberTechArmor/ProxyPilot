import { useEffect, useState } from 'react';
import { FileText, FolderOpen, KeyRound, Users } from 'lucide-react';
import { operationsApi as api } from '@/lib/api';
import { Action, Panel, Choice } from '@/components/operational-projects/shared';
import { AgentInbox } from '@/components/operational-projects/AgentRuns';
import { OperationsSettings } from '@/components/operational-projects/OperationsSettings';
import { NewProjectButton, ProjectBrowser, ProjectPageHeader } from '@/components/operational-projects/ProjectSurface';

export default function OperationalProjects() {
  const [enabled,setEnabled]=useState(null),[rows,setRows]=useState([]),[cursor,setCursor]=useState(null);
  const [state,setState]=useState('active'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [agentCapability,setAgentCapability]=useState(false),[directory,setDirectory]=useState([]),[directoryCursor,setDirectoryCursor]=useState(null);
  const [runsCapability,setRunsCapability]=useState(false),[canManage,setCanManage]=useState(false);
  async function load(after=null) {
    setBusy(true);setError('');
    try {const data=await api.get(`?state=${state}${after?`&after=${after}`:''}`);setRows(old=>after?[...old,...data.projects]:data.projects);setCursor(data.next_cursor);}
    catch(e){setError(e.message);if([401,403,404].includes(e.status))setRows([]);}
    finally{setBusy(false);}
  }
  async function loadCapabilities() {
    try {const c=await api.get('/capabilities');setEnabled(c.enabled&&c.ui_available);setAgentCapability(c.enabled&&c.agents_metadata_enabled);setRunsCapability(!!c.agent_runs_enabled);setCanManage(c.can_manage_settings===true);}
    catch(e){setError(e.message);setEnabled(false);}
  }
  useEffect(()=>{loadCapabilities();},[]);
  useEffect(()=>{if(enabled)load();else if(enabled===false){setRows([]);setCursor(null);setDirectory([]);}},[enabled,state]);
  async function loadDirectory(after=null) {try {const data=await api.get(`/directory${after?`?after=${after}`:''}`);setDirectory(old=>after?[...old,...data.projects]:data.projects);setDirectoryCursor(data.next_cursor);}catch(e){setError(e.message);setDirectory([]);setDirectoryCursor(null);}}
  useEffect(()=>{if(agentCapability)loadDirectory();},[agentCapability]);
  return <div className="operations-ui operations-shell w-full max-w-screen-2xl mx-auto gap-4 min-w-0">
    <ProjectPageHeader>{enabled&&<NewProjectButton/>}</ProjectPageHeader>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-6" data-operations-content>
    {error&&<p role="alert" className="text-destructive break-words">{error}</p>}
    {enabled===null?<p role="status">Loading Operations.</p>:!enabled?<p>Operations is not turned on for this installation.{canManage?' Turn it on in Operations settings below.':' An administrator turns it on in Operations settings.'}</p>:<>
      <div className="flex flex-col sm:flex-row sm:items-end gap-3"><div className="w-full sm:w-40"><Choice label="Show projects" value={state} onChange={e=>setState(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></Choice></div><Action variant="outline" disabled={busy} onClick={()=>load()}>Refresh projects</Action></div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)] gap-4 min-w-0" data-project-workspace>
        <ProjectBrowser projects={rows} loading={busy} cursor={cursor} onMore={()=>load(cursor)}/>
        <section className="operations-card rounded-md border bg-card p-4 sm:p-6 min-w-0 space-y-6" data-selected-project>
          <header className="space-y-3"><FolderOpen className="h-8 w-8 text-primary" aria-hidden="true"/><h2 className="operations-heading">{rows.length?'Choose a project':'Give repeatable work a home'}</h2><p className="text-muted-foreground">{rows.length?'Open a project to see its guide, readiness, agents and recent activity.':'Create a project, save its guide, then decide who can use it.'}</p></header>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><Panel title="Guides & versions" icon={FileText}><p className="text-sm text-muted-foreground">Save a guide as an approved version. Each work record keeps the exact version used.</p></Panel><Panel title="People & access" icon={Users}><p className="text-sm text-muted-foreground">Projects start private to their owner. Add existing people and choose a role in Access.</p></Panel></div>
          <div className="flex items-start gap-3 rounded-md border bg-muted/20 p-4"><KeyRound className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/><p className="text-sm text-muted-foreground">Project membership and connection permissions are separate. Configuring an agent does not start a run.</p></div>
        </section>
      </div>
      {runsCapability&&<details className="operations-card rounded-md border bg-card p-4"><summary className="min-h-11 cursor-pointer font-medium flex items-center">Historical run requests</summary><div className="pt-4"><AgentInbox/></div></details>}
      {agentCapability&&<Panel title="Discover projects" description="Only projects whose owners enabled discovery appear here. Access starts when the owner accepts your request." actions={<Action variant="outline" disabled={busy} onClick={()=>loadDirectory()}>Refresh directory</Action>}>
        {!directory.length&&<p className="text-sm text-muted-foreground">No discoverable projects.</p>}
        <ul className="space-y-3">{directory.map(p=><li key={p.id} className="rounded-md border p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0"><div className="min-w-0"><h3 className="font-semibold break-words">{p.name}</h3><p className="text-sm text-muted-foreground">{p.visibility} · {p.request_state==='pending'?'Request pending':'Membership required'}</p></div><Action disabled={p.request_state==='pending'} onClick={async()=>{setError('');try{await api.write(`/${p.id}/access-requests`,{});await loadDirectory();}catch(e){setError(e.message);}}}>Request access</Action></li>)}</ul>
        {directoryCursor&&<Action variant="outline" disabled={busy} onClick={()=>loadDirectory(directoryCursor)}>Load more discoverable projects</Action>}
      </Panel>}
    </>}
    {/* Keep settings mounted when toggles change, with a compact entry point. */}
    {canManage&&<details className="operations-card rounded-md border bg-card p-4"><summary className="min-h-11 flex items-center cursor-pointer font-semibold">Operations settings</summary><div className="pt-4"><OperationsSettings onChanged={loadCapabilities}/></div></details>}
    </div>
  </div>;
}
