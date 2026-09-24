import { sizeBytes } from '../guest-isolation.js';

// Runs only INSIDE the named VM. No host block-device paths are accepted.
// Deliberately limited to a plain root partition on ext4/XFS; LVM, encrypted
// and multi-device layouts need an explicit storage-specific migration plan.
export const VM_DISK_SCRIPT = String.raw`
import json, os, pathlib, re, shutil, subprocess, sys
def output(*argv): return subprocess.check_output(argv, text=True).strip()
source = os.path.realpath(output('findmnt','-n','-o','SOURCE','/'))
fs = output('findmnt','-n','-o','FSTYPE','/')
if not re.fullmatch(r'/dev/[A-Za-z0-9]+', source) or fs not in ('ext4','xfs'):
    raise SystemExit('Automatic growth supports a plain ext4/XFS root partition only')
base = pathlib.Path(source).name
partition_file = pathlib.Path('/sys/class/block') / base / 'partition'
if not partition_file.is_file(): raise SystemExit('Root is not a plain partition')
part = partition_file.read_text().strip()
parent = output('lsblk','-n','-o','PKNAME',source)
if not re.fullmatch(r'[A-Za-z0-9]+',parent) or not part.isdigit(): raise SystemExit('Ambiguous root disk')
disk = '/dev/' + parent
growfs = 'resize2fs' if fs == 'ext4' else 'xfs_growfs'
if not shutil.which('growpart') or not shutil.which(growfs): raise SystemExit('Install cloud-guest-utils and the filesystem grow utility inside the VM first')
if sys.argv[1] == 'grow':
    r = subprocess.run(['growpart',disk,part],text=True,capture_output=True)
    if r.returncode and 'NOCHANGE:' not in (r.stdout+r.stderr): raise SystemExit(r.stderr or r.stdout)
    subprocess.run([growfs,source if fs == 'ext4' else '/'],check=True,stdout=subprocess.DEVNULL)
v = os.statvfs('/')
print(json.dumps(dict(disk_bytes=int(output('blockdev','--getsize64',disk)), partition_bytes=int(output('blockdev','--getsize64',source)), fs_bytes=v.f_blocks*v.f_frsize)))
`;

export function vmDiskArgv(name, mode = 'inspect') {
  if (!['inspect','grow'].includes(mode)) throw new Error('Invalid growth phase');
  return ['incus','exec',name,'--','python3','-c',VM_DISK_SCRIPT,mode];
}
export function filesystemGrown(facts, requested) {
  const n = sizeBytes(requested);
  return !!n && facts?.disk_bytes >= n && facts.partition_bytes >= facts.disk_bytes * 0.9 && facts.fs_bytes >= facts.partition_bytes * 0.9;
}
