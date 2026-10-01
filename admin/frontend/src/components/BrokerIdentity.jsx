import React, {useEffect,useRef,useState} from 'react';
import {acceptBrokerDelegation,brokerDelegationStatus,clearBrokerDelegation} from '../lib/api';
/** Broker-owned popup performs login/fresh consent. Dashboard accepts only the
 * exact opened WindowProxy + verified configured origin and current person. */
export default function BrokerIdentity({capabilities,currentUserId,onChange}) {
 const [status,setStatus]=useState(brokerDelegationStatus),[error,setError]=useState('');
 const pending=useRef(null);
 useEffect(()=>{const timer=setInterval(()=>setStatus(brokerDelegationStatus()),1000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{
  if(status?.user_id!==currentUserId){clearBrokerDelegation();setStatus(null);}
 },[currentUserId]);
 useEffect(()=>()=>{pending.current?.cleanup();pending.current?.popup?.close();},[]);
 const connect=()=>{
  setError('');pending.current?.cleanup();pending.current?.popup?.close();
  let origin;
  try{const u=new URL(capabilities?.intake_origin);if(capabilities.mode!=='configured'||capabilities.compatible!==true||u.protocol!=='https:'||u.origin!==capabilities.intake_origin||!currentUserId)throw Error();origin=u.origin;}
  catch{setError('Broker identity is unavailable. Refresh verified capabilities.');return;}
  const state=Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join('');
  const query=new URLSearchParams({dashboard_origin:window.location.origin,state});
  const popup=window.open(origin+'/auth/delegations?'+query,'fractionate-broker-identity','popup,width=540,height=720');
  if(!popup){setError('Allow this sign-in popup to connect your broker identity.');return;}
  const cleanup=()=>{window.removeEventListener('message',receive);clearTimeout(timeout);pending.current=null;};
  const receive=event=>{
   if(event.origin!==origin||event.source!==popup||event.data?.type!=='fractionate.broker.delegation'||event.data.state!==state)return;
   try{acceptBrokerDelegation(event.data,currentUserId);setStatus(brokerDelegationStatus());cleanup();popup.close();onChange?.();}
   catch{setError('The broker identity did not match your signed-in account.');cleanup();popup.close();}
  };
  const timeout=setTimeout(()=>{cleanup();popup.close();setError('Broker sign-in expired. Start again when ready.');},300000);
  window.addEventListener('message',receive);pending.current={cleanup,popup};
 };
 const disconnect=()=>{clearBrokerDelegation();setStatus(null);onChange?.();};
 if(capabilities?.mode!=='configured')return null;
 return <section aria-label="Broker identity" className="rounded-lg border bg-card p-4 space-y-3">
  <h3 className="font-semibold text-foreground">Broker identity</h3>
  <p className="text-sm text-muted-foreground">Confirm your identity directly with the credential broker. Access lasts up to five minutes in this tab.</p>
  {status?<><p role="status">Identity connected until {new Date(status.expires_at).toLocaleTimeString()}.</p><button className="min-h-11 rounded-md border border-input px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" type="button" onClick={disconnect}>Disconnect broker identity</button></>:<button className="min-h-11 rounded-md border border-input px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" type="button" onClick={connect}>Connect broker identity</button>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
