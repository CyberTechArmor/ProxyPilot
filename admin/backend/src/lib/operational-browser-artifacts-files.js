import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_BROWSER_ARTIFACT_BYTES = 16777216;
export const browserArtifactByteHash = bytes => createHash('sha256').update(bytes).digest('hex');
const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const same = (a,b) => a.dev === b.dev && a.ino === b.ino;
const unavailable = () => { throw new Error('Private browser artifact storage unavailable'); };

// A dedicated, pre-existing 0700 root owned exclusively by this service is
// required. Linux pins a directory descriptor; caller input is an opaque UUID.
// No recursive creation/sweep, arbitrary path, archive unpack or execution.
export function createBrowserArtifactFiles(root) {
  if (process.platform !== 'linux' || !root || !path.isAbsolute(root) || path.parse(root).root === path.resolve(root)) unavailable();
  root = path.resolve(root);
  const ancestors = () => {
    let p = root;
    for (;;) {
      const s = fs.lstatSync(p);
      if (!s.isDirectory() || s.isSymbolicLink() || (p === root && (s.mode & 0o077 || s.uid !== process.getuid()))) unavailable();
      if (path.dirname(p) === p) break;
      p = path.dirname(p);
    }
    if (fs.realpathSync.native(root) !== root) unavailable();
  };
  ancestors();
  const stat = fs.lstatSync(root);
  const dirfd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let closed = false;
  const guard = () => {
    if (closed) unavailable();
    ancestors();
    if (!same(stat, fs.lstatSync(root)) || !same(stat, fs.fstatSync(dirfd))) unavailable();
  };
  function filename(id) {
    if (!keyPattern.test(id)) unavailable();
    guard();
    return `/proc/self/fd/${dirfd}/${id}.blob`;
  }
  function safeStat(name) {
    const s = fs.lstatSync(name);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() || s.mode & 0o077) unavailable();
    return s;
  }
  function open(id, writing = false) {
    const name = filename(id);
    let before;
    try { before = safeStat(name); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const fd = fs.openSync(name, writing
      ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
      : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const s = fs.fstatSync(fd), current = safeStat(name);
      if (!same(s,current) || s.nlink !== 1 || !s.isFile() || (before && !same(before,s))) unavailable();
      guard();
      return fd;
    } catch (e) { fs.closeSync(fd); throw e; }
  }
  return {
    verify: guard,
    write(id, bytes) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_BROWSER_ARTIFACT_BYTES) unavailable();
      const fd = open(id,true);
      try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); guard(); }
      finally { fs.closeSync(fd); }
      fs.fsyncSync(dirfd);
      return { byte_count: bytes.length, sha256: browserArtifactByteHash(bytes) };
    },
    read(id, expected) {
      const fd = open(id);
      try {
        const size = fs.fstatSync(fd).size;
        if (!Number.isSafeInteger(expected?.byte_count) || size !== expected.byte_count || size < 1 || size > MAX_BROWSER_ARTIFACT_BYTES ||
          !/^[a-f0-9]{64}$/.test(expected?.sha256)) unavailable();
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) { const n = fs.readSync(fd,bytes,offset,size-offset,offset); if (!n) unavailable(); offset += n; }
        if (fs.fstatSync(fd).size !== size || !same(fs.fstatSync(fd),safeStat(filename(id))) || browserArtifactByteHash(bytes) !== expected.sha256) unavailable();
        guard();
        return bytes;
      } finally { fs.closeSync(fd); }
    },
    remove(id) {
      const name = filename(id);
      try { safeStat(name); } catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
      guard(); fs.unlinkSync(name); fs.fsyncSync(dirfd);
      return 'deleted';
    },
    close() { if (!closed) fs.closeSync(dirfd); closed = true; },
  };
}
