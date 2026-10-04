import {useEffect,useState} from 'react';
import {browserAgentsApi as api} from '@/lib/api';

// Public-only transient viewing. The normal authenticated client handles the
// request; frames never enter browser storage, artifacts, or model inputs.
export function PublicBrowserFrames({root,attemptId,fence}) {
  const [frame,setFrame]=useState(null),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let disposed=false,timer;
    setFrame(null);setError('');
    async function refresh(){
      let keepGoing=true,delay=5000;
      try{
        const value=await api.get(`${root}/public-frame?attempt_id=${encodeURIComponent(attemptId)}&fence=${fence}`,controller.signal);
        if(disposed)return;
        if(value.attempt_id!==attemptId||value.fence!==fence)throw Object.assign(new Error('Browser view changed.'),{status:409});
        setFrame(value);setError('');
      }catch(e){
        if(disposed)return;
        setFrame(null);
        keepGoing=![401,403,404,409].includes(e.status);
        delay=30000;
        const reason=e.code==='PUBLIC_VIEW_OBSERVATION_DESTINATION_UNAUTHORIZED'?
          'The current page could not be verified for viewing.':
          e.code==='PUBLIC_VIEW_SUPERVISOR_TIMEOUT'||e.code==='PUBLIC_VIEW_CANCELLED'?
          'The browser image request timed out.':
          e.code==='PUBLIC_VIEW_SUPERVISOR_UNREACHABLE'?
          'The browser runtime could not be reached.':
          e.status===429?'The browser image request is cooling down.':'The browser image is unavailable.';
        setError(`${reason} ${keepGoing?'Another image will be requested in 30 seconds. You can stop the browser at any time.':'Viewing has stopped. Check your session and the browser activity before opening again.'}`);
      }
      if(!disposed&&keepGoing)timer=setTimeout(refresh,delay);
    }
    refresh();
    return()=>{disposed=true;clearTimeout(timer);controller.abort();};
  },[root,attemptId,fence]);
  return <section aria-label="Live public browser images" className="space-y-2 min-w-0">
    <p className="text-sm">Video unavailable. Browser images refresh every five seconds while available.</p>
    {frame?<><img src={`data:image/png;base64,${frame.png_base64}`} width={frame.width} height={frame.height}
      alt="Current public website in the isolated browser" className="w-full max-w-full aspect-[16/10] object-contain rounded-md bg-zinc-950"/>
      <p className="text-xs text-muted-foreground break-words">Updated {frame.captured_at}</p></>:
      <p role="status" className="text-sm">{error||'Connecting to the browser image…'}</p>}
  </section>;
}
