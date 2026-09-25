import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { operationsApi as api } from '@/lib/api';
import { Action, Panel, Field, Choice } from '@/components/operational-projects/shared';

export default function OperationalProjects() {
  const [enabled,setEnabled]=useState(null),[rows,setRows]=useState([]),[cursor,setCursor]=useState(null);
  const [state,setState]=useState('active'),[name,setName]=useState(''),[description,setDescription]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const navigate=useNavigate();
  async function load(after=null) {
    setBusy(true);setError('');
    try {const data=await api.get(`?state=${state}${after?`&after=${after}`:''}`);setRows(old=>after?[...old,...data.projects]:data.projects);setCursor(data.next_cursor);}
    catch(e){setError(e.message);if([401,403,404].includes(e.status)){setRows([]);setName('');setDescription('');}}
    finally{setBusy(false);}
  }
  useEffect(()=>{let active=true;api.get('/capabilities').then(c=>{if(active)setEnabled(c.enabled&&c.ui_available);}).catch(e=>{if(active){setError(e.message);setEnabled(false);}});return()=>{active=false;};},[]);
  useEffect(()=>{if(enabled)load();},[enabled,state]);
  async function create(e) {
    e.preventDefault();setBusy(true);setError('');
    try {const result=await api.write('',{name,description});navigate(`/operational-projects/${result.project.id}`);}
    catch(e){setError(e.message);setBusy(false);}
  }
  return <div className="max-w-5xl mx-auto space-y-6 p-4 sm:p-6">
    <header><h1 className="text-2xl font-bold">Operations</h1><p className="text-muted-foreground mt-2">Store instructions and record work performed by people.</p></header>
    {error&&<p role="alert" className="text-destructive break-words">{error}</p>}
    {enabled===null?<p role="status">Loading Operations…</p>:!enabled?<p>Operations is not enabled on this installation.</p>:<>
      <Panel title="New operation"><form onSubmit={create} className="space-y-4">
        <Field label="Name" required maxLength={200} value={name} onChange={e=>setName(e.target.value)}/>
        <Field label="Description (optional)" textarea rows={3} maxLength={20000} value={description} onChange={e=>setDescription(e.target.value)}/>
        <p className="text-sm text-muted-foreground">Private to you until you add members. Creating an operation stores records only.</p>
        <Action type="submit" disabled={busy}>Create operation</Action>
      </form></Panel>
      <Panel title="Your operations"><div className="flex flex-wrap gap-3 items-end"><Choice label="Show" value={state} onChange={e=>setState(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></Choice><Action variant="outline" disabled={busy} onClick={()=>load()}>Refresh</Action></div>
        {busy&&<p role="status">Loading…</p>}{!busy&&!rows.length&&<p>No operations to show.</p>}
        <ul className="space-y-3">{rows.map(p=><li key={p.id} className="rounded-md border p-4 min-w-0"><Link className="inline-flex min-h-11 items-center font-medium underline break-words [overflow-wrap:anywhere]" to={`/operational-projects/${p.id}`}>{p.name}</Link><p className="text-sm text-muted-foreground">{p.own_role} · {p.archived_at?'Archived':p.current_version?`Approved guide v${p.current_version.version_number}`:'No current approved guide'}</p></li>)}</ul>
        {cursor&&<Action variant="outline" disabled={busy} onClick={()=>load(cursor)}>Load more operations</Action>}
      </Panel>
    </>}
  </div>;
}
