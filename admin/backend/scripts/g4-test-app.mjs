// G4 acceptance application only. Not a reusable/generated application scaffold.
import http from 'node:http';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import jwt from 'jsonwebtoken';

export function verifyAssertion(token,{keys,domain,now=Math.floor(Date.now()/1000)}) {
  if(typeof token!=='string' || token.length>16384) throw new Error('Missing signed assertion');
  const decoded=jwt.decode(token,{complete:true});
  if(decoded?.header.alg!=='ES256') throw new Error('Unexpected signing algorithm');
  const candidates=keys.filter(k=>k.kty==='EC' && k.crv==='P-256' && !k.d && (!k.kid || k.kid===decoded.header.kid));
  if(candidates.length!==1) throw new Error('Unknown signing key');
  const claims=jwt.verify(token,createPublicKey({key:candidates[0],format:'jwk'}),{algorithms:['ES256'],issuer:domain,audience:domain,clockTimestamp:now,clockTolerance:0});
  if(!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.iat>now || typeof claims.sub!=='string' || !claims.sub) throw new Error('Incomplete identity assertion');
  return claims;
}
export function testApp({keys,domain}) {
  return http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    try {
      if(['x-forwarded-user','x-forwarded-email','x-forwarded-groups','remote-user'].some(k=>req.headers[k]) || Object.keys(req.headers).some(k=>k.startsWith('x-auth-request-'))) throw new Error('Untrusted identity header');
      const claims=verifyAssertion(req.headers['x-pomerium-jwt-assertion'],{keys,domain});
      res.end(JSON.stringify({authenticated:true,subject:claims.sub,issuer:claims.iss,audience:claims.aud,untrustedIdentityHeaders:false}));
    } catch {res.statusCode=401;res.end(JSON.stringify({authenticated:false,error:'A valid signed Pomerium assertion is required.'}));}
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const domain=process.env.G4_APP_DOMAIN;
  if(!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain||'') || !process.env.G4_JWKS_FILE) throw new Error('Set G4_APP_DOMAIN and G4_JWKS_FILE to the expected domain and locally trusted public key set.');
  const keys=JSON.parse(readFileSync(process.env.G4_JWKS_FILE,'utf8')).keys;
  const port=Number(process.env.G4_APP_PORT||18443);
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid test application port');
  testApp({keys,domain}).listen(port,'127.0.0.1',()=>console.log(`G4 test app listens on 127.0.0.1:${port}; audience ${domain}`));
}
