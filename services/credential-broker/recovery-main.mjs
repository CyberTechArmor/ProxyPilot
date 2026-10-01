#!/usr/bin/env node
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupState,restoreState,backupWorkerState,restoreWorkerState,generateRecoveryKey,configurationDigest,recoverStoppedLease } from './recovery.mjs';

export function recoveryCommand(argv) {
 const [command,...rest]=argv,options={};
 const operation=command?.replace(/^worker-/,''),worker=command?.startsWith('worker-');
 if(worker&&!['backup','restore'].includes(operation))throw Error('INVALID_COMMAND');
 const allowed={keygen:['key-file'],backup:['key-file','config-file','build','archive-file'],restore:['key-file','config-file','build','archive-file','destination'], 'recover-stopped-lease':['state-dir']}[operation];
 if(!allowed)throw Error('INVALID_COMMAND');
 for(let i=0;i<rest.length;i+=2){const flag=rest[i];if(!flag?.startsWith('--')||!allowed.includes(flag.slice(2))||!rest[i+1]||rest[i+1].startsWith('--')||Object.hasOwn(options,flag.slice(2)))throw Error('INVALID_ARGUMENTS');options[flag.slice(2)]=rest[i+1];}
 if(allowed.some(k=>!Object.hasOwn(options,k)))throw Error('MISSING_ARGUMENTS');
 if(command==='keygen')return generateRecoveryKey(options['key-file']);
 if(command==='recover-stopped-lease')return recoverStoppedLease(options['state-dir']);
 const configPath=resolve(options['config-file']),st=lstatSync(configPath);
 if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||st.size>65536||realpathSync(configPath)!==configPath)throw Error('UNSAFE_CONFIG');
 const config=JSON.parse(readFileSync(configPath,'utf8'));if(typeof config.state_dir!=='string'||!config.state_dir.startsWith('/'))throw Error('INVALID_CONFIG');
 const common={keyPath:options['key-file'],archivePath:options['archive-file'],expectedPins:{build:options.build,config_digest:configurationDigest(config)}};
 return operation==='backup'?(worker?backupWorkerState:backupState)({...common,stateRoot:config.state_dir}):(worker?restoreWorkerState:restoreState)({...common,destination:options.destination});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{process.stdout.write(JSON.stringify(recoveryCommand(process.argv.slice(2)))+'\n');}
 catch(e){const code=typeof e.code==='string'&&/^[A-Z_]{1,64}$/.test(e.code)?e.code:/^[A-Z_]{1,64}$/.test(e.message)?e.message:'RECOVERY_FAILED';process.stderr.write(JSON.stringify({error:{code}})+'\n');process.exitCode=1;}
}
