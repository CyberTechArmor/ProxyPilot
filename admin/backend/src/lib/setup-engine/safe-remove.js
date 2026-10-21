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
//   removeTreeAt(dfd, name, dev, expect)   post-order removal of dfd/name,
//                                iterative (no recursion), at most 512
//                                directories open (deeper, or out of file
//                                descriptors: TOO_DEEP): links are unlinked,
//                                never followed; a child on another device is
//                                MOUNT_INSIDE; a name that changes under it is
//                                CHANGED_DURING_REMOVAL → { bytes, entries }
//                                (bytes: files whose last link went)
//   measureTreeAt(...)           the same walk without removing (TOO_DEEP and
//                                MOUNT_INSIDE before anything is changed)
//   removePath(x)                removeTreeAt for one absolute path, nothing
//                                mounted at or below it, parent fsynced
//   freezeTree(dir)              the seal's freeze (root-owned, read-only),
//                                by the same iterative fd walk
//                                (CHANGED_DURING_FREEZE, TOO_DEEP); a file
//                                with other links is copied, never changed
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
  // At most 512 directories open at once, and never more than the process's
  // own open-file limit allows (with room for listing and the caller's fds).
  let MAX_DEPTH = 512;
  try {
    const m = /^Max open files\s+(\d+)/m.exec(fs.readFileSync('/proc/self/limits', 'utf8'));
    if (m) MAX_DEPTH = Math.max(16, Math.min(MAX_DEPTH, Number(m[1]) - 48));
  } catch (e) { /* the default */ }
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
  // Directories are walked iteratively (no recursion, so depth never
  // overflows the stack) with at most MAX_DEPTH directories open; deeper, or
  // out of file descriptors, is TOO_DEEP. Each directory is entered by fd
  // only after its fstat matches the lstat just taken (else `changed`);
  // onEnter(fd) runs before its entries are listed.
  function enterAt(parentFd, name, st, dev, depth, changed = 'CHANGED_DURING_REMOVAL', onEnter = null) {
    if (st.dev !== dev) refuse('MOUNT_INSIDE');
    if (depth >= MAX_DEPTH) refuse('TOO_DEEP');
    let fd;
    try { fd = openDirAt(parentFd, name); }
    catch (e) { if (e.code === 'EMFILE' || e.code === 'ENFILE') refuse('TOO_DEEP'); throw e; }
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== dev) refuse('MOUNT_INSIDE');
      if (!same(opened, st)) refuse(changed);
      if (onEnter) onEnter(fd);
      return { parentFd, name, st, fd, names: listAt(fd), i: 0 };
    } catch (e) { close(fd); throw e; }
  }
  // walkAt(dfd, name, dev, expect, remove) → { bytes, entries }. remove false
  // only measures (and refuses TOO_DEEP / MOUNT_INSIDE before anything is
  // changed); remove true is the post-order removal: links are unlinked,
  // never followed; a directory is removed only while its name still is the
  // directory just emptied. Bytes count a file only when its last link goes
  // (a hard link elsewhere keeps the blocks).
  function walkAt(dfd, name, dev, expect, remove) {
    try { return walk(dfd, name, dev, expect, remove); }
    catch (e) { if (e && (e.code === 'EMFILE' || e.code === 'ENFILE')) refuse('TOO_DEEP'); throw e; }
  }
  function walk(dfd, name, dev, expect, remove) {
    const top = lstatAt(dfd, name);
    if (expect && !same(top, expect)) refuse('CHANGED_DURING_REMOVAL');
    const freed = st => (st.isDirectory() || st.nlink <= 1 ? (st.blocks || 0) * 512 : 0);
    if (!top.isDirectory()) {
      if (remove) fs.unlinkSync(at(dfd, name));
      return { bytes: freed(top), entries: 1 };
    }
    let bytes = 0, entries = 0;
    const stack = [];
    try {
      stack.push(enterAt(dfd, name, top, dev, 0));
      while (stack.length) {
        const cur = stack[stack.length - 1];
        if (cur.i < cur.names.length) {
          const child = cur.names[cur.i++];
          const st = lstatAt(cur.fd, child);
          if (st.isDirectory()) { stack.push(enterAt(cur.fd, child, st, dev, stack.length)); continue; }
          if (remove) fs.unlinkSync(at(cur.fd, child));
          bytes += freed(st); entries += 1;
          continue;
        }
        stack.pop(); close(cur.fd);
        if (remove) {
          if (!same(lstatAt(cur.parentFd, cur.name), cur.st)) refuse('CHANGED_DURING_REMOVAL');
          fs.rmdirSync(at(cur.parentFd, cur.name));
        }
        bytes += freed(cur.st); entries += 1;
      }
    } finally { for (const f of stack) close(f.fd); }
    return { bytes, entries };
  }
  const removeTreeAt = (dfd, name, dev, expect) => walkAt(dfd, name, dev, expect, true);
  const measureTreeAt = (dfd, name, dev, expect) => walkAt(dfd, name, dev, expect, false);
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
  // freezeTree(dir): the release seal's freeze, by the same iterative walk
  // as the remover (no recursion; TOO_DEEP past MAX_DEPTH folders or out of
  // file descriptors) — every entry owned by root; directories 0755, files
  // 0444 (0555 when executable). A directory is entered by fd after its
  // fstat matches its lstat and is re-owned BEFORE its entries are touched,
  // so nobody else can add, rename or swap a name in it meanwhile; another
  // filesystem is never entered. A file is opened O_NOFOLLOW from its pinned
  // parent and changed through that fd only. A link is re-owned (lchown,
  // never followed); anything else keeps its mode.
  // An inode with more than one link may also be named OUTSIDE the tree (a
  // package store in the service user's home, a preserved data path), so it
  // is never changed: a regular file is copied byte for byte into a new
  // root-owned file made O_CREAT|O_EXCL|O_NOFOLLOW in the same pinned
  // folder, synced, given its frozen owner and mode, and renamed over the
  // name (the original inode keeps its other names, owner, mode and bytes);
  // a link is re-created the same way; any other shared entry is left alone.
  const FREEZE_COPY = 1 << 20;
  function tempAt(dfd, make) {
    for (let n = 0; n < 1000; n += 1) {
      const tmp = '.pp-freeze-' + n;
      try { return { tmp, made: make(at(dfd, tmp)) }; }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    refuse('CHANGED_DURING_FREEZE');
  }
  function replaceAt(dfd, name, st, tmp) {
    if (!same(lstatAt(dfd, name), st)) refuse('CHANGED_DURING_FREEZE');
    fs.renameSync(at(dfd, tmp), at(dfd, name));
  }
  function freezeFileAt(dfd, name, st) {
    let ffd;
    try { ffd = fs.openSync(at(dfd, name), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK); }
    catch (e) { if (e.code === 'ELOOP') refuse('CHANGED_DURING_FREEZE'); throw e; }
    try {
      const opened = fs.fstatSync(ffd);
      if (!opened.isFile() || !same(opened, st)) refuse('CHANGED_DURING_FREEZE');
      const mode = (opened.mode & 0o111) ? 0o555 : 0o444;
      if (opened.nlink <= 1) { fs.fchownSync(ffd, 0, 0); fs.fchmodSync(ffd, mode); return; }
      const { tmp, made: tfd } = tempAt(dfd, x => fs.openSync(x, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600));
      let done = false;
      try {
        const buf = Buffer.alloc(FREEZE_COPY);
        let pos = 0;
        for (;;) {
          const n = fs.readSync(ffd, buf, 0, buf.length, pos);
          if (n <= 0) break;
          for (let w = 0; w < n;) w += fs.writeSync(tfd, buf, w, n - w, pos + w);
          pos += n;
        }
        // The other name may still be written to: a copy that is not the
        // whole, unchanged file is not frozen.
        const after = fs.fstatSync(ffd);
        if (pos !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) refuse('CHANGED_DURING_FREEZE');
        fs.fsyncSync(tfd);
        fs.fchownSync(tfd, 0, 0); fs.fchmodSync(tfd, mode);
        replaceAt(dfd, name, opened, tmp);
        done = true;
      } finally {
        close(tfd);
        if (!done) { try { fs.unlinkSync(at(dfd, tmp)); } catch (e) { /* not made */ } }
      }
    } finally { close(ffd); }
  }
  function freezeEntryAt(dfd, name, st) {
    if (st.isFile()) return freezeFileAt(dfd, name, st);
    if (st.nlink <= 1) { fs.lchownSync(at(dfd, name), 0, 0); return; }
    if (!st.isSymbolicLink()) return; // a shared special file: never changed (the artifact refuses it anyway)
    const target = fs.readlinkSync(at(dfd, name), { encoding: 'buffer' });
    const { tmp } = tempAt(dfd, x => fs.symlinkSync(target, x));
    let done = false;
    try { fs.lchownSync(at(dfd, tmp), 0, 0); replaceAt(dfd, name, st, tmp); done = true; }
    finally { if (!done) { try { fs.unlinkSync(at(dfd, tmp)); } catch (e) { /* not made */ } } }
  }
  const freezeDir = fd => { fs.fchownSync(fd, 0, 0); fs.fchmodSync(fd, 0o755); };
  function freezeTree(dir) {
    const top = openDir(dir);
    const stack = [];
    try {
      const dev = fs.fstatSync(top).dev;
      freezeDir(top);
      stack.push({ fd: null, names: listAt(top), i: 0, dfd: top });
      while (stack.length) {
        const cur = stack[stack.length - 1];
        if (cur.i >= cur.names.length) { stack.pop(); if (cur.fd !== null) close(cur.fd); continue; }
        const name = cur.names[cur.i++];
        const st = lstatAt(cur.dfd, name);
        if (st.isDirectory()) {
          const child = enterAt(cur.dfd, name, st, dev, stack.length, 'CHANGED_DURING_FREEZE', freezeDir);
          child.dfd = child.fd;
          stack.push(child);
          continue;
        }
        freezeEntryAt(cur.dfd, name, st);
      }
    } catch (e) {
      if (e && (e.code === 'EMFILE' || e.code === 'ENFILE')) refuse('TOO_DEEP');
      throw e;
    } finally {
      for (const f of stack) if (f.fd !== null) close(f.fd);
      close(top);
    }
  }
  function removePath(x) {
    if (typeof x !== 'string' || x.charAt(0) !== '/' || p.normalize(x) !== x || x === '/' || x.endsWith('/') || x.indexOf('\0') !== -1) refuse('INVALID_PATH');
    if (mountedAt(x)) refuse('MOUNT_INSIDE');
    const pfd = openDir(p.dirname(x));
    try {
      const name = p.basename(x);
      const st = lstatAt(pfd, name);
      measureTreeAt(pfd, name, st.dev, st); // TOO_DEEP / MOUNT_INSIDE before anything is removed
      const r = removeTreeAt(pfd, name, st.dev, st);
      fs.fsyncSync(pfd);
      return r;
    } finally { close(pfd); }
  }
  return { openDir, openDirAt, lstatAt, existsAt, renameAt, listAt, readFileAt, close, same, removeTreeAt, measureTreeAt, removePath, freezeTree, mountedAt, mountOf, inUse, refresh };
}

export const SAFE_REMOVE_SOURCE = `const safeRemover=${safeRemover.toString()};`;
