// Existing-application releases use the SAME stored connector but transport
// exact commits and independently read the remote ref. No directory mirror,
// credential-bearing remote config, repository creation, or force push.
const APPLICATION_TRANSPORT_SCRIPT = String.raw`
import sys,json,os,tempfile,subprocess,re
v=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='pp-git-auth-') as temp:
 askpass=os.path.join(temp,'askpass.py')
 with open(askpass,'w') as f:
  f.write('#!/usr/bin/env python3\nimport os,sys\nprint("x-access-token" if "username" in sys.argv[1].lower() else os.environ["PP_GIT_TOKEN"])\n')
 os.chmod(askpass,0o700)
 env={**os.environ,'GIT_ASKPASS':askpass,'GIT_TERMINAL_PROMPT':'0','PP_GIT_TOKEN':v['token']}
 args=['git','--git-dir='+v['gitDir']]
 if v['operation']=='promote':
  if v['expectedRemoteSha'] is None:
   current=subprocess.run(args+['ls-remote',v['url'],'refs/heads/'+v['branch']],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
   if current.returncode or current.stdout.strip():print(json.dumps({'ok':False,'error':'The remote branch is no longer absent.'}));sys.exit(0)
  else:
   fetched=subprocess.run(args+['fetch','--no-tags',v['url'],'refs/heads/'+v['branch']],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
   if fetched.returncode: print(json.dumps({'ok':False,'error':'Remote ancestry could not be fetched.'}));sys.exit(0)
   current=subprocess.run(args+['rev-parse','FETCH_HEAD'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   ancestor=subprocess.run(args+['merge-base','--is-ancestor',v['expectedRemoteSha'],v['sha']],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   if current.stdout.decode().strip()!=v['expectedRemoteSha'] or ancestor.returncode:
    print(json.dumps({'ok':False,'error':'Remote changed or candidate is not a fast-forward.'}));sys.exit(0)
  # The ancestry proof forbids rewriting history; the exact lease refuses a
  # concurrent remote change even when that change would also fast-forward.
  args+=['push','--porcelain','--force-with-lease=refs/heads/'+v['branch']+':'+(v['expectedRemoteSha'] or ''),v['url'],v['sha']+':refs/heads/'+v['branch']]
 elif v['operation']=='push': args+=['push','--porcelain',v['url'],v['sha']+':refs/heads/'+v['branch']]
 else: args+=['ls-remote','--symref',v['url'],'HEAD','refs/heads/'+v['branch']]
 try: result=subprocess.run(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
 except Exception:
  print(json.dumps({'ok':False,'error':'Git transport timed out or could not start.'}));sys.exit(0)
 if result.returncode:
  print(json.dumps({'ok':False,'error':'Git authentication, transport or fast-forward check failed.'}));sys.exit(0)
 if v['operation'] in ('push','promote'): print(json.dumps({'ok':True}));sys.exit(0)
 out={'ok':True,'sha':None,'defaultBranch':None,'defaultHeadSha':None}
 for line in result.stdout.decode().splitlines():
  if line.startswith('ref: refs/heads/') and line.endswith('\tHEAD'): out['defaultBranch']=line.split('\t')[0][16:]
  parts=line.split('\t')
  if len(parts)==2 and re.fullmatch('[a-f0-9]{40}',parts[0]):
   if parts[1]=='HEAD': out['defaultHeadSha']=parts[0]
   if parts[1]=='refs/heads/'+v['branch']: out['sha']=parts[0]
 print(json.dumps(out))
`;

export function createApplicationGitTransport({host, decryptCredential}) {
 async function applicationTransport(operation, {conn,gitDir,remoteRepo,sha,branch,expectedRemoteSha}) {
  if (conn?.auth_kind !== 'token') return {ok:false,error:'Application releases currently require an existing token Git connector.'};
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remoteRepo) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || /\.\.|\/\.|\.lock$/.test(branch)) return {ok:false,error:'Invalid repository or branch.'};
  const token=decryptCredential(conn);if(!token)return {ok:false,error:'Existing connector credential is unavailable.'};
  const base=conn.base_url || (conn.provider==='github'?'https://github.com':null);
  let parsed;try{parsed=new URL(base);}catch{return {ok:false,error:'Connector base URL is unavailable.'};}
  if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash) return {ok:false,error:'Connector base URL is invalid.'};
  const url=base.replace(/\/$/,'')+'/'+remoteRepo.replace(/\.git$/,'')+'.git';
  const result=await host('python3',['-c',APPLICATION_TRANSPORT_SCRIPT],{input:JSON.stringify({operation,gitDir,branch,sha,url,token,expectedRemoteSha}),timeoutMs:125000});
  try{return result.code===0?JSON.parse(result.stdout):{ok:false,error:'Git transport could not complete.'};}catch{return {ok:false,error:'Git transport returned invalid readback.'};}
}

 return Object.freeze({
  push:options=>applicationTransport('push',options),
  read:options=>applicationTransport('read',options),
  promote:options=>applicationTransport('promote',options),
 });
}

