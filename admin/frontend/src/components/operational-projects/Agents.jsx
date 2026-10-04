import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { operationsApi as api } from '@/lib/api';
import { Action, Panel } from './shared';
import { operationSectionUrl } from './run-readiness';

// Imported by older run-history views. This is a historical record boundary,
// never an entry point for starting another legacy workflow.
export function SupportedWorkflowNotice({projectId}) {
  return <div className="rounded-md border bg-muted/20 p-3 text-sm" data-testid="supported-browser-workflow">
    <p>Earlier workflow records remain available for review and cleanup. New browser work uses the general runner.</p>
    <Link className="inline-flex min-h-11 items-center underline underline-offset-4" to={operationSectionUrl(projectId,'Agents')}>Open browser setup</Link>
  </div>;
}

export function AgentConfiguration({base,project,onChanged=async()=>{}}) {
  const [profiles,setProfiles]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const request=useRef(null),epoch=useRef(0);
  const owner=project.own_role==='owner'&&!project.archived_at;
  useEffect(()=>{const c=new AbortController(),generation=++epoch.current;request.current=c;setProfiles([]);setError('');setBusy(false);
    api.get(`${base}/agent-profiles`,c.signal).then(result=>{if(!c.signal.aborted&&generation===epoch.current)setProfiles(result.profiles);}).catch(e=>{if(!c.signal.aborted&&generation===epoch.current)setError(e.message);});
    return()=>{epoch.current++;c.abort();};
  },[base,project.own_role,project.archived_at]);
  async function withdraw(profile,summary=false) {
    if(busy||!owner)return;setBusy(true);setError('');const generation=epoch.current,c=request.current;
    try { await api.write(`${base}/agent-profiles/${profile.id}/${summary?'model-summary-consent':'model-guide-consent'}`,summary?{model_summary_consent:false}:{model_guide_consent:false},profile.revision,'PUT',c.signal);
      const result=await api.get(`${base}/agent-profiles`,c.signal);
      if(!c.signal.aborted&&generation===epoch.current){setProfiles(result.profiles);setMessage('Historical model permission withdrawn. No run started.');await onChanged();}
    }catch(e){if(!c.signal.aborted&&generation===epoch.current){setError(e.message);if([401,403,404].includes(e.status)&&e.code!=='ELEVATION_REQUIRED')setProfiles([]);}}
    finally{if(!c.signal.aborted&&generation===epoch.current)setBusy(false);}
  }
  return <Panel title="Historical profiles" icon={Bot} description="Retained settings and consent records from earlier workflows. New execution is retired.">
    {error&&<p role="alert" className="text-destructive break-words">{error}</p>}<p role="status" className="text-sm">{busy?'Working…':message}</p>
    <ul className="space-y-3">{profiles.map(profile=><li key={profile.id} className="rounded-md border p-3 space-y-3 min-w-0"><h3 className="font-medium break-words">{profile.display_name}</h3>
      <p className="text-xs text-muted-foreground">Historical · Revision {profile.revision} · New runs unavailable</p>
      <p className="text-sm break-words">{profile.proposed_actions.join(', ')||'No actions'} · {profile.proposed_origins.join(', ')||'No origins'}</p>
      <p className="text-sm">Guide: {profile.guide_version_id?`Approved v${profile.guide_version_number??'?'}`:'Unassigned'}</p>
      <p className="text-sm text-muted-foreground">Guide disclosure: {profile.model_guide_consent?'allowed':'not allowed'} · Finished-run summaries: {profile.model_summary_consent?'allowed':'not allowed'}</p>
      <details><summary className="min-h-11 cursor-pointer flex items-center text-sm">Recorded identity</summary><dl className="text-xs space-y-2"><div><dt>Profile ID</dt><dd className="font-mono break-all">{profile.id}</dd></div><div><dt>Guide SHA-256</dt><dd className="font-mono break-all">{profile.guide_hash||'Unassigned'}</dd></div></dl></details>
      {owner&&(profile.model_guide_consent||profile.model_summary_consent)&&<div className="flex flex-wrap gap-2">{profile.model_guide_consent&&<Action variant="outline" disabled={busy} onClick={()=>withdraw(profile)}>Withdraw guide disclosure</Action>}{profile.model_summary_consent&&<Action variant="outline" disabled={busy} onClick={()=>withdraw(profile,true)}>Stop historical summaries</Action>}</div>}
    </li>)}</ul>{!profiles.length&&!error&&<p className="text-sm text-muted-foreground">No historical profiles.</p>}
  </Panel>;
}
