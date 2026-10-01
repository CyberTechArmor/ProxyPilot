#!/usr/bin/env node
// Metadata only: no source/vault clients, no secret transfer, no host changes.
import { readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keys = new Set(['source_kind','source_identity_id','source_credential_name','source_version',
  'consumer_id','owner_id','ops_project_id','target_connection_id','target_credential_id',
  'target_adapter','operations','resources','legacy_network_link','host_pattern','surfaces','reviewed_mapping']);
const outputKeys = ['source_kind','source_identity_id','source_credential_name','source_version',
  'consumer_id','owner_id','ops_project_id','target_connection_id','target_credential_id',
  'target_adapter','operations','resources','legacy_network_link'];
const err = () => { throw new Error('Invalid metadata manifest. No source or target was accessed.'); };
const bounded = (s, n=200) => typeof s === 'string' && s.length > 0 && s.length <= n && !/[\x00-\x1f\x7f]/.test(s);

export function dryRun(manifest) {
  if (!manifest || Object.getPrototypeOf(manifest)!==Object.prototype ||
      Object.keys(manifest).some(k=>!['version','credentials'].includes(k)) || manifest.version !== 1 ||
      !Array.isArray(manifest.credentials) || manifest.credentials.length > 1000) err();
  const seen = new Set();
  const rows = manifest.credentials.map(row => {
    if (!row || Object.getPrototypeOf(row)!==Object.prototype || Object.keys(row).some(k=>!keys.has(k))) err();
    if (!['infisical','openbao_machine'].includes(row.source_kind) || !bounded(row.source_identity_id) ||
        !bounded(row.source_credential_name,64) || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(row.source_credential_name)) err();
    if (row.source_version !== null && (!Number.isSafeInteger(row.source_version) || row.source_version < 1)) err();
    for (const field of ['consumer_id','owner_id','ops_project_id','target_connection_id','target_credential_id']) {
      if (row[field] != null && (typeof row[field] !== 'string' || !uuid.test(row[field]))) err();
    }
    if (row.target_adapter != null && !['synthetic-ledger-v1'].includes(row.target_adapter)) err();
    if (!Array.isArray(row.operations) || row.operations.length>2 ||
        row.operations.some(v=>!['item.read','item.set_state'].includes(v)) || new Set(row.operations).size !== row.operations.length) err();
    if (!Array.isArray(row.resources) || row.resources.length>32 || row.resources.some(v=>typeof v!=='string'||!uuid.test(v)) || new Set(row.resources).size!==row.resources.length) err();
    if (!Array.isArray(row.surfaces) || row.surfaces.length>4 || row.surfaces.some(v=>!['header','query','path','body'].includes(v))) err();
    if (typeof row.reviewed_mapping !== 'boolean' || (row.host_pattern != null && !bounded(row.host_pattern,253))) err();
    if (row.legacy_network_link != null) {
      const link=row.legacy_network_link;
      if (!link || Object.getPrototypeOf(link)!==Object.prototype || Object.keys(link).some(k=>!['container_uuid','ip'].includes(k)) ||
          typeof link.container_uuid!=='string'||!uuid.test(link.container_uuid)||!bounded(link.ip,45)||!/^[0-9a-fA-F:.]+$/.test(link.ip)) err();
    }
    const identity=JSON.stringify([row.source_kind,row.source_identity_id,row.source_credential_name]);
    if(seen.has(identity)) err(); seen.add(identity);
    let disposition='mappable',reason='REVIEWED_SYNTHETIC_MAPPING';
    if (!row.owner_id) {disposition='owner_required';reason='OWNER_NOT_SELECTED';}
    else if (!row.consumer_id) {disposition='consumer_required';reason='CONSUMER_NOT_SELECTED';}
    else if (row.source_version===null) {disposition='blocked';reason='SOURCE_VERSION_UNVERIFIED';}
    else if (row.target_adapter!=='synthetic-ledger-v1' || !row.reviewed_mapping || !row.target_connection_id || !row.target_credential_id ||
             !row.operations.length || !row.resources.length || !row.host_pattern || !/^[a-z0-9.-]+$/i.test(row.host_pattern) ||
             row.surfaces.length!==1 || row.surfaces[0]!=='header') {disposition='unsupported';reason='TYPED_MAPPING_NOT_PROVEN';}
    return {...Object.fromEntries(outputKeys.map(k=>[k,row[k]??null])),disposition,reason,
      alternative:disposition==='unsupported'?'Keep this consumer on its existing integration until an exact adapter is reviewed.':null};
  });
  return {version:1,mode:'metadata_only',source_accessed:false,target_accessed:false,
    transfer_authorized:false,rows,summary:Object.fromEntries(['mappable','unsupported','owner_required','consumer_required','blocked'].map(k=>[k,rows.filter(r=>r.disposition===k).length]))};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(process.argv.length!==2) err();
    const chunks=[]; let size=0;
    for (;;) {
      const buffer=Buffer.alloc(16384), n=readSync(0,buffer,0,buffer.length,null);
      if(!n) break;
      size+=n;if(size>1024*1024) err();chunks.push(buffer.subarray(0,n));
    }
    const input=Buffer.concat(chunks,size);
    console.log(JSON.stringify(dryRun(JSON.parse(input.toString('utf8'))),null,2));
  } catch {
    // Never print input, parser exception or field contents.
    process.stderr.write('Invalid metadata manifest. No source or target was accessed.\n');
    process.exitCode=1;
  }
}
