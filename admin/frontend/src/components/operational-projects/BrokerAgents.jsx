import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { operationsApi as api } from '@/lib/api';
import { Action } from './shared';

// The synthetic API setup was an independent sample workflow. Keep its existing
// records readable; it must not compete with or start the general browser runner.
export function BrokerAgents({project,onEditingChange}) {
  const [agents,setAgents]=useState([]),[selected,setSelected]=useState(null),[readiness,setReadiness]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const base=`/${project.id}/agent-configurations`,epoch=useRef(0),request=useRef(null);
  useEffect(()=>{onEditingChange?.(false);},[onEditingChange]);
  useEffect(()=>{const c=new AbortController(),generation=++epoch.current;request.current=c;setAgents([]);setSelected(null);setReadiness(null);setError('');setBusy(false);
    api.get(base,c.signal).then(result=>{if(!c.signal.aborted&&generation===epoch.current)setAgents(result.agents);}).catch(e=>{if(!c.signal.aborted&&generation===epoch.current)setError(e.message);});
    return()=>{epoch.current++;c.abort();};
  },[base,project.own_role,project.archived_at]);
  async function inspect(agent) {
    if(busy)return;setBusy(true);setError('');const generation=epoch.current,c=request.current;
    try {const response=await api.get(`${base}/${agent.id}/readiness`,c.signal);if(!c.signal.aborted&&generation===epoch.current){setSelected(agent);setReadiness(response.readiness||response);}}
    catch(e){if(!c.signal.aborted&&generation===epoch.current){setError(e.message);if([401,403,404].includes(e.status)){setAgents([]);setSelected(null);setReadiness(null);}}}
    finally{if(!c.signal.aborted&&generation===epoch.current)setBusy(false);}
  }
  if(!agents.length&&!error)return null;
  return <details className="operations-ui rounded-md border p-3 min-w-0"><summary className="cursor-pointer min-h-11 flex items-center font-medium">Historical API configurations ({agents.length})</summary>
    <div className="space-y-4 pt-2"><p className="text-sm text-muted-foreground">Earlier API configurations and assignments are retained. New sample configuration and execution are retired; use browser setup for new website work.</p>
      {error&&<p role="alert" className="text-sm text-destructive break-words">{error}</p>}
      <ul className="space-y-2">{agents.map(agent=><li key={agent.id} className="rounded-md border p-3 space-y-2"><h3 className="text-sm font-medium break-words">{agent.work.name}</h3><p className="text-sm whitespace-pre-wrap break-words">{agent.work.task||'No recorded task'}</p><p className="text-xs text-muted-foreground">Revision {agent.revision} · Historical configuration · New runs unavailable</p><Action variant="outline" disabled={busy} onClick={()=>inspect(agent)}>Inspect recorded configuration</Action></li>)}</ul>
      {selected&&<section className="rounded-md border p-3 space-y-3 text-sm min-w-0" aria-label="Historical API configuration"><h3 className="font-semibold break-words">{selected.work.name}</h3><p>Up to {selected.controls.max_actions} actions / {selected.controls.max_seconds} seconds</p><p className="break-words">Expected result: {selected.work.expected_outcome||'Not recorded'}</p><p className="break-all">Recorded configuration: {selected.id}</p><h4 className="font-medium">Current connection checks</h4><ul className="space-y-2">{readiness?.checks?.map((check,i)=><li key={`${check.kind}-${i}`} className="break-words"><span className="capitalize">{check.kind.replaceAll('_',' ')}: {check.state}</span><span className="block text-xs text-muted-foreground">{check.code}</span></li>)}</ul><p className="text-xs text-muted-foreground">These checks do not enable new execution.</p></section>}
      <Link className="inline-flex min-h-11 items-center underline text-sm" to="/connections">Manage existing connections</Link>
    </div>
  </details>;
}
