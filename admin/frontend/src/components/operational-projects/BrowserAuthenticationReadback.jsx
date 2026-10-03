import {useEffect,useId,useRef,useState} from 'react';
import {browserAgentsApi as api} from '@/lib/api';
import {Action} from './shared';
import {AUTHENTICATION_CONFIRMATION,authenticationInventory,authenticationPayload} from './browser-authentication-ui';

export function BrowserAuthenticationReadback({root,run,controls,project,viewer,busy,perform,setData}) {
  const [inventory,setInventory]=useState(null),[selected,setSelected]=useState([]),[reviewed,setReviewed]=useState(false);
  const help=useId(),epoch=useRef(0);
  const available=controls.can_confirm_authentication===true && run.state==='human_control' && run.manual_auth===true &&
    !!viewer && project.own_role!=='viewer' && !project.archived_at;
  function clear(){setInventory(null);setSelected([]);setReviewed(false);}
  useEffect(()=>{epoch.current++;clear();return()=>{epoch.current++;};},
    [root,run.attempt_id,run.fence,run.controller_user_id,run.manual_auth,run.state,available,viewer,project.own_role,project.archived_at]);
  useEffect(()=>{if(inventory&&inventory.revision!==run.revision){epoch.current++;clear();}},[run.revision,inventory?.revision]);
  async function privateRequest(operation) {
    const generation=epoch.current;
    try {await operation(generation);} catch(error){if(generation===epoch.current)clear();throw error;}
  }
  if(run.state!=='human_control'||!run.manual_auth)return null;
  return <section aria-label="Authentication readback" className="rounded-md border p-3 space-y-3 min-w-0 text-sm">
    <h4 className="font-semibold">Confirm observed authentication</h4>
    <p>Review each completed request while you still control this browser. Select only requests you independently verified were solely for sign-in or MFA. Other website changes remain unresolved.</p>
    <p id={help}>{!available?'Keep the verified live view connected as the current controller to review authentication.':busy?'Wait for the current request to finish.':!inventory?'Load the current request evidence before selecting anything.':!selected.length?'Select each sign-in or MFA request you reviewed.':!reviewed?'Read and check the complete authentication confirmation.':'Submit this selected confirmation. Releasing control and resuming remain separate actions.'}</p>
    <Action variant="outline" aria-describedby={help} disabled={busy||!available} onClick={()=>perform(signal=>privateRequest(async generation=>{
      clear();const result=authenticationInventory(await api.get(`${root}/authentication-readback`,signal),run);
      if(generation!==epoch.current||signal?.aborted)return;
      const current=await api.get(root,signal);
      if(generation!==epoch.current||signal?.aborted)return;
      if(current.run.revision!==result.revision)throw new Error('The browser request evidence changed. Load it again before confirming.');
      setData(current);setInventory(result);
    }),'Authentication evidence loaded privately. Review each request.',{refresh:false})}>Load authentication request evidence</Action>
    {inventory&&available&&<><p>{inventory.inventory.requests.length} completed authentication-destination requests available. The destination role alone does not prove their purpose.</p>
      <ul className="space-y-3">{inventory.inventory.requests.map(request=><li key={request.request_ref} className="rounded-md border p-3 space-y-2 min-w-0">
        <p className="break-all">{request.method} · {request.origin}{request.path_preview}</p>
        <p>Payload: {request.body_bytes} bytes. Transport completed; the website's business outcome has not been inferred.</p>
        <details><summary className="min-h-11 cursor-pointer py-3">Exact request evidence</summary><dl className="space-y-2">
          {[['Request',request.request_ref],['Request binding SHA-256',request.binding_sha256],['Payload SHA-256',request.body_sha256],['Approval',request.approval_ref?.id],['Send ledger',request.ledger_send_ref],['Response ledger',request.ledger_response_ref]].map(([label,value])=><div key={label}><dt>{label}</dt><dd className="font-mono text-xs break-all">{value}</dd></div>)}
        </dl></details>
        <label className="min-h-11 flex items-start gap-3 py-2"><input type="checkbox" className="mt-1 shrink-0" disabled={busy} checked={selected.includes(request.request_ref)} onChange={event=>{setSelected(old=>event.target.checked?[...old,request.request_ref]:old.filter(ref=>ref!==request.request_ref));setReviewed(false);}}/><span>I reviewed this exact request and verified it was solely for sign-in or MFA.</span></label>
      </li>)}</ul>
      <label className="min-h-11 flex items-start gap-3 py-2"><input type="checkbox" className="mt-1 shrink-0" disabled={busy||!selected.length} checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/><span>{AUTHENTICATION_CONFIRMATION}</span></label>
      <Action aria-describedby={help} disabled={busy||!selected.length||!reviewed} onClick={()=>perform(signal=>privateRequest(async generation=>{
        const payload=authenticationPayload(inventory,selected,reviewed);
        const result=await api.write(`${root}/authentication-readback`,payload,payload.revision,'POST',signal);
        if(generation!==epoch.current||signal?.aborted)return;
        clear();setData(result);
      }),'Selected authentication confirmation recorded. Release and Resume remain explicit.',{refresh:false})}>Confirm selected authentication requests</Action>
      <Action variant="outline" disabled={busy} onClick={clear}>Clear private authentication evidence</Action>
    </>}
  </section>;
}
