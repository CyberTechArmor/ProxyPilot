import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { operationsApi as api } from '@/lib/api';
import { Action } from './shared';
import { sessionGroup, sessionRunUrl, sessionStateLabel } from './browser-sessions';

const RunContext=createContext(null);
// Existing metadata GET only; no viewer, private source, model call or launch.
export function BrowserRunSummary(props) {
  const { user } = useAuth();
  return <CurrentRuns key={JSON.stringify([props.project.id, user?.id, user?.role, user?.permissions, props.project.own_role, props.project.archived_at])} {...props}/>;
}
function CurrentRuns({ project, onUnavailable, children }) {
  const [rows, setRows] = useState([]), [status, setStatus] = useState('loading'), [tick, setTick] = useState(0);
  const unavailable = useRef(onUnavailable);unavailable.current=onUnavailable;
  useEffect(() => {
    const controller = new AbortController();let active=true;
    setRows([]);setStatus('loading');
    api.get(`/${encodeURIComponent(project.id)}/browser-agent-runs`, controller.signal).then(result => {
      if(active&&!controller.signal.aborted){setRows((result.runs||[]).slice(0,50));setStatus('loaded');}
    }).catch(error => {
      if(!active||controller.signal.aborted)return;
      setRows([]);setStatus('unavailable');
      if([401,403,404].includes(error.status))unavailable.current?.();
    });
    return () => {active=false;controller.abort();};
  },[project.id,project.revision,tick]);
  return <RunContext.Provider value={{rows,status,project,refresh:()=>setTick(value=>value+1)}}>{children}</RunContext.Provider>;
}
const title=run=>run.configuration_name?.trim()||(run.execution_mode==='public_navigation'?'Public browser':'Browser task');
export function BrowserRunHelp(){
  const {rows,project}=useContext(RunContext);
  const needsHelp=rows.find(run=>sessionGroup(run)==='help');
  return needsHelp?<div className="rounded-md border border-amber-500/60 bg-amber-500/5 p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3" role="status" data-browser-run-help><div className="min-w-0"><p className="font-semibold break-words">{title(needsHelp)} needs your attention</p><p className="text-sm text-muted-foreground">{sessionStateLabel(needsHelp)}. Review the recorded request or recovery evidence.</p></div><Link className="min-h-11 inline-flex items-center shrink-0 text-primary underline" to={sessionRunUrl(project.id,needsHelp.id)}>Open browser session</Link></div>:null;
}
export function RecentBrowserRuns(){
  const {rows,status,project,refresh}=useContext(RunContext);
  return <div className="border-t pt-3 space-y-3" data-recent-browser-runs><h3 className="font-semibold">Recent browser runs</h3>{status==='loading'?<p className="text-sm text-muted-foreground" role="status">Loading browser records…</p>:status==='unavailable'?<p className="text-sm text-muted-foreground">Browser records are unavailable.</p>:rows.length?<ul className="divide-y">{rows.slice(0,3).map(run=><li key={run.id}><Link className="min-h-11 flex items-center justify-between gap-3 py-2 text-sm" to={sessionRunUrl(project.id,run.id)}><span className="min-w-0 break-words">{title(run)}</span><span className="shrink-0 text-muted-foreground">{sessionStateLabel(run)}</span></Link></li>)}</ul>:<p className="text-sm text-muted-foreground">No browser runs recorded yet.</p>}<Action variant="ghost" disabled={status==='loading'} className="px-0 text-primary" onClick={refresh}>Refresh browser records</Action></div>;
}
