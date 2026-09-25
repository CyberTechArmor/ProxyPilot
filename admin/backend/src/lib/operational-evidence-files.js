import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const same = (a,b) => a.dev===b.dev && a.ino===b.ino;
export const byteHash = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = () => { throw new Error('Private evidence storage unavailable'); };

// The supplied root must already exist, be dedicated, and be owned exclusively by
// the service account. No recursive creation, directory sweep, or caller paths.
// Linux uses a pinned directory descriptor; Windows requires a separately
// reviewed ACL boundary because Node has no openat/reparse-safe relative API.
export function createEvidenceFiles(root) {
  if (!root || !path.isAbsolute(root) || path.parse(root).root===path.resolve(root)) unavailable();
  root=path.resolve(root);
  const checkAncestors=()=>{
    let p=root;
    for (;;) {
      const s=fs.lstatSync(p);
      if (!s.isDirectory() || s.isSymbolicLink() || (p===root && s.mode & 0o077 && process.platform!=='win32')) unavailable();
      if (path.dirname(p)===p) break;
      p=path.dirname(p);
    }
    if (fs.realpathSync.native(root)!==root) unavailable();
  };
  checkAncestors();
  const rootStat=fs.lstatSync(root);
  const dirfd=process.platform==='linux' ? fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW) : null;
  let closed=false;
  function guard() {
    if (closed) unavailable();
    checkAncestors();
    if (!same(rootStat,fs.lstatSync(root))) unavailable();
  }
  function filename(id) {
    if (!keyPattern.test(id)) unavailable();
    guard();
    return dirfd===null ? path.join(root,`${id}.blob`) : `/proc/self/fd/${dirfd}/${id}.blob`;
  }
  function open(id,write=false) {
    const name=filename(id);
    let before;
    try { before=fs.lstatSync(name); } catch(e) { if(e.code!=='ENOENT') throw e; }
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink!==1)) unavailable();
    const fd=fs.openSync(name,write ? fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL| (fs.constants.O_NOFOLLOW||0) : fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0),0o600);
    try {
      const s=fs.fstatSync(fd);
      if (!s.isFile() || s.nlink!==1 || (before && !same(before,s)) || !same(s,fs.lstatSync(name))) unavailable();
      guard(); return fd;
    } catch(e) { fs.closeSync(fd); throw e; }
  }
  return {
    write(id,bytes) {
      if (!Buffer.isBuffer(bytes) || bytes.length<1 || bytes.length>8388608) unavailable();
      const fd=open(id,true);
      try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); guard(); }
      finally { fs.closeSync(fd); }
      if(dirfd!==null) fs.fsyncSync(dirfd);
      return {byte_count:bytes.length,sha256:byteHash(bytes)};
    },
    read(id,expected) {
      const fd=open(id);
      try {
        const stat=fs.fstatSync(fd);
        if(stat.size<1 || stat.size>8388608 || stat.size!==expected.byte_count) unavailable();
        const bytes=Buffer.alloc(stat.size);
        let offset=0;
        while(offset<bytes.length) { const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset); if(!n) unavailable(); offset+=n; }
        guard();
        if(byteHash(bytes)!==expected.sha256) unavailable();
        return bytes;
      } finally { fs.closeSync(fd); }
    },
    remove(id) {
      const name=filename(id);
      let stat;
      try { stat=fs.lstatSync(name); } catch(e) { if(e.code==='ENOENT') return 'missing'; throw e; }
      if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1) unavailable();
      guard(); fs.unlinkSync(name);
      if(dirfd!==null) fs.fsyncSync(dirfd);
      return 'deleted';
    },
    close() { if(!closed && dirfd!==null) fs.closeSync(dirfd); closed=true; },
  };
}
