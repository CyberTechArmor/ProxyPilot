import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { operationsApi as api } from '@/lib/api';
import { BrowserConnections } from '@/components/operational-projects/BrowserConnections';
import { Action, Choice } from '@/components/operational-projects/shared';

export default function Connections() {
  const {user}=useAuth();
  // No selected project or returning private request survives identity changes.
  return <ConnectionProjects key={JSON.stringify([user?.id,user?.role,user?.permissions])} authenticated={!!user}/>;
}

function ConnectionProjects({authenticated}) {
  const [projects,setProjects]=useState([]),[cursor,setCursor]=useState(null),[projectId,setProjectId]=useState(''),[project,setProject]=useState(null);
  const [enabled,setEnabled]=useState(null),[listBusy,setListBusy]=useState(false),[projectBusy,setProjectBusy]=useState(false),[error,setError]=useState('');
  const mounted=useRef(false),requests=useRef(new Set()),listEpoch=useRef(0),projectEpoch=useRef(0),listLock=useRef(false),projectRequest=useRef(null);
  function clearSelection() {projectEpoch.current++;projectRequest.current?.abort();setProject(null);setProjectId('');setProjectBusy(false);}
  async function loadProjects(after=null) {
    if(listLock.current||!authenticated)return;
    listLock.current=true;const epoch=++listEpoch.current,controller=new AbortController();requests.current.add(controller);setListBusy(true);setError('');
    if(!after){clearSelection();setProjects([]);setCursor(null);}
    try {
      const caps=await api.get('/capabilities',controller.signal);
      if(!mounted.current||controller.signal.aborted||epoch!==listEpoch.current)return;
      const available=caps.enabled&&caps.ui_available&&caps.agents_metadata_enabled;setEnabled(!!available);
      if(!available){clearSelection();setProjects([]);setCursor(null);return;}
      const result=await api.get(`?state=all&limit=6${after?`&after=${encodeURIComponent(after)}`:''}`,controller.signal);
      if(!mounted.current||controller.signal.aborted||epoch!==listEpoch.current)return;
      setProjects(old=>after?[...old,...result.projects.slice(0,6)]:result.projects.slice(0,6));setCursor(result.next_cursor||null);
    } catch(e) {
      if(mounted.current&&!controller.signal.aborted&&epoch===listEpoch.current){setError(e.message);if([401,403,404].includes(e.status)){clearSelection();setProjects([]);setCursor(null);}}
    } finally {requests.current.delete(controller);if(mounted.current&&epoch===listEpoch.current){setListBusy(false);listLock.current=false;}}
  }
  async function selectProject(id) {
    projectRequest.current?.abort();const epoch=++projectEpoch.current;
    setProject(null);setProjectId(id);setProjectBusy(!!id);setError('');
    if(!id)return;
    const controller=new AbortController();projectRequest.current=controller;requests.current.add(controller);
    try {
      // Resolve current membership, archive state and revision. The selector
      // is never the authority for creating a connection plan.
      const result=await api.get(`/${encodeURIComponent(id)}`,controller.signal);
      if(mounted.current&&!controller.signal.aborted&&epoch===projectEpoch.current)setProject(result.project);
    } catch(e) {
      if(mounted.current&&!controller.signal.aborted&&epoch===projectEpoch.current){setProject(null);setError([401,403,404].includes(e.status)?'Project access is no longer available. Its private connection plans have been cleared.':e.message);if([401,403,404].includes(e.status)){setProjects(old=>old.filter(row=>row.id!==id));setProjectId('');}}
    } finally {requests.current.delete(controller);if(mounted.current&&epoch===projectEpoch.current)setProjectBusy(false);}
  }
  useEffect(()=>{
    mounted.current=true;loadProjects();
    return()=>{mounted.current=false;listEpoch.current++;projectEpoch.current++;listLock.current=false;for(const controller of requests.current)controller.abort();};
  },[]);
  return <div className="operations-ui operations-shell w-full max-w-screen-2xl mx-auto gap-5 min-w-0" data-global-browser-connections>
    <header><h1 className="operations-title">Connections</h1><p className="text-base text-muted-foreground mt-2">Optional application access plans for your projects.</p></header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-5 pb-2">
      <p className="text-sm text-muted-foreground">Public browsing works without a connection. Plans save metadata only; website sign-in and OAuth enrollment are unavailable.</p>
      {error&&<p role="alert" className="text-destructive break-words">{error}</p>}
      {!authenticated?<p>Sign in to see your permitted projects.</p>:enabled===false?<p>Connection plans are unavailable. An administrator can check the Operations settings.</p>:<>
        <div className="operations-card rounded-md border bg-card p-4 min-w-0 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3"><div className="min-w-0 flex-1"><Choice label="Project" value={projectId} onChange={event=>selectProject(event.target.value)} disabled={listBusy}><option value="">Choose a project</option>{projects.map(row=><option value={row.id} key={row.id}>{row.name}{row.archived_at?' · Archived':''}</option>)}</Choice></div><Action variant="outline" disabled={listBusy} className="gap-2 shrink-0" onClick={()=>loadProjects()}><RefreshCw className="h-4 w-4" aria-hidden="true"/>Refresh projects</Action></div>
          <p className="text-xs text-muted-foreground">{projects.length} loaded permitted project{projects.length===1?'':'s'}. Each selection checks your current access.</p>
          {cursor&&<Action variant="outline" disabled={listBusy} onClick={()=>loadProjects(cursor)}>Load more projects</Action>}
          {listBusy&&<p role="status" className="text-sm">Loading permitted projects…</p>}
          {!listBusy&&enabled&&!projects.length&&<p className="text-sm text-muted-foreground">No permitted projects to show. Create a project or request access from its owner.</p>}
        </div>
        {projectBusy?<p role="status">Checking current project access…</p>:project?<section className="operations-card rounded-md border bg-card p-4 sm:p-6 min-w-0 space-y-4"><header><h2 className="text-xl font-semibold break-words">{project.name}</h2><p className="text-sm text-muted-foreground">{project.archived_at?'Archived project · new plans unavailable':'Project connection plans'}</p></header><BrowserConnections key={`${project.id}:${project.revision}:${project.own_role}`} base={`/${project.id}`} project={project} onChanged={()=>selectProject(project.id)}/></section>:!listBusy&&enabled&&<p className="text-sm text-muted-foreground">Choose a project to view the connection plans available to you.</p>}
      </>}
      <Link to="/operational-projects" className="inline-flex min-h-11 items-center text-sm text-primary underline">Open Projects</Link>
      <details className="rounded-md border bg-card p-4"><summary className="min-h-11 flex items-center cursor-pointer text-sm font-medium">Existing broker records</summary><p className="pt-2 text-sm text-muted-foreground">Existing broker configuration, credentials and history are preserved. Browser connection plans collect no secrets and do not enroll, assign or activate a broker integration.</p></details>
    </div>
  </div>;
}
