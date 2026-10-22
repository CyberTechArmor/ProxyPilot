// Constrained I/O for automatically generated task records, never model files.
// The container transport is injected; the fixed Python program follows no
// symlinks, writes an exclusive temporary file and atomically replaces only a
// validated task record. A convention file is linked into place only if absent.
const PREFIX = 'PP_TASK_WRITE_RESULT ';
const MAX_BYTES = 64 * 1024;
const PROGRAM = String.raw`
import base64, fcntl, json, os, re, stat, sys, uuid
fds=[]; links=[]; temp=None; parent=None
result={'ok':False,'written':False,'error':'unsafe_task_record'}
class Refused(Exception): pass
def refuse(): raise Refused()
def identity(s): return (s.st_dev,s.st_ino)
def inspect(fd,name):
    try: return os.stat(name,dir_fd=fd,follow_symlinks=False)
    except FileNotFoundError: return None
def regular(s): return s is not None and stat.S_ISREG(s.st_mode) and s.st_nlink==1
def anchor():
    if identity(os.stat(root,follow_symlinks=False))!=identity(os.fstat(fds[0])): refuse()
    for fd,name,child in links:
        s=inspect(fd,name)
        if s is None or not stat.S_ISDIR(s.st_mode) or identity(s)!=identity(os.fstat(child)): refuse()
def directory(fd,name):
    try: os.mkdir(name,0o700,dir_fd=fd)
    except FileExistsError: pass
    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
    fds.append(child);links.append((fd,name,child));anchor();return child
def read_small(fd,name,s):
    if not regular(s) or s.st_size>65536: refuse()
    f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
    try:
        if identity(os.fstat(f))!=identity(s): refuse()
        b=os.read(f,65537)
        if len(b)>65536: refuse()
        return b.decode('utf-8')
    finally: os.close(f)
try:
    data=json.loads(base64.b64decode(sys.argv[1],validate=True))
    root=data['root'];path=data['path'];body=data['content'].encode('utf-8');create=data['createOnly']
    if not isinstance(root,str) or not os.path.isabs(root) or os.path.realpath(root)!=root or len(body)>65536: refuse()
    m=re.fullmatch(r'state/tasks/(t[0-9]{1,10}-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)/(task.json|handoff.md)',path)
    convention=path in ('AGENTS.md','state/tasks/README.md')
    if not m and not (convention and create is True): refuse()
    if m and create: refuse()
    if m:
        key=m.group(1)
        if m.group(2)=='task.json':
            record=json.loads(body)
            if record.get('schema')!='mock2-task@1' or record.get('taskId')!=key or not isinstance(record.get('revision'),int) or record['revision']<1: refuse()
        elif not body.decode().startswith('# Task '+key+' '): refuse()
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds.append(fd);anchor()
    parts=path.split('/')
    for part in parts[:-1]: fd=directory(fd,part)
    parent=fd;name=parts[-1]
    # Locks are per directory, hence per task for records; no stale lock file.
    fcntl.flock(parent,fcntl.LOCK_EX|fcntl.LOCK_NB);anchor()
    previous=inspect(parent,name)
    if previous is not None:
        if create:
            result={'ok':True,'written':False,'error':None}
        else:
            old=read_small(parent,name,previous)
            if m.group(2)=='task.json':
                prior=json.loads(old)
                if prior.get('schema')!='mock2-task@1' or prior.get('taskId')!=key: refuse()
                if prior.get('revision',0)>record['revision']: refuse()
            elif not old.startswith('# Task '+key+' '): refuse()
    if not create or previous is None:
        anchor();temp='.flightdeck-task-'+uuid.uuid4().hex+'.tmp'
        out=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
        try:
            view=memoryview(body)
            while view:
                count=os.write(out,view);view=view[count:]
            os.fsync(out)
        finally: os.close(out)
        anchor();current=inspect(parent,name)
        if (previous is None)!=(current is None) or (previous is not None and (not regular(current) or identity(previous)!=identity(current))):
            if not create: refuse()
        if create:
            try: os.link(temp,name,src_dir_fd=parent,dst_dir_fd=parent,follow_symlinks=False);written=True
            except FileExistsError: written=False
            os.unlink(temp,dir_fd=parent);temp=None
        else:
            os.replace(temp,name,src_dir_fd=parent,dst_dir_fd=parent);temp=None;written=True
        os.fsync(parent);anchor()
        result={'ok':True,'written':written,'error':None}
except BlockingIOError: result={'ok':False,'written':False,'error':'task_record_busy'}
except Exception: pass
finally:
    if temp is not None and parent is not None:
        try: os.unlink(temp,dir_fd=parent)
        except OSError: pass
    for fd in reversed(fds):
        try: os.close(fd)
        except OSError: pass
print('PP_TASK_WRITE_RESULT '+json.dumps(result,separators=(',',':')))
`;

export function buildTaskRecordWriteScript({ path, content, createOnly = false }, { appDir = '/srv/app' } = {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES) throw new TypeError('Task record exceeds the write limit');
  const payload = Buffer.from(JSON.stringify({ root: appDir, path, content, createOnly }), 'utf8').toString('base64');
  const script = `# PP_TASK_RECORD_WRITE_V1\nif ! command -v python3 >/dev/null 2>&1; then printf '%s\\n' '${PREFIX}{"ok":false,"written":false,"error":"python3_required"}'; exit 0; fi\npython3 -I - '${payload}' <<'PP_TASK_RECORD_PY'\n${PROGRAM}\nPP_TASK_RECORD_PY\n`;
  if (Buffer.byteLength(Buffer.from(script).toString('base64')) > 120000) throw new TypeError('Task record exceeds the transport limit');
  return script;
}

export async function writeTaskRecordFile(containerSh, containerName, path, content, { createOnly = false } = {}) {
  const script = buildTaskRecordWriteScript({ path, content, createOnly });
  const r = await containerSh(containerName, script, { timeoutMs: 30000 });
  if (r?.code === 0) {
    const lines = String(r.stdout || '').trim().split('\n');
    if (lines.length === 1 && lines[0].startsWith(PREFIX)) {
      try {
        const value = JSON.parse(lines[0].slice(PREFIX.length));
        if (typeof value.ok === 'boolean' && typeof value.written === 'boolean'
          && [null, 'unsafe_task_record', 'task_record_busy', 'python3_required'].includes(value.error)) return { ...value, settled: true };
      } catch { /* missing/invalid acknowledgement retains the operation fence */ }
    }
  }
  return { ok: false, written: false, settled: false, error: 'task_record_outcome_unknown' };
}

// A missing mutation result is a checkout barrier, including for the cycle
// that originally owned the checkout. Never checkpoint/deploy over it.
export function assertTaskMirrorSettled({ result, lock } = {}) {
  if (result?.uncertain === true || lock?.holder_operation_state === 'uncertain') {
    const error = new Error('Task record write outcome is unknown. Checkout is blocked until its outcome is verified.');
    error.code = 'MOCK2_TASK_FILES_UNCERTAIN';
    throw error;
  }
}
