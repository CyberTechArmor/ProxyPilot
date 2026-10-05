import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, FolderOpen, Lock, Plus, Search } from 'lucide-react';
import { operationsApi as api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Action, Field } from './shared';

export function NewProjectButton() {
  const navigate=useNavigate();
  const [open,setOpen]=useState(false),[name,setName]=useState(''),[description,setDescription]=useState(''),[websites,setWebsites]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[defaults,setDefaults]=useState(null),[loaded,setLoaded]=useState(false),saveKey=useRef(null);
  useEffect(()=>{if(!open)return;const c=new AbortController();setLoaded(false);api.get('/capabilities',c.signal).then(async caps=>{const value=caps.streamlined_project_setup?(await api.get('/project-defaults',c.signal)).defaults:null;if(!c.signal.aborted){setDefaults(value);setLoaded(true);}}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[open]);
  async function create(event) {
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try {
      // No precreate account directory is exposed. Named, owner-authorized
      // account lookup and membership grants are available after creation.
      saveKey.current??=crypto.randomUUID();
      const result=defaults?await api.write('/project-tasks',{name,websites,goal:description,accepted_defaults:defaults.version,idempotency_key:saveKey.current}):await api.write('',{name,description,members:[]});
      saveKey.current=null;
      setOpen(false);setName('');setDescription('');setWebsites('');
      navigate(`/operational-projects/${result.project.id}`);
    } catch(e) {setError(e.message);} finally {setBusy(false);}
  }
  function close() {setOpen(false);setName('');setDescription('');setWebsites('');setError('');saveKey.current=null;}
  return <Dialog open={open} onOpenChange={value=>{if(!busy){if(value){setOpen(true);setError('');}else close();}}}>
    <DialogTrigger asChild><Button className="min-h-11 gap-2 rounded-md px-4"><Plus className="h-4 w-4" aria-hidden="true"/>New project</Button></DialogTrigger>
    <DialogContent className="operations-dialog max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-md flex flex-col p-6 [&>button]:h-11 [&>button]:w-11 [&>button]:flex [&>button]:items-center [&>button]:justify-center">
      <DialogHeader className="pr-8"><DialogTitle className="operations-heading">New project</DialogTitle><DialogDescription>Add a name, one or more websites, and your goal in plain language. We create the structured guide and agent setup when you save.</DialogDescription></DialogHeader>
      <form onSubmit={create} className="flex flex-col flex-1 gap-4 min-h-0">
        <div className="space-y-4 min-h-0 overflow-y-auto pr-1">
        {error&&<p role="alert" className="text-destructive break-words">{error}</p>}
        <Field label="Name" required maxLength={200} autoFocus value={name} onChange={e=>setName(e.target.value)}/>
        {defaults&&<div className="space-y-1"><Field label="Websites" required textarea rows={2} maxLength={66000} value={websites} onChange={e=>setWebsites(e.target.value)}/><p className="text-sm text-muted-foreground">One or more domains or full URLs, one per line or separated by commas. Example: example.com, shop.example.com/pricing. Domains use HTTPS.</p></div>}
        <Field label={defaults?"Goal":"Purpose (optional)"} required={!!defaults} textarea rows={4} maxLength={20000} value={description} onChange={e=>setDescription(e.target.value)}/>
        {defaults&&<><p className="text-sm text-muted-foreground">Describe what the agent should do and what result you want. Your words become the objective in the structured guide; no extra settings are required.</p><fieldset className="rounded-md border bg-muted/30 p-4 space-y-2"><legend className="text-sm font-semibold px-1">Included defaults</legend><p>Browser agent · {defaults.model}</p><p className="text-sm text-muted-foreground">{defaults.budgets.cpu} CPU · {defaults.budgets.memory_mib} MB memory · {defaults.budgets.temporary_disk_mib} MB temporary storage</p><p className="text-sm text-muted-foreground">Up to {defaults.budgets.max_seconds/60} minutes, {defaults.budgets.max_actions} actions and ${defaults.budgets.max_usd} per run.</p><p className="flex items-center gap-2 text-sm"><Lock className="h-4 w-4 shrink-0" aria-hidden="true"/>Private to you · Recording {defaults.record_video?'on':'off'}</p></fieldset><p className="text-sm text-muted-foreground">By accepting, you approve the generated guide and allow the agent to send that guide and bounded website content to the model provider. Changes to websites still require approval. Saving does not start a run.</p></>}
        </div>
        <div className="flex shrink-0 flex-col sm:flex-row sm:justify-end gap-2"><Action type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Action><Action type="submit" disabled={busy||!loaded||!name.trim()||(!!defaults&&(!description.trim()||!websites.trim()))}>{busy?'Saving…':!loaded?'Loading defaults…':defaults?'Accept & save':'Create project'}</Action></div>
      </form>
    </DialogContent>
  </Dialog>;
}

export function ProjectStatus({project}) {
  const label=project.archived_at?'Archived':project.current_version?'Guide saved':'No guide';
  return <span className="operations-status shrink-0"><span className={`h-2 w-2 rounded-full ${!project.archived_at&&project.current_version?'bg-primary':'bg-muted-foreground'}`} aria-hidden="true"/>{label}</span>;
}

export function ProjectBrowser({projects,selectedId,section='Overview',collapsible=false,loading=false,cursor,onMore}) {
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('all');
  const searchId=useId();
  const saved=projects.filter(p=>p.current_version&&!p.archived_at).length;
  const rows=projects.filter(p=>`${p.name} ${p.description||''} ${p.current_version?.title||''}`.toLowerCase().includes(search.toLowerCase())&&(filter==='all'||(filter==='saved'?p.current_version&&!p.archived_at:!p.current_version&&!p.archived_at)));
  const list=<>
    <div className="p-4 space-y-3"><div className="relative"><label htmlFor={searchId} className="sr-only">Search projects and procedures</label><Search className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-muted-foreground" aria-hidden="true"/><input id={searchId} type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search projects and procedures…" className="min-h-11 w-full rounded-md border bg-background py-2 pl-10 pr-3 text-sm"/></div>
      <nav className="operations-tabs gap-4" aria-label="Filter projects">{[['all','All',projects.length],['saved','Guide saved',saved],['draft','No guide',projects.filter(p=>!p.current_version&&!p.archived_at).length]].map(([key,label,count])=><button type="button" key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)} className={`min-h-11 shrink-0 border-b-2 pb-2 text-sm ${filter===key?'border-primary text-primary font-semibold':'border-transparent text-muted-foreground'}`}>{label}<span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{count}</span></button>)}</nav>
    </div>
    <div className="flex items-center justify-between gap-2 border-y bg-muted/20 px-4 py-3 text-xs uppercase text-muted-foreground"><span>Project / SOP</span><span>Status</span></div>
    <nav aria-label="Projects" className="divide-y flex-1">{rows.map(item=><Link key={item.id} aria-current={item.id===selectedId?'page':undefined} to={`/operational-projects/${item.id}?section=${encodeURIComponent(section)}`} className={`relative flex min-h-[72px] items-center gap-3 px-4 py-3 transition-colors ${item.id===selectedId?'bg-accent text-accent-foreground before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-primary':'hover:bg-muted/50'}`}>
      <div className="min-w-0 flex-1"><p className="text-base font-medium break-words [overflow-wrap:anywhere]">{item.name}</p><p className="mt-1 text-sm text-muted-foreground break-words">{item.owner_name||'Project'} · {item.own_role}</p></div><ProjectStatus project={item}/><ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true"/>
    </Link>)}</nav>
    {!rows.length&&<div className="space-y-2 p-6 text-center text-muted-foreground"><FolderOpen className="mx-auto h-6 w-6" aria-hidden="true"/><p>{loading?'Loading projects…':search||filter!=='all'?'No matching projects.':'No projects yet.'}</p></div>}
    <footer className="border-t p-4 space-y-3"><p className="text-xs text-muted-foreground">{rows.length} permitted project{rows.length===1?'':'s'}</p>{cursor&&<Action variant="outline" disabled={loading} onClick={onMore}>Load more projects</Action>}</footer>
  </>;
  return <aside className={`operations-card min-w-0 rounded-md border bg-card ${collapsible?'min-h-0 max-h-[35dvh] overflow-y-auto overscroll-contain lg:max-h-none lg:h-full lg:flex lg:flex-col':'self-stretch flex flex-col'}`} data-project-browser>
    {collapsible?<><div className="hidden lg:flex lg:flex-col lg:min-h-full">{list}</div><details className="lg:hidden"><summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 py-3 font-medium"><FolderOpen className="h-4 w-4" aria-hidden="true"/>Browse or switch project</summary>{list}</details></>:list}
  </aside>;
}

export function ProjectPageHeader({children}) {
  return <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4"><div className="min-w-0"><h1 className="operations-title">Projects &amp; SOPs</h1><p className="mt-2 text-base sm:text-lg text-muted-foreground">Shared procedures. Human or agent.</p></div>{children}</header>;
}
