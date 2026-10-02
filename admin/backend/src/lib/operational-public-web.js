import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

export const webError = code => Object.assign(new Error(code), { code });
export const digest = value => createHash('sha256').update(value).digest('hex');
export const WEB_LIMITS = Object.freeze({ page_bytes: 524288, total_bytes: 1048576, requests: 20,
  redirects: 5, request_ms: 10000, excerpt_chars: 3500 });

// Fail closed on special-use IPv4 and all IPv6 in this initial strategy. Every
// DNS answer is screened; a public answer mixed with a private one is refused.
export function publicAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 0 && c === 2) || (a === 198 && [18,19].includes(b))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}
export function publicUrl(value, protectedHosts = []) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f]/.test(value)) throw webError('URL_UNSUPPORTED');
  let u; try { u = new URL(value); } catch { throw webError('URL_UNSUPPORTED'); }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const protectedNames=typeof protectedHosts==='function'?protectedHosts():protectedHosts;
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.hash || u.port
    || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host)
    || /(?:^|[.-])(?:metadata|openbao|vaultwarden|infisical|proxypilot|vault)(?:[.-]|$)/.test(host)
    || protectedNames.some(h => host === h.toLowerCase().replace(/\.$/, '') || host.endsWith(`.${h.toLowerCase()}`))
    || /^\/(?:api\/(?:auth|security|lxc|services|self|setup|mcp|terminal|operations-settings)(?:\/|$)|v1\/(?:sys|auth|secret|kv)(?:\/|$))/i.test(u.pathname))
    throw webError('DESTINATION_DENIED');
  if (isIP(host) && !publicAddress(host)) throw webError('DESTINATION_DENIED');
  u.hostname = host;
  return u.href;
}

// No global fetch, proxy environment, cookie jar, auth header or user-supplied
// headers. The screened address is used by the actual socket, not a second DNS
// lookup. TLS retains the original hostname and certificate verification.
export function createPublicFetcher({ resolve = host => dnsLookup(host,{family:4,all:true}), protectedHosts = [], protectedAddresses = [],
  request = (u,options,callback)=>(u.protocol==='https:'?https:http).request(u,options,callback) } = {}) {
  return async function fetchPublic(value, budget, { maxBytes = WEB_LIMITS.page_bytes, beforeHop = null } = {}) {
    let url = publicUrl(value, protectedHosts);
    for (let hop = 0; ; hop++) {
      budget.check();
      if(beforeHop)await beforeHop(url);
      if (++budget.requests > WEB_LIMITS.requests) throw webError('REQUEST_LIMIT');
      const u = new URL(url);
      // DNS is covered by the same request deadline and cancellation as the
      // socket. A resolver that never answers cannot retain a live review.
      const answers = isIP(u.hostname) ? [{address:u.hostname,family:4}] : await new Promise((done,reject)=>{
        const abort=()=>finish(webError('CANCELLED'));let settled=false;
        const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);budget.signal.removeEventListener('abort',abort);error?reject(error):done(value);};
        const timer=setTimeout(()=>finish(webError('FETCH_TIMEOUT')),Math.min(WEB_LIMITS.request_ms,budget.remaining()));
        budget.signal.addEventListener('abort',abort,{once:true});
        if(budget.signal.aborted)abort();else Promise.resolve().then(()=>resolve(u.hostname)).then(value=>finish(null,value),()=>finish(webError('FETCH_FAILED')));
      });
      budget.check();
      if (!Array.isArray(answers) || !answers.length || answers.some(a => !publicAddress(a.address)||protectedAddresses.includes(a.address)))
        throw webError('DESTINATION_DENIED');
      const chosen = answers[0];
      const response = await new Promise((done, reject) => {
        let settled = false, timer;
        const finish = (err, result) => { if (settled) return; settled=true; clearTimeout(timer);
          budget.signal.removeEventListener('abort', abort); err ? reject(err) : done(result); };
        const req = request(u, {
          method:'GET', agent:false, headers:{'User-Agent':'ProxyPilotReview/1.0','Accept':'text/html,text/plain;q=0.9',
            'Accept-Encoding':'identity','Connection':'close'},
          lookup:(_host,opts,cb) => cb(null,opts?.all ? [chosen] : chosen.address,chosen.family),
        }, res => {
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
            res.destroy(); finish(webError('ENCODING_UNSUPPORTED')); return;
          }
          if (Number(res.headers['content-length']) > maxBytes) {res.destroy();finish(webError('CONTENT_TOO_LARGE'));return;}
          const parts=[]; let size=0;
          res.on('data', chunk => {
            size+=chunk.length; budget.bytes+=chunk.length;
            if (size > maxBytes || budget.bytes > WEB_LIMITS.total_bytes) { res.destroy();finish(webError('CONTENT_TOO_LARGE'));return; }
            parts.push(chunk);
          });
          res.on('error',()=>finish(webError('FETCH_FAILED')));
          res.on('end',()=>finish(null,{url,status:res.statusCode,type:String(res.headers['content-type']||''),
            location:res.headers.location,body:Buffer.concat(parts).toString('utf8'),bytes:size}));
        });
        const abort=()=>{req.destroy();finish(webError('CANCELLED'));};
        req.on('socket',socket=>socket.prependOnceListener(u.protocol==='https:'?'secureConnect':'connect',()=>{
          try{budget.check();}catch(e){req.destroy();finish(e);}
        }));
        budget.signal.addEventListener('abort',abort,{once:true});
        timer=setTimeout(()=>{req.destroy();finish(webError('FETCH_TIMEOUT'));},Math.min(WEB_LIMITS.request_ms,budget.remaining()));
        req.on('error',()=>finish(webError('FETCH_FAILED')));
        if (budget.signal.aborted) abort(); else req.end();
      });
      budget.check();
      if ([301,302,303,307,308].includes(response.status)) {
        if (!response.location || hop >= WEB_LIMITS.redirects) throw webError('REDIRECT_LIMIT');
        try{url = publicUrl(new URL(response.location,url).href,protectedHosts);}catch(e){throw e.code?e:webError('URL_UNSUPPORTED');}
        continue;
      }
      return response;
    }
  };
}
const decode = text => text.replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(x[0-9a-f]+|[0-9]+);/gi,(v,n)=> {
  if(n) {const c=parseInt(n.startsWith('x')?n.slice(1):n,n.startsWith('x')?16:10);return c>0&&c<=0x10ffff?String.fromCodePoint(c):'';}
  return ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '})[v.toLowerCase()]||v;
});
export function extractPage(response) {
  if ([401,407].includes(response.status)) throw webError('AUTH_REQUIRED');
  if ([403,429,451].includes(response.status)) throw webError('SITE_BLOCKED');
  if (response.status < 200 || response.status >= 300) throw webError('HTTP_ERROR');
  if (!/^(?:text\/html|application\/xhtml\+xml|text\/plain)(?:;|$)/i.test(response.type)) throw webError('CONTENT_UNSUPPORTED');
  const html=/html/i.test(response.type), body=response.body;
  const title=decode((html?body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]:'')||'').replace(/<[^>]*>/g,'').trim().slice(0,200).toWellFormed();
  const text=decode(html?body.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<[^>]*>/g,' '):body).replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').replace(/\s+/g,' ').trim().toWellFormed();
  if (/just a moment|checking your browser|verify you are human|enable javascript.*(?:continue|view)|captcha challenge/i.test(`${title} ${text.slice(0,1200)}`)) throw webError('SITE_BLOCKED');
  if (/sign in to (?:continue|read)|subscribe to (?:continue|read)|this (?:article|content) is (?:only )?for subscribers/i.test(text.slice(0,1500))) throw webError('AUTH_OR_PAYWALL');
  if (text.length < 100) throw webError(html&&/<script\b/i.test(body)?'CLIENT_RENDER_REQUIRED':'CONTENT_EMPTY');
  const links=html?[...body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].slice(0,100).map(m=>m[1]):[];
  return {url:response.url,title,text,content_hash:digest(text),bytes:response.bytes,links};
}
// RFC-style most-specific matching for this read-only crawler, including '*'
// and '$'. A malformed/oversized robots response is refused by the transport.
export function robotsAllowed(body, value) {
  if(Buffer.byteLength(body)>65536)throw webError('ROBOTS_UNAVAILABLE');
  const groups=[];let group=null,haveRules=false;
  for(const raw of body.split(/\r?\n/)) {
    const line=raw.split('#')[0].trim(); const match=line.match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/i); if(!match)continue;
    const key=match[1].toLowerCase(),v=match[2].trim();
    if(key==='user-agent'){if(!group||haveRules){group={agents:[],rules:[]};groups.push(group);haveRules=false;}group.agents.push(v.toLowerCase());}
    else if(group){haveRules=true;if(v.length>2048)throw webError('ROBOTS_UNAVAILABLE');if(v)group.rules.push({allow:key==='allow',path:v});}
  }
  const own=groups.filter(g=>g.agents.some(a=>'proxypilotreview'.includes(a)&&a!=='*'));
  const applicable=own.length?own:groups.filter(g=>g.agents.includes('*'));
  const u=new URL(value),path=u.pathname+u.search; let winner=null;
  // A bounded glob matcher avoids running page-supplied regular expressions.
  const matches=(pattern,text)=>{
    const anchored=pattern.endsWith('$');if(anchored)pattern=pattern.slice(0,-1);
    else pattern+='*';pattern=pattern.replace(/\*+/g,'*');
    let p=0,t=0,star=-1,back=0;
    while(t<text.length){if(pattern[p]===text[t]){p++;t++;}
      else if(pattern[p]==='*'){star=p++;back=t;}
      else if(star>=0){p=star+1;t=++back;}else return false;}
    while(pattern[p]==='*')p++;return p===pattern.length;
  };
  for(const rule of applicable.flatMap(g=>g.rules)) {
    const specificity=rule.path.replace(/[\*$]/g,'').length;
    if(matches(rule.path,path)&&(!winner||specificity>winner.specificity||specificity===winner.specificity&&rule.allow))winner={...rule,specificity};
  }
  return !winner||winner.allow;
}
export async function gatherPublicPages({url,maxPages,budget,fetchPage,onPage=()=>{},protectedHosts=[]}) {
  const queue=[publicUrl(url,protectedHosts)],seen=new Set(),robots=new Map(),pages=[];
  const entryOrigin=new URL(queue[0]).origin;
  const checkRobots=async target=>{
    const origin=new URL(target).origin;
    if(!robots.has(origin)) {
      const r=await fetchPage(`${origin}/robots.txt`,budget,{maxBytes:65536});
      if(new URL(r.url).origin!==origin)throw webError('ROBOTS_UNAVAILABLE');
      if([404,410].includes(r.status))robots.set(origin,'');
      else if(r.status===200&&/^(text\/plain|text\/html)(?:;|$)/i.test(r.type))robots.set(origin,r.body);
      else throw webError('ROBOTS_UNAVAILABLE');
    }
    if(!robotsAllowed(robots.get(origin),target))throw webError('ROBOTS_DENIED');
  };
  while(queue.length&&pages.length<maxPages) {
    budget.check();const target=queue.shift();if(seen.has(target))continue;seen.add(target);
    await checkRobots(target);
    const r=await fetchPage(target,budget,{beforeHop:checkRobots});
    // Redirect destinations need their own robots policy before content is used.
    if(r.url!==target) {
      const finalOrigin=new URL(r.url).origin;
      if(!robots.has(finalOrigin)) {const rb=await fetchPage(`${finalOrigin}/robots.txt`,budget,{maxBytes:65536});
        if(new URL(rb.url).origin!==finalOrigin)throw webError('ROBOTS_UNAVAILABLE');
        if([404,410].includes(rb.status))robots.set(finalOrigin,'');
        else if(rb.status===200)robots.set(finalOrigin,rb.body);else throw webError('ROBOTS_UNAVAILABLE');}
      if(!robotsAllowed(robots.get(finalOrigin),r.url))throw webError('ROBOTS_DENIED');
    }
    const page=extractPage(r);if(pages.some(p=>p.url===page.url))continue;
    pages.push(page);onPage(page);
    // Follow only a bounded set of ordinary same-origin hyperlinks. Neither
    // guide nor model/page instructions can invent another fetch operation.
    for(const link of page.links) {
      if(queue.length>=10)break;
      try {const next=publicUrl(new URL(link,page.url).href,protectedHosts);
        if(new URL(next).origin===new URL(page.url).origin&&(new URL(page.url).origin===entryOrigin||pages.length===1)&&!seen.has(next))queue.push(next);
      } catch { /* unsupported hyperlinks are not actions */ }
    }
  }
  return pages;
}
