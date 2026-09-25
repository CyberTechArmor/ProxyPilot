import { useEffect, useRef, useState } from 'react';
import { operationsApi as api } from '@/lib/api';
import { Action, Field, Choice } from './shared';

const exact = r => ({demonstration_id:r.demonstration_id,revision_id:r.revision_id,item_position:r.item_position,object_id:r.object_id,annotation_id:r.annotation_id});
const keyOf = r => JSON.stringify(exact(r));
const notice = 'Evidence unavailable. Retained identities are unchanged. Cancel or request changes if publication is refused; restore the reviewed capability before changing evidence selection.';
export const evidenceDisclaimer = 'Demonstration evidence never authorizes an agent action.';

// Every request belongs to this mounted account/operation scope. Invalidate before
// aborting so even a late resolved promise cannot restore cleared private state.
function useScope() {
  const scope=useRef(null);
  useEffect(()=>{const c=new AbortController();scope.current=c;return()=>{scope.current=null;c.abort();};},[]);
  return {signal:()=>scope.current?.signal,live:()=>!!scope.current&&!scope.current.signal.aborted};
}

export function EvidenceSet({base,evidence,enabled,refreshKey=0}) {
  const refs=evidence?.references||[];
  if(!refs.length)return null;
  return <section aria-label="Retained guide evidence" className="space-y-4 min-w-0">
    <h3 className="font-semibold">Exact guide evidence ({refs.length})</h3>
    {!enabled&&<p role="status">{notice}</p>}
    {evidence.manifest_hash&&<details><summary className="min-h-11 py-3 cursor-pointer">Evidence manifest hash</summary><p className="text-xs break-all">{evidence.manifest_hash}</p></details>}
    <ol className="space-y-4">{refs.map((r,i)=><li key={keyOf(r)} className="border rounded-md p-3 space-y-3 min-w-0"><h4 className="font-medium">Evidence {i+1}</h4><Identity reference={r}/>
      {enabled&&r.available?<FrozenItem key={`${keyOf(r)}:${refreshKey}`} base={base} reference={r}/>:<p role="status">{notice}</p>}
    </li>)}</ol>
  </section>;
}
function Identity({reference:r}) {
  return <details><summary className="min-h-11 py-3 cursor-pointer">Exact evidence identities</summary><dl className="text-xs break-all space-y-2">{Object.entries(r).filter(([k])=>['demonstration_id','revision_id','item_position','object_id','annotation_id','sha256','annotation_hash','publication_hash'].includes(k)).map(([k,v])=><div key={k}><dt>{k.replaceAll('_',' ')}</dt><dd>{String(v)}</dd></div>)}</dl></details>;
}
function FrozenItem({base,reference:r,onUnavailable=()=>{}}) {
  const [item,setItem]=useState(null),[error,setError]=useState(''),scope=useScope();
  useEffect(()=>{api.get(`${base}/demonstrations/${r.demonstration_id}/revisions/${r.revision_id}`,scope.signal()).then(pub=>{
    if(!scope.live())return;
    const found=pub.items.find(i=>i.position===r.item_position&&i.object.id===r.object_id&&i.annotation_id===r.annotation_id);
    if(!pub.available||!found?.available||!found.annotation||(r.annotation_hash&&r.annotation_hash!==found.content_hash)||(r.sha256&&r.sha256!==found.object.sha256))throw new Error(notice);
    setItem(found);
  }).catch(e=>{if(scope.live()){setItem(null);setError(e.message);onUnavailable();}});},[]);
  if(error)return <p role="status">{notice}</p>;
  if(!item)return <p role="status">Checking exact evidence…</p>;
  return <ReturnedImage base={base} demo={r.demonstration_id} object={item.object} annotation={item.annotation} onUnavailable={()=>{setItem(null);setError(notice);onUnavailable();}}/>;
}
function ReturnedImage({base,demo,object,annotation,onUnavailable=()=>{}}) {
  const [url,setUrl]=useState(''),[failed,setFailed]=useState(false),[zoom,setZoom]=useState(false),scope=useScope();
  useEffect(()=>{let local='';api.download(`${base}/demonstrations/${demo}/evidence/${object.id}/download`,scope.signal()).then(blob=>{
    if(!scope.live())return;local=URL.createObjectURL(blob);setUrl(local);
  }).catch(()=>{if(scope.live()){setFailed(true);onUnavailable();}});return()=>{if(local)URL.revokeObjectURL(local);};},[object.id]);
  if(failed)return <p role="status">{notice}</p>;
  if(!url)return <p role="status">Reauthorizing image…</p>;
  return <figure className="space-y-3 min-w-0">
    <img src={url} alt={annotation?.text||'Returned private derivative for pixel and privacy inspection; add a text alternative before sharing.'} className={`max-w-full h-auto rounded border ${zoom?'':'max-h-80 object-contain'}`}/>
    {annotation&&<figcaption className="space-y-2"><p className="font-medium break-words [overflow-wrap:anywhere]">{annotation.label}</p><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{annotation.text}</p></figcaption>}
    <Action type="button" variant="outline" aria-pressed={zoom} onClick={()=>setZoom(!zoom)}>{zoom?'Fit image':'Enlarge image'}</Action>
    <p className="text-xs text-muted-foreground">Authenticated returned pixels. Browser zoom is also available. Already delivered bytes cannot be recalled; access is rechecked on refresh and every 30 seconds.</p>
  </figure>;
}

export function Demonstrations({base,user,project,draft,guideDirty,busy,onSelectionSaved,onSelectionDirty,onEvidenceChanged,refreshKey}) {
  const [list,setList]=useState([]),[cursor,setCursor]=useState(null),[demo,setDemo]=useState(null),[workspace,setWorkspace]=useState(null);
  const [title,setTitle]=useState(''),[purpose,setPurpose]=useState(''),[working,setWorking]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [selection,setSelection]=useState(()=>draft.evidence?.references.map(exact)||[]),[selectionRevision,setSelectionRevision]=useState(draft.revision);
  const scope=useScope(),errRef=useRef(null),keys=useRef(new Map()),openGeneration=useRef(0),privacyEpoch=useRef(0);
  const invalidateRead=()=>{privacyEpoch.current++;openGeneration.current++;};
  const active=!project.archived_at,author=demo?.created_by===user.id,owner=project.own_role==='owner';
  const canCreate=active&&project.own_role!=='viewer',canSelect=active&&['owner','editor'].includes(project.own_role)&&draft.status==='draft';
  const selectionDirty=JSON.stringify(selection)!==JSON.stringify(draft.evidence?.references.map(exact)||[]);
  useEffect(()=>{onSelectionDirty(selectionDirty);return()=>onSelectionDirty(false);},[selectionDirty]);
  useEffect(()=>{if(error)errRef.current?.focus();},[error]);
  // Advance the shared draft revision only when the local selection still equals
  // the server. A conflict never silently rebases a modified selection.
  useEffect(()=>{if(!selectionDirty)setSelectionRevision(draft.revision);},[draft.revision]);
  const retryBody=(action,body)=>{const signature=JSON.stringify({action,body});if(!keys.current.has(signature))keys.current.set(signature,crypto.randomUUID());return {...body,idempotency_key:keys.current.get(signature)};};
  const write=(path,body,revision,method)=>api.write(`${base}/demonstrations${path}`,body,revision,method,scope.signal());
  async function load(append=false) {
    const epoch=privacyEpoch.current;
    const result=await api.get(`${base}/demonstrations${append&&cursor?`?after=${cursor}`:''}`,scope.signal());
    if(scope.live()&&epoch===privacyEpoch.current){setList(old=>append?[...old,...result.demonstrations]:result.demonstrations);setCursor(result.next_cursor);}
  }
  async function open(id) {
    const generation=++openGeneration.current;
    const d=await api.get(`${base}/demonstrations/${id}`,scope.signal());
    const w=d.created_by===user.id?await api.get(`${base}/demonstrations/${id}/workspace`,scope.signal()):null;
    if(scope.live()&&generation===openGeneration.current){setDemo(d);setWorkspace(w);}
  }
  async function run(fn,success='Saved.',recheck=true) {
    if(working)return;setWorking(true);setError('');setMessage('');
    try{await fn();if(scope.live()){if(recheck)await onEvidenceChanged();if(scope.live())setMessage(success);}}
    catch(e){if(scope.live()){setError(e.status===412?`${e.message}. Input retained. Compare server state, then explicitly reload before retrying.`:e.message);
      if([401,403,404].includes(e.status)){invalidateRead();setDemo(null);setWorkspace(null);setList([]);setTitle('');setPurpose('');setSelection([]);await onEvidenceChanged().catch(()=>{});}}}
    finally{if(scope.live())setWorking(false);}
  }
  useEffect(()=>{load().then(()=>demo?open(demo.id):null).catch(e=>{if(scope.live()){invalidateRead();setDemo(null);setWorkspace(null);setList([]);setError(e.message);}});},[refreshKey]);
  const add=r=>{if(selection.length>=20){setError('A guide can select at most 20 references.');return;}if(!selection.some(s=>keyOf(s)===keyOf(r)))setSelection([...selection,exact(r)]);};
  return <section aria-label="Demonstrations" className="space-y-5 border-t pt-4 min-w-0">
    <h3 className="text-lg font-semibold">Demonstrations</h3><p className="text-sm">Private still images become shared only after explicit privacy review. Your role: {project.own_role}.</p>
    {error&&<p ref={errRef} tabIndex={-1} role="alert" className="text-destructive break-words">{error}</p>}<p role="status">{working?'Working…':message}</p>
    {canCreate&&<form className="space-y-3" onSubmit={e=>{e.preventDefault();run(async()=>{const d=await write('',retryBody('create',{title,purpose}));await open(d.id);await load();setTitle('');setPurpose('');},'Private demonstration created.');}}>
      <Field label="Private demonstration title" required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/><Field label="Private purpose" textarea maxLength={2000} value={purpose} onChange={e=>setPurpose(e.target.value)}/><Action disabled={working}>Create private demonstration</Action>
    </form>}
    <ul className="space-y-2">{list.map(d=><li key={d.id}><Action variant="outline" disabled={working} onClick={()=>run(()=>open(d.id),'Demonstration loaded.')}>{d.title||'Shared demonstration'} · {d.revisions.length?'Shared revisions':'Private'}{d.archived_at?' · Archived':''}</Action></li>)}</ul>
    {cursor&&<Action disabled={working} variant="outline" onClick={()=>run(()=>load(true),'More demonstrations loaded.',false)}>Load more demonstrations</Action>}
    {demo&&<div className="border rounded-md p-3 space-y-4 min-w-0"><h4 className="font-semibold break-words">{demo.title||'Shared demonstration'}</h4><p className="text-sm">{author?'You are the original author. Originals and unshared derivatives are private.':'Shared evidence only. Ownership and administrator status grant no access to another author’s originals.'}</p>
      <Action disabled={working} variant="outline" onClick={()=>run(()=>open(demo.id),'Server demonstration refreshed; form input retained.')}>Compare server demonstration</Action>
      {author&&workspace&&<AuthorWorkspace key={demo.id} {...{base,demo,workspace,active,refreshKey}} disabled={!canCreate||!!demo.archived_at} write={write} retryBody={retryBody} run={run} reload={()=>open(demo.id)} setWorkspace={setWorkspace} invalidateRead={invalidateRead}/>}
      {demo.revisions.map(pub=><section key={pub.id} className="space-y-3 border-t pt-3"><h4 className="font-medium">Shared immutable revision</h4><p className="text-xs break-all">{pub.id}</p>
        {pub.available?<p className="whitespace-pre-wrap break-words">{pub.summary}</p>:<p role="status">{notice}</p>}
        <ol className="space-y-4">{pub.items.map(item=>{const r={demonstration_id:demo.id,revision_id:pub.id,item_position:item.position,object_id:item.object.id,annotation_id:item.annotation_id};return <li key={item.position} className="space-y-3"><p>Step {item.position+1}</p><Identity reference={r}/>{item.available?<FrozenItem key={`${keyOf(r)}:${refreshKey}`} base={base} reference={r} onUnavailable={()=>{invalidateRead();setDemo(old=>old?{...old,revisions:old.revisions.map(x=>x.id===pub.id?{...x,available:false,summary:null,items:x.items.map(i=>({...i,available:false,annotation:null}))}:x)}:old);}}/>:<p role="status">{notice}</p>}{canSelect&&item.available&&<Action type="button" disabled={working||selection.some(s=>keyOf(s)===keyOf(r))||selection.length>=20} onClick={()=>add(r)}>Select step {item.position+1} for draft</Action>}{active&&(owner||author)&&<Moderation {...{demo,write,run}} objectId={item.object.id} owner={owner} reload={()=>open(demo.id)}/>}</li>;})}</ol>
      </section>)}
      {active&&(owner||author)&&!demo.archived_at&&<Action variant="outline" disabled={working} onClick={()=>run(async()=>{await write(`/${demo.id}/archive`,{reason:'Archived by human review'},demo.demonstration_revision);await open(demo.id);},'Demonstration archived; mutations frozen.')}>Archive demonstration</Action>}
      {author&&workspace&&active&&workspace.objects.map(o=><div key={o.id} className="space-y-2"><p className="text-xs break-all">Private object {o.id}</p><Moderation {...{demo,write,run}} objectId={o.id} owner={owner} reload={()=>open(demo.id)}/></div>)}
    </div>}
    {canSelect&&<section className="space-y-3"><h4 className="font-semibold">Draft evidence selection ({selection.length}/20)</h4><p>{evidenceDisclaimer}</p><p className="text-sm">Detaching evidence does not restore approval eligibility for any contributor. Save guide text before saving evidence selection.</p>
      <ol className="space-y-3">{selection.map((r,i)=><li key={keyOf(r)} className="border rounded-md p-3 space-y-2"><p>Selection {i+1}</p><Identity reference={r}/><div className="flex flex-wrap gap-2"><Action variant="outline" disabled={i===0} onClick={()=>setSelection(move(selection,i,-1))}>Move selection {i+1} up</Action><Action variant="outline" disabled={i===selection.length-1} onClick={()=>setSelection(move(selection,i,1))}>Move selection {i+1} down</Action><Action variant="outline" onClick={()=>setSelection(selection.filter((_,n)=>n!==i))}>Detach selection {i+1}</Action></div></li>)}</ol>
      <div className="flex flex-wrap gap-2"><Action disabled={working||busy||guideDirty||!selectionDirty} onClick={()=>run(async()=>{const result=await api.write(`${base}/draft/evidence`,{references:selection},selectionRevision,'PUT',scope.signal());if(scope.live()){setSelectionRevision(result.revision??result.draft?.revision);await onSelectionSaved(result.revision);}},'Exact evidence selection saved.')}>Save evidence selection</Action><Action variant="outline" disabled={working||guideDirty} onClick={()=>setSelectionRevision(draft.revision)}>Use compared server revision for retained selection</Action><Action variant="outline" disabled={working} onClick={()=>{setSelection(draft.evidence?.references.map(exact)||[]);setSelectionRevision(draft.revision);}}>Discard local selection and reload server</Action></div>
      {guideDirty&&<p role="status">Save or explicitly discard local guide changes before saving selection.</p>}
      {selectionDirty&&<details><summary className="min-h-11 py-3 cursor-pointer">Compare server selection</summary><pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(draft.evidence?.references.map(exact)||[],null,2)}</pre></details>}
    </section>}
  </section>;
}
function move(rows,i,delta){const next=[...rows];[next[i],next[i+delta]]=[next[i+delta],next[i]];return next;}
function Moderation({demo,objectId,owner,write,run,reload}) {
  const [reason,setReason]=useState('privacy');
  return <div className="space-y-3"><Choice label="Evidence restriction or retention reason" value={reason} onChange={e=>setReason(e.target.value)}>{['privacy','incorrect','retention','other'].map(r=><option key={r}>{r}</option>)}</Choice><div className="flex flex-wrap gap-2">{[['restrict','Restrict reads now'],['deletion-request','Request deletion']].map(([path,label])=><Action key={path} type="button" variant="outline" onClick={()=>run(async()=>{await write(`/${demo.id}/evidence/${objectId}/${path}`,{reason},demo.demonstration_revision);await reload();},'Reads restricted. Physical deletion is deferred.')}>{label}</Action>)}{owner&&[true,false].map(held=><Action key={String(held)} type="button" variant="outline" onClick={()=>run(async()=>{await write(`/${demo.id}/evidence/${objectId}/hold`,{held,reason},demo.demonstration_revision);await reload();},'Retention hold updated; access unchanged.')}>{held?'Place retention hold':'Release retention hold'}</Action>)}</div><p className="text-xs">Restriction denies new reads immediately. Deletion is deferred at least 24 hours and until holds and active leases permit maintenance. A hold grants no access. Private retention is seven days from reservation; published derivatives persist until removal. Expiry is not proof of physical erasure.</p></div>;
}

function AuthorWorkspace({base,demo,workspace,disabled,active,write,retryBody,run,reload,setWorkspace,refreshKey,invalidateRead}) {
  const [transferError,setTransferError]=useState('');
  const [file,setFile]=useState(null),[kind,setKind]=useState('raw'),[parent,setParent]=useState(''),[receipt,setReceipt]=useState(null),[progress,setProgress]=useState(null),[transfer,setTransfer]=useState(false);
  const [chosen,setChosen]=useState([]),[summary,setSummary]=useState(''),[reviewed,setReviewed]=useState(false),[shareRevision,setShareRevision]=useState(demo.demonstration_revision);
  const controller=useRef(null),scope=useScope();
  useEffect(()=>()=>controller.current?.abort(),[]);
  useEffect(()=>{if(!chosen.length&&!summary)setShareRevision(demo.demonstration_revision);},[demo.demonstration_revision]);
  const live=scope.live;
  async function reserve(){
    const sha256=await digest(file);
    const payload={kind,parent_raw_id:kind==='raw'?null:parent,byte_count:file.size,mime:file.type,sha256};
    const body=receipt&&['cancelled','expired','finalized'].includes(receipt.state)?{...payload,idempotency_key:crypto.randomUUID()}:retryBody('upload',payload);
    const result=await write(`/${demo.id}/uploads`,body);
    if(live())setReceipt({...result,...body});
    await reload();
  }
  async function send(){
    if(!receipt||!file)throw new Error('Reselect the exact file before retrying.');
    if(file.size!==receipt.byte_count||file.type!==receipt.mime||await digest(file)!==receipt.sha256)throw new Error('File differs from the reservation. Reserve a new upload with a new retry key.');
    if(!live())return;
    const c=new AbortController();controller.current=c;setTransfer(true);
    try{const status=await api.get(`${base}/demonstrations/${demo.id}/uploads/${receipt.id}`,c.signal);
      if(['cancelled','expired'].includes(status.state)||Date.parse(status.expires_at)<=Date.now())throw new Error('Upload lease expired or closed. Reserve a new upload.');
      let result=status;
      if(status.state==='reserved')result=await api.upload(`${base}/demonstrations/${demo.id}/uploads/${receipt.id}/bytes`,file,c.signal,(loaded,total)=>{if(live())setProgress(Math.round(loaded/total*100));});
      if(live())setReceipt({...receipt,...result});
    }finally{if(live())setTransfer(false);controller.current=null;await reload();}
  }
  return <div className="space-y-4">
    <h4 className="font-medium">Private still-image intake</h4>{transferError&&<p role="alert">{transferError}</p>}<p className="text-sm">PNG or JPEG, 1–8,388,608 bytes; at most 8192 pixels per edge and 16 million pixels. Single-frame 8-bit noninterlaced PNG; strict JPEG. The server decoder is authoritative. At most 20 originals and three derivatives per original.</p>
    {!disabled&&<><Choice label="Image purpose" value={kind} onChange={e=>{setKind(e.target.value);setReceipt(null);}}><option value="raw">Private original</option><option value="derivative">Externally redacted replacement derivative</option></Choice>
      {kind==='derivative'&&<Choice label="Author’s original" value={parent} onChange={e=>{setParent(e.target.value);setReceipt(null);}}><option value="">Choose original</option>{workspace.objects.filter(o=>o.kind==='raw'&&o.available).map(o=><option key={o.id} value={o.id}>{o.id}</option>)}</Choice>}
      <Field label="PNG or JPEG file" type="file" accept="image/png,image/jpeg" onChange={e=>{setFile(e.target.files?.[0]||null);setProgress(null);}}/>
      <p className="text-sm">Select a separate, externally redacted file for a derivative. Nothing auto-shares. Refresh discards file bytes; server receipts can be recovered below, with file reselection. Transfers restart as a whole file; there is no chunk resume.</p>
      <Action type="button" disabled={!file||transfer||(kind==='derivative'&&!parent)} onClick={()=>run(reserve,'Reserved; inspect the server retention deadline before transferring.')}>Reserve selected file</Action></>}
    {receipt&&<div className="space-y-3 border rounded-md p-3"><p className="break-all">Receipt {receipt.id}: {receipt.state}</p><p>Server private-retention deadline: {receipt.private_expires_at}</p><p>Upload lease expires: {receipt.expires_at}</p><p className="text-sm">{receipt.byte_count} bytes · {receipt.mime}</p>
      {progress!==null&&<><label htmlFor="evidence-progress">Transfer progress: {progress}%</label><progress id="evidence-progress" max="100" value={progress} className="w-full"/></>}
      <p role="status">{transfer?'Transferring…':receipt.state==='received'?'Bytes received; finalize for decoder validation.':receipt.state==='finalized'?'Finalized. Inspect the returned derivative below.':''}</p>
      <div className="flex flex-wrap gap-2">{!disabled&&!['cancelled','expired','finalized'].includes(receipt.state)&&<><Action type="button" disabled={!file||transfer||receipt.state==='received'} onClick={()=>run(send,'Bytes received; finalize explicitly.')}>Transfer or retry exact file</Action><Action type="button" disabled={transfer||receipt.state!=='received'} onClick={()=>run(async()=>{const r=await write(`/${demo.id}/uploads/${receipt.id}/finalize`,{});if(live())setReceipt({...receipt,...r});await reload();},'Decoder finalized; original stays private.')}>Finalize upload</Action><Action type="button" variant="outline" onClick={async()=>{controller.current?.abort();setTransferError('');try{const r=await write(`/${demo.id}/uploads/${receipt.id}/cancel`,{});if(live())setReceipt({...receipt,...r});await reload();}catch(e){if(live())setTransferError(e.message);}}}>Cancel upload</Action></>}
      {transfer&&<Action type="button" variant="outline" onClick={()=>controller.current?.abort()}>Interrupt transfer</Action>}
      <Action type="button" variant="outline" onClick={()=>run(async()=>{const r=await api.get(`${base}/demonstrations/${demo.id}/uploads/${receipt.id}`,scope.signal());if(live())setReceipt({...receipt,...r});await reload();},'Receipt reauthorized.')}>Check server receipt</Action></div>
    </div>}
    <details><summary className="min-h-11 py-3 cursor-pointer">Recover server upload receipts</summary><ul className="space-y-3">{workspace.uploads.map(u=><li key={u.id} className="space-y-2"><p className="text-xs break-all">{u.id} · {u.kind} · {u.state}</p><Action type="button" variant="outline" onClick={()=>{setReceipt(u);setKind(u.kind);setParent(u.parent_raw_id||'');setFile(null);}}>Recover receipt {u.id.slice(0,8)}</Action></li>)}</ul></details>
    {workspace.next_cursor&&<Action type="button" variant="outline" onClick={()=>run(async()=>{const w=await api.get(`${base}/demonstrations/${demo.id}/workspace?after=${workspace.next_cursor}`,scope.signal());if(live())setWorkspace({...w,uploads:[...workspace.uploads,...w.uploads],objects:[...workspace.objects,...w.objects]});},'More private receipts loaded.',false)}>Load more private receipts</Action>}
    {workspace.objects.filter(o=>o.kind==='derivative'&&o.available).map(o=><section key={o.id} className="space-y-3 border-t pt-3"><h4 className="font-medium">Private derivative</h4><p className="text-xs break-all">{o.id} · SHA-256 {o.sha256} · Hold: {o.held?'yes':'no'}</p><ReturnedImage key={`${o.id}:${refreshKey}`} {...{base}} demo={demo.id} object={o} onUnavailable={()=>{invalidateRead();setWorkspace(old=>({...old,objects:old.objects.map(x=>x.id===o.id?{id:o.id,available:false,annotations:[]}:x)}));}}/>
      {!disabled&&<AnnotationForm {...{demo,write,retryBody,run,reload}} object={o}/>}
      <ul className="space-y-2">{o.annotations.map(a=><li key={a.id} className="space-y-2"><p className="break-words">{a.label}: {a.text}</p>{!disabled&&<Action type="button" variant="outline" disabled={chosen.includes(a.id)} onClick={()=>{setChosen([...chosen,a.id]);setShareRevision(demo.demonstration_revision);setReviewed(false);}}>Include annotation {a.label}</Action>}</li>)}</ul>
    </section>)}
    {!disabled&&<section className="space-y-3"><h4 className="font-medium">Privacy review and explicit sharing</h4><p>{evidenceDisclaimer}</p><p className="text-sm">Inspect the returned derivative pixels above and every text alternative. Sharing creates a new immutable publication visible to current operation members.</p><ol className="space-y-2">{chosen.map((id,i)=><li key={id} className="space-y-2"><p className="text-xs break-all">Step {i+1}: {id}</p><div className="flex flex-wrap gap-2"><Action variant="outline" disabled={i===0} onClick={()=>{setChosen(move(chosen,i,-1));setReviewed(false);}}>Move step {i+1} up</Action><Action variant="outline" disabled={i===chosen.length-1} onClick={()=>{setChosen(move(chosen,i,1));setReviewed(false);}}>Move step {i+1} down</Action><Action variant="outline" onClick={()=>{setChosen(chosen.filter(x=>x!==id));setReviewed(false);}}>Remove step {i+1}</Action></div></li>)}</ol>
      <Field label="Shared demonstration summary" textarea maxLength={2000} value={summary} onChange={e=>{setSummary(e.target.value);setReviewed(false);}}/><label className="flex min-h-11 gap-3 items-center"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/><span>I inspected the returned pixels and text and approve sharing this exact selection.</span></label><div className="flex flex-wrap gap-2"><Action disabled={!reviewed||!chosen.length} onClick={()=>run(async()=>{await write(`/${demo.id}/share`,retryBody('share',{annotation_ids:chosen,summary,privacy_reviewed:true}),shareRevision);setChosen([]);setSummary('');setReviewed(false);await reload();},'New immutable revision shared.')}>Share reviewed revision</Action><Action variant="outline" onClick={()=>{setShareRevision(demo.demonstration_revision);setReviewed(false);}}>Use compared demonstration revision for sharing</Action><Action variant="outline" onClick={()=>{setChosen([]);setSummary('');setReviewed(false);setShareRevision(demo.demonstration_revision);}}>Discard sharing input and reload revision</Action></div></section>}
  </div>;
}
function AnnotationForm({demo,object,write,retryBody,run,reload}) {
  const [label,setLabel]=useState(''),[text,setText]=useState(''),[predecessor,setPredecessor]=useState(''),[revision,setRevision]=useState(demo.demonstration_revision);
  useEffect(()=>{if(!label&&!text)setRevision(demo.demonstration_revision);},[demo.demonstration_revision]);
  return <form className="space-y-3" onSubmit={e=>{e.preventDefault();run(async()=>{await write(`/${demo.id}/annotations`,retryBody('annotation',{object_id:object.id,predecessor_id:predecessor||null,label,text}),revision);setLabel('');setText('');setPredecessor('');await reload();},'New immutable annotation saved.');}}><Choice label="Annotation revision to replace (optional)" value={predecessor} onChange={e=>setPredecessor(e.target.value)}><option value="">New step</option>{object.annotations.map(a=><option key={a.id} value={a.id}>{a.label} · {a.id}</option>)}</Choice><Field label="Step label" required maxLength={200} value={label} onChange={e=>setLabel(e.target.value)}/><Field label="Step description and image text alternative" textarea required maxLength={2000} value={text} onChange={e=>setText(e.target.value)}/><div className="flex flex-wrap gap-2"><Action>Save new annotation revision</Action><Action type="button" variant="outline" onClick={()=>setRevision(demo.demonstration_revision)}>Use compared demonstration revision for annotation</Action><Action type="button" variant="outline" onClick={()=>{setLabel('');setText('');setPredecessor('');setRevision(demo.demonstration_revision);}}>Discard annotation input and reload revision</Action></div></form>;
}
async function digest(file){if(!file||!['image/png','image/jpeg'].includes(file.type)||file.size<1||file.size>8388608)throw new Error('Select PNG/JPEG between 1 and 8,388,608 bytes.');return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');}
