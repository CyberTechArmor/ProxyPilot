// Canonical application repositories live on the host. Guest Git operations are
// read-only; credentials are never included in the guest command or bundle.
import { ApplicationReleaseError } from './application-profile.js';

const SCRIPT = String.raw`
import sys,json,os,pathlib,subprocess,tempfile,re,hashlib,fcntl
v=json.load(sys.stdin)
repo=v['repo']; action=v['action']
root=pathlib.Path(repo).parent
root.mkdir(parents=True,exist_ok=True,mode=0o700)
lock=open(root/'.operation.lock','a+')
try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
 print(json.dumps({'idle':False} if action=='probe' else {'error':'A host repository operation is still running.'}));sys.exit(0 if action=='probe' else 1)
if action=='probe':print(json.dumps({'idle':True}));sys.exit(0)
class CommandFailure(Exception):
 def __init__(self,argv,code,stderr):
  text=stderr.decode('utf-8','replace').lower()
  command='process'
  scope='guest' if argv[0]=='incus' else 'host'
  for known in ('status','bundle','fetch','fsck','rev-parse','cat-file','update-ref','symbolic-ref','clone','checkout','apply','write-tree','commit','merge-base','show','ls-tree'):
   if known in argv:command=known;break
  category='command_failed'
  for label,patterns in (
   ('ref_lock',('cannot lock ref','unable to create','another git process','index.lock','packed-refs.lock')),
   ('missing_ref',('not our ref','couldn\'t find remote ref','not a valid object','bad object','unknown revision')),
   ('missing_object',('missing blob','missing tree','missing commit','invalid sha1 pointer','bad file')),
   ('bundle_invalid',('unrecognized header','does not look like a v2 or v3 bundle','invalid bundle')),
   ('resource_limit',('cannot fork','unable to fork','unable to create thread','cannot create thread','resource temporarily unavailable','out of memory','cannot allocate memory')),
   ('permissions',('permission denied','dubious ownership','operation not permitted')),
  ):
   if any(pattern in text for pattern in patterns):category=label;break
  self.diagnostic={'scope':scope,'command':command,'exitCode':code,'category':category}
  super().__init__('Git or guest read failed ('+scope+' '+command+', exit '+str(code)+', '+category+').')
def run(argv, **kwargs):
 p=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(lock.fileno(),),**kwargs)
 if p.returncode: raise CommandFailure(argv,p.returncode,p.stderr)
 return p.stdout
def git(*args):
 # This operation owns repository mutation and its kernel lock. A detached
 # auto-gc launched by fetch would otherwise repack/prune while the very next
 # command verifies pack indexes. Maintenance must be an explicit operation,
 # never a child that outlives this locked checkpoint. Integrity checks remain.
 return run(['git','--no-pager','-c','maintenance.auto=false','-c','gc.auto=0','--git-dir='+repo,*args]).decode().strip()
def guest(*args): return run(['incus','exec',v['prefix']+v['targetId'],'--',*args]).decode().strip()
def import_bundle():
 if guest('git','-C',v['sourceDir'],'rev-parse','--is-shallow-repository')!='false': raise ValueError('A complete, non-shallow guest repository is required.')
 if guest('git','-C',v['sourceDir'],'status','--porcelain','--untracked-files=no'): raise ValueError('Tracked guest changes must be committed before checkpointing.')
 root=pathlib.Path(repo).parent
 root.mkdir(parents=True,exist_ok=True,mode=0o700)
 if root.is_symlink() or pathlib.Path(repo).is_symlink(): raise ValueError('Repository path cannot be a symlink.')
 with tempfile.NamedTemporaryFile(dir=root,suffix='.bundle') as f:
  p=subprocess.run(['incus','exec',v['prefix']+v['targetId'],'--','git','-C',v['sourceDir'],'bundle','create','-','--all'],stdout=f,stderr=subprocess.PIPE,pass_fds=(lock.fileno(),))
  if p.returncode: raise ValueError('Guest full-history bundle could not be read.')
  if f.tell()>536870912: raise ValueError('Repository bundle exceeds the 512 MiB import limit.')
  if not pathlib.Path(repo).exists(): run(['git','init','--bare',repo])
  git('bundle','verify',f.name)
  # Import every ref and the bundle's own HEAD in one pack transaction. A
  # second fetch of the identical pack is unnecessary, and rereading guest
  # HEAD here would race a commit made after the bundle snapshot was taken.
  git('fetch','--no-tags',f.name,'+refs/*:refs/guest/*','+HEAD:refs/guest/source-head')
  # Keep the initial canonical main separate from future guest checkpoints.
  head=git('rev-parse','--verify','refs/guest/source-head^{commit}')
  git('cat-file','-e',head+'^{commit}')
  if not (pathlib.Path(repo)/'pp-imported').exists():
   result=subprocess.run(['incus','exec',v['prefix']+v['targetId'],'--','git','-C',v['sourceDir'],'symbolic-ref','--quiet','--short','HEAD'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   branch=result.stdout.decode().strip() if result.returncode==0 else 'imported-source'
   git('update-ref','refs/heads/'+branch,head)
   git('symbolic-ref','HEAD','refs/heads/'+branch)
   (pathlib.Path(repo)/'pp-imported').write_text(head+'\n')
  git('fsck','--full','--no-reflogs')
 return head
def resolve(ref):
 if re.fullmatch('[a-f0-9]{40}',ref): return git('rev-parse','--verify',ref+'^{commit}')
 for prefix in ('refs/guest/heads/','refs/heads/'):
  p=subprocess.run(['git','--git-dir='+repo,'rev-parse','--verify',prefix+ref+'^{commit}'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  if p.returncode==0:return p.stdout.decode().strip()
 raise ValueError('The exact branch does not exist in the canonical repository.')
def hygiene(sha):
 lines=git('rev-list','--objects',sha).splitlines()
 if len(lines)>100000: raise ValueError('History hygiene scan exceeds the object limit; review and reduce scope explicitly.')
 ids=[];total=0
 for line in lines:
  oid,_,name=line.partition(' ')
  if name:
   base=name.rsplit('/',1)[-1].lower()
   if (base=='.env' or base.startswith('.env.') and base not in ('.env.example','.env.sample','.env.template') or base in ('id_rsa','id_ed25519') or base.endswith(('.p12','.pfx'))):
    raise ValueError('Protected file is tracked in reachable history; resolve history hygiene before publishing.')
  if git('cat-file','-t',oid)!='blob': continue
  size=int(git('cat-file','-s',oid));total+=size
  if size>16777216 or total>268435456: raise ValueError('History hygiene scan exceeds its byte limit; not cleared for publication.')
  data=run(['git','--git-dir='+repo,'cat-file','blob',oid])
  if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|://[^\s/:]+:[^\s@/]+@',data):
   raise ValueError('Credential pattern detected in reachable history; not cleared for publication.')
  ids.append(oid)
 return {'passed':True,'objects':len(lines),'blobs':len(ids),'bytes':total,'digest':hashlib.sha256(('\n'.join(sorted(ids))).encode()).hexdigest(),'policy':'application-history-v1'}
try:
 if action=='import':
  sha=import_bundle();out={'sha':sha,'treeSha':git('rev-parse',sha+'^{tree}'),'hygiene':hygiene(sha)}
 elif action=='checkpoint':
  import_bundle();sha=resolve(v['ref']);out={'sha':sha,'treeSha':git('rev-parse',sha+'^{tree}'),'hygiene':hygiene(sha)}
 elif action=='inspect':
  sha=resolve(v['ref']);out={'sha':sha,'treeSha':git('rev-parse',sha+'^{tree}'),'hygiene':hygiene(sha)}
 elif action=='source':
  sha=resolve(v['ref']);name=v.get('path')
  if name is None:
   names=git('ls-tree','-r','--name-only',sha).splitlines()
   out={'sha':sha,'paths':names[:2000],'truncated':len(names)>2000,'totalFiles':len(names)}
  else:
   data=run(['git','--git-dir='+repo,'show',sha+':'+name])
   try: content=data[:65536].decode('utf-8')
   except UnicodeDecodeError: raise ValueError('Selected object is binary or crosses the text limit; use a source checkout.')
   out={'sha':sha,'path':name,'content':content,'bytes':len(data),'truncated':len(data)>65536,'sha256':hashlib.sha256(data).hexdigest()}
 elif action=='commit':
  parent=resolve(v['parentSha']);branch='refs/heads/'+v['branch']
  existing=subprocess.run(['git','--git-dir='+repo,'rev-parse','--verify',branch],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  old=existing.stdout.decode().strip() if existing.returncode==0 else '0'*40
  if old!='0'*40 and old!=parent:raise ValueError('Branch moved after the reviewed parent commit.')
  with tempfile.TemporaryDirectory(dir=pathlib.Path(repo).parent,prefix='work-') as work:
   run(['git','clone','--no-checkout','--shared',repo,work])
   run(['git','-C',work,'checkout','--detach',parent])
   run(['git','-C',work,'apply','--check','--index','-'],input=v['patch'].encode())
   run(['git','-C',work,'apply','--index','-'],input=v['patch'].encode())
   tree=run(['git','-C',work,'write-tree']).decode().strip()
   if tree==git('rev-parse',parent+'^{tree}'):raise ValueError('Patch does not change the selected parent.')
   run(['git','-C',work,'-c','user.name=ProxyPilot','-c','user.email=proxypilot@localhost','commit','-m',v['message']])
   sha=run(['git','-C',work,'rev-parse','HEAD']).decode().strip()
   git('fetch',work,sha)
  h=hygiene(sha)
  git('update-ref',branch,sha,old)
  out={'sha':sha,'treeSha':git('rev-parse',sha+'^{tree}'),'hygiene':h}
 elif action=='advance':
  sha=resolve(v['sha']);branch='refs/heads/'+v['branch']
  existing=subprocess.run(['git','--git-dir='+repo,'rev-parse','--verify',branch],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  old=existing.stdout.decode().strip() if existing.returncode==0 else '0'*40
  if old!='0'*40: run(['git','--git-dir='+repo,'merge-base','--is-ancestor',old,sha])
  git('update-ref',branch,sha,old)
  out={'ok':True,'sha':sha}
 else: raise ValueError('Unsupported repository action.')
 print(json.dumps(out))
except Exception as e:
 print(json.dumps({'error':str(e),**({'diagnostic':e.diagnostic} if isinstance(e,CommandFailure) else {})}));sys.exit(1)
`;

export function createApplicationGit({host,prefix=process.env.LXC_PREFIX||'pp-'}) {
  async function action(name, app, extra={}) {
    const result=await host('python3',['-c',SCRIPT],{input:JSON.stringify({action:name,repo:app.repositoryPath,targetId:app.targetId,sourceDir:app.profile.sourceDir,prefix,...extra}),timeoutMs:300000});
    let value;try{value=JSON.parse(result.stdout);}catch{throw new ApplicationReleaseError('REPOSITORY_READ_FAILED','Repository read did not return valid evidence.');}
    if(result.code!==0||value.error) {const error=new ApplicationReleaseError('REPOSITORY_READ_FAILED',value.error||'Repository operation failed.');if(value.diagnostic)error.diagnostic=value.diagnostic;throw error;}
    return value;
  }
  return {import:app=>action('import',app),checkpoint:(app,ref)=>action('checkpoint',app,{ref}),inspect:(app,sha)=>action('inspect',app,{ref:sha}),source:(app,sha,path)=>action('source',app,{ref:sha,path}),commit:(app,input)=>action('commit',app,input),advance:(app,input)=>action('advance',app,input),probe:app=>action('probe',app)};
}
