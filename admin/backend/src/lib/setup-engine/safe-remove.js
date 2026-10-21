// The ONE remover for trees that someone other than root may write to: the
// storage cleanup program (guest and host), the release job's workspace,
// bundle and release retention, the selected-release removal and the
// pre-seal trim all go through it. It is serialized into those programs
// (SAFE_REMOVE_SOURCE), so it references nothing outside its parameters.
//
// Every operation is relative to a directory file descriptor, never to a
// path that is looked up again later. Node has no openat/unlinkat, so the
// Linux procfs magic link `/proc/self/fd/<n>` stands in for the directory:
// `/proc/self/fd/<n>/<name>` resolves <name> inside the directory that fd <n>
// has open, whatever has since been renamed or swapped around it, and the
// final <name> is never followed by lstat, rename, unlink or rmdir. A
// directory is entered only by opening it with O_NOFOLLOW|O_DIRECTORY and
// checking that what was opened is what was just looked at (dev/ino);
// another filesystem is never entered. Without a usable /proc/self/fd the
// remover refuses (NO_PROCFS): it fails closed rather than fall back to paths.
//
// safeRemover(fs, p) → {
//   openDir(dir)                 fd on dir, walked from / one component at a
//                                time (SYMLINK_IN_PATH / NOT_A_DIRECTORY)
//   openDirAt(dfd, name), lstatAt(dfd, name), existsAt(dfd, name),
//   renameAt(dfd, from, to), listAt(dfd), close(fd), same(a, b)
//   readFileAt(dfd, name, maxBytes)   a bounded read of a regular file,
//                                never through a link
//   removeTreeAt(dfd, name, dev, expect)   post-order removal of dfd/name:
//                                links are unlinked, never followed; a child
//                                on another device is MOUNT_INSIDE; a name
//                                that changes under it is
//                                CHANGED_DURING_REMOVAL → { bytes, entries }
//   removePath(x)                removeTreeAt for one absolute path, nothing
//                                mounted at or below it, parent fsynced
//   freezeTree(dir)              the seal's freeze (root-owned, read-only),
//                                by the same fd walk (CHANGED_DURING_FREEZE)
//   mountedAt(x), mountOf(x), inUse(x), refresh()   /proc/self/mounts and
//                                the open-file scan, re-read when older than
//                                2 seconds
// }
// Errors carry .refusal (a code) when nothing was changed by that step.

export function safeRemover(fs, p) {
  const C = fs.constants;
  const DIR = C.O_RDONLY | C.O_DIRECTORY;
  const DIR_NOFOLLOW = DIR | C.O_NOFOLLOW;
  const FRESH_MS = 2000;
  const PROC_SUPER_MAGIC = 0x9fa0;
  const refuse = code => { const e = new Error(code); e.refusal = code; throw e; };
  const bytesOf = x => (Buffer.isBuffer(x) ? x : Buffer.from(String(x)));
  const fdPath = fd => '/proc/self/fd/' + fd;
  const at = (dfd, name) => Buffer.concat([Buffer.from(fdPath(dfd) + '/'), bytesOf(name)]);
  const nameOk = name => {
    const b = bytesOf(name);
    if (!b.length || b.length > 255 || b.includes(0x2f) || b.includes(0)) return false;
    return !(b.length === 1 && b[0] === 0x2e) && !(b.length === 2 && b[0] === 0x2e && b[1] === 0x2e);
  };
  const same = (x, y) => !!x && !!y && x.dev === y.dev && x.ino === y.ino;
  const close = fd => { try { fs.closeSync(fd); } catch (e) { /* already closed */ } };
  let proc = null;
  function procOk() {
    if (proc === true) return;
    if (proc === false) refuse('NO_PROCFS');
    proc = false;
    let fd = null;
    try {
      if (typeof fs.statfsSync === 'function' && Number(fs.statfsSync('/proc/self/fd').type) !== PROC_SUPER_MAGIC) refuse('NO_PROCFS');
      fd = fs.openSync('/', DIR);
      if (!same(fs.fstatSync(fd), fs.statSync(fdPath(fd)))) refuse('NO_PROCFS');
      proc = true;
    } catch (e) { refuse('NO_PROCFS'); } finally { if (fd !== null) close(fd); }
  }
  function openDirAt(dfd, name) {
    if (!nameOk(name)) refuse('INVALID_PATH');
    try { return fs.openSync(at(dfd, name), DIR_NOFOLLOW); }
    catch (e) {
      if (e.code !== 'ELOOP' && e.code !== 'ENOTDIR') throw e;
      // Linux answers ENOTDIR (not ELOOP) for a link opened O_DIRECTORY|O_NOFOLLOW.
      let link = e.code === 'ELOOP';
      try { link = link || fs.lstatSync(at(dfd, name)).isSymbolicLink(); } catch (x) { /* gone meanwhile */ }
      refuse(link ? 'SYMLINK_IN_PATH' : 'NOT_A_DIRECTORY');
    }
  }
  function openDir(dir) {
    procOk();
    if (typeof dir !== 'string' || dir.charAt(0) !== '/' || p.normalize(dir) !== dir || dir.indexOf('\0') !== -1 || (dir !== '/' && dir.endsWith('/'))) refuse('INVALID_PATH');
    let fd = fs.openSync('/', DIR);
    try {
      for (const part of dir.split('/').filter(Boolean)) { const next = openDirAt(fd, part); close(fd); fd = next; }
      const out = fd; fd = null; return out;
    } finally { if (fd !== null) close(fd); }
  }
  const lstatAt = (dfd, name) => { if (!nameOk(name)) refuse('INVALID_PATH'); return fs.lstatSync(at(dfd, name)); };
  const existsAt = (dfd, name) => { try { lstatAt(dfd, name); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
  const renameAt = (dfd, from, to) => { if (!nameOk(from) || !nameOk(to)) refuse('INVALID_PATH'); fs.renameSync(at(dfd, from), at(dfd, to)); };
  const listAt = dfd => fs.readdirSync(fdPath(dfd), { encoding: 'buffer' });
  // readFileAt(dfd, name, maxBytes) → { stat, data } of a regular file opened
  // O_NOFOLLOW|O_NONBLOCK from its pinned parent, or null (a link, not a
  // regular file, larger than maxBytes, gone).
  function readFileAt(dfd, name, maxBytes = 4096) {
    if (!nameOk(name)) return null;
    let fd = null;
    try {
      fd = fs.openSync(at(dfd, name), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes) return null;
      const buffer = Buffer.alloc(Math.max(1, stat.size));
      const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return { stat, data: buffer.subarray(0, n) };
    } catch (e) { return null; } finally { if (fd !== null) close(fd); }
  }
  // Post-order removal of dfd/name. `expect` (the stat the caller verified)
  // must still be what the name is; a directory is entered by fd only after
  // its fstat matches the lstat just taken, and removed only while the name
  // still is that directory.
  function removeTreeAt(dfd, name, dev, expect) {
    const st = lstatAt(dfd, name);
    if (expect && !same(st, expect)) refuse('CHANGED_DURING_REMOVAL');
    let bytes = (st.blocks || 0) * 512, entries = 1;
    if (st.isDirectory()) {
      if (st.dev !== dev) refuse('MOUNT_INSIDE');
      const cfd = openDirAt(dfd, name);
      try {
        const opened = fs.fstatSync(cfd);
        if (opened.dev !== dev) refuse('MOUNT_INSIDE');
        if (!same(opened, st)) refuse('CHANGED_DURING_REMOVAL');
        for (const child of listAt(cfd)) { const r = removeTreeAt(cfd, child, dev, null); bytes += r.bytes; entries += r.entries; }
      } finally { close(cfd); }
      if (!same(lstatAt(dfd, name), st)) refuse('CHANGED_DURING_REMOVAL');
      fs.rmdirSync(at(dfd, name));
    } else {
      fs.unlinkSync(at(dfd, name));
    }
    return { bytes, entries };
  }
  const unescapeMount = x => x.replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
  let mountList = null, mountsAt = 0;
  function mounts() {
    const now = Date.now();
    if (mountList && now - mountsAt < FRESH_MS) return mountList;
    let text;
    try { text = fs.readFileSync('/proc/self/mounts', 'utf8'); } catch (e) { refuse('NO_PROCFS'); }
    mountList = []; mountsAt = now;
    for (const line of text.split('\n')) { const f = line.split(' '); if (f.length > 2) mountList.push({ path: unescapeMount(f[1]), type: f[2] }); }
    return mountList;
  }
  const mountedAt = x => mounts().some(m => m.path === x || m.path.startsWith(x + '/'));
  // The mount x lives on (the longest mount point that contains it).
  const mountOf = x => mounts().filter(m => m.path === '/' || x === m.path || x.startsWith(m.path + '/')).sort((u, v) => v.path.length - u.path.length)[0] || null;
  // What running processes hold open or work in: /proc/<pid>/cwd and fd links.
  let openList = null, openAt = 0;
  function openPaths() {
    const now = Date.now();
    if (openList && now - openAt < FRESH_MS) return openList;
    openList = []; openAt = now;
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter(x => /^[0-9]+$/.test(x)); } catch (e) { return openList; }
    for (const pid of pids) {
      if (pid === String(process.pid)) continue;
      try { openList.push(fs.readlinkSync('/proc/' + pid + '/cwd')); } catch (e) { /* gone */ }
      let fds = [];
      try { fds = fs.readdirSync('/proc/' + pid + '/fd'); } catch (e) { continue; }
      for (const fd of fds) { try { const t = fs.readlinkSync('/proc/' + pid + '/fd/' + fd); if (t.charAt(0) === '/') openList.push(t.replace(/ \(deleted\)$/, '')); } catch (e) { /* closed */ } }
    }
    openAt = Date.now();
    return openList;
  }
  const inUse = x => openPaths().some(o => o === x || o.startsWith(x + '/'));
  const refresh = () => { mountList = null; openList = null; };
  // freezeTree(dir): the release seal's freeze, through the same walker —
  // every entry owned by root; directories 0755, files 0444 (0555 when
  // executable). A link is re-owned (lchown, never followed); a file is
  // opened O_NOFOLLOW from its pinned parent and changed through that fd
  // only; a directory is entered by fd after its fstat matches its lstat;
  // another filesystem is never entered; anything else keeps its mode.
  function freezeAt(dfd, dev) {
    for (const name of listAt(dfd)) {
      const st = lstatAt(dfd, name);
      if (st.isSymbolicLink()) { fs.lchownSync(at(dfd, name), 0, 0); continue; }
      if (st.isDirectory()) {
        if (st.dev !== dev) refuse('MOUNT_INSIDE');
        const cfd = openDirAt(dfd, name);
        try {
          const opened = fs.fstatSync(cfd);
          if (opened.dev !== dev) refuse('MOUNT_INSIDE');
          if (!same(opened, st)) refuse('CHANGED_DURING_FREEZE');
          freezeAt(cfd, dev);
          fs.fchownSync(cfd, 0, 0); fs.fchmodSync(cfd, 0o755);
        } finally { close(cfd); }
      } else if (st.isFile()) {
        let ffd;
        try { ffd = fs.openSync(at(dfd, name), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK); }
        catch (e) { if (e.code === 'ELOOP') refuse('CHANGED_DURING_FREEZE'); throw e; }
        try {
          const opened = fs.fstatSync(ffd);
          if (!opened.isFile() || !same(opened, st)) refuse('CHANGED_DURING_FREEZE');
          fs.fchownSync(ffd, 0, 0); fs.fchmodSync(ffd, (opened.mode & 0o111) ? 0o555 : 0o444);
        } finally { close(ffd); }
      } else {
        fs.lchownSync(at(dfd, name), 0, 0);
      }
    }
  }
  function freezeTree(dir) {
    const fd = openDir(dir);
    try {
      const st = fs.fstatSync(fd);
      freezeAt(fd, st.dev);
      fs.fchownSync(fd, 0, 0); fs.fchmodSync(fd, 0o755);
    } finally { close(fd); }
  }
  function removePath(x) {
    if (typeof x !== 'string' || x.charAt(0) !== '/' || p.normalize(x) !== x || x === '/' || x.endsWith('/') || x.indexOf('\0') !== -1) refuse('INVALID_PATH');
    if (mountedAt(x)) refuse('MOUNT_INSIDE');
    const pfd = openDir(p.dirname(x));
    try {
      const name = p.basename(x);
      const st = lstatAt(pfd, name);
      const r = removeTreeAt(pfd, name, st.dev, st);
      fs.fsyncSync(pfd);
      return r;
    } finally { close(pfd); }
  }
  return { openDir, openDirAt, lstatAt, existsAt, renameAt, listAt, readFileAt, close, same, removeTreeAt, removePath, freezeTree, mountedAt, mountOf, inUse, refresh };
}

export const SAFE_REMOVE_SOURCE = `const safeRemover=${safeRemover.toString()};`;
