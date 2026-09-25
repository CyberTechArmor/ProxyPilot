import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvidenceFiles } from './operational-evidence-files.js';
import { createEvidenceIntake } from './operational-evidence-intake.js';
import { createEvidenceService } from './operational-evidence-service.js';
import { createEvidenceDecoder } from './operational-evidence-decoder.js';

export function evidenceConfiguration(env=process.env) {
  const requested=env.OPERATIONS_ENABLED==='true' && env.OPERATIONS_EVIDENCE_ENABLED==='true';
  if(!requested) return {enabled:false};
  const quota=Number(env.OPERATIONS_EVIDENCE_QUOTA_BYTES);
  const root=env.OPERATIONS_EVIDENCE_DIR,runner=env.OPERATIONS_EVIDENCE_DECODER_RUNNER;
  const checkout=fileURLToPath(new URL('../../../../',import.meta.url));
  const within=(child,parent)=>{const r=path.relative(parent,child);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
  // Deployment review must verify dedicated path/ACLs and wrapper isolation.
  // This assertion is intentionally separate from the two feature switches.
  if(env.OPERATIONS_EVIDENCE_BOUNDARY_REVIEWED!=='true'||!root||!path.isAbsolute(root)||!runner||!path.isAbsolute(runner)||
    !Number.isSafeInteger(quota)||quota<16777216 || within(root,checkout) || within(checkout,root)) return {enabled:false};
  return {enabled:true,root,runner,quota};
}

export function createEvidenceRuntime(config) {
  if(!config.enabled) return null;
  // Lazy filesystem construction: disabled/unauthorized requests never touch it.
  let files;
  const adapter=Object.fromEntries(['read','write','remove'].map(name=>[name,(...args)=>{
    files??=createEvidenceFiles(config.root);return files[name](...args);
  }]));
  const decode=createEvidenceDecoder({runner:config.runner});
  return {
    factory:ctx=>createEvidenceIntake(ctx,{installationBytes:config.quota,verifyFile:(id,proof)=>adapter.read(id,proof)}),
    service:store=>createEvidenceService({store,files:adapter,decode}),
    close:()=>files?.close(),
  };
}
