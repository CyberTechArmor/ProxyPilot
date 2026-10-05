import { z } from 'zod';
import { fail, parse } from './operational-projects-logic.js';

export const timingSchema=z.object({frequency:z.enum(['once','daily','weekly']),
  date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  weekday:z.number().int().min(0).max(6).optional(), timezone:z.string().min(1).max(100)}).strict();
export function scheduleTiming(input) {
  const v=parse(timingSchema,input);
  try { new Intl.DateTimeFormat('en-US',{timeZone:v.timezone}).format(); } catch { fail(400,'Choose a valid timezone'); }
  if(v.frequency==='once'&&(!v.date||!Number.isFinite(Date.parse(v.date+'T00:00Z'))||new Date(v.date+'T00:00Z').toISOString().slice(0,10)!==v.date))fail(400,'Choose a valid date');
  if(v.frequency==='weekly'&&v.weekday==null)fail(400,'Choose a weekday');
  return v;
}
const formatter=timezone=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'});
function parts(format,date) {const p=Object.fromEntries(format.formatToParts(date).map(v=>[v.type,v.value]));return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`,weekday:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday)};}
export function occurrenceKey(timing,date) {const p=parts(formatter(timing.timezone),date);return p.date+'T'+p.time;}
// Minute resolution; evaluate wall time in the selected IANA zone. Spring gaps
// are skipped; both fall-back instants share one durable occurrence key.
export function nextSchedule(timing,after,{excludeKey=null}={}) {
  const format=formatter(timing.timezone),now=after.getTime();
  let begin=Math.floor(now/60000)*60000+60000,end=begin+8*86400000;
  if(timing.frequency==='once') {
    const date=Date.parse(timing.date+'T00:00Z');
    if(!Number.isFinite(date))return null;
    begin=Math.max(begin,date-86400000);end=date+2*86400000;
  }
  for(let t=begin;t<end;t+=60000) {
    const p=parts(format,new Date(t));
    if(p.time!==timing.time||p.date+'T'+p.time===excludeKey)continue;
    if(timing.frequency==='once'&&p.date!==timing.date||timing.frequency==='weekly'&&p.weekday!==timing.weekday)continue;
    return new Date(t).toISOString();
  }
  return null;
}
