// Test hook (node --require): a writer that owns the tree being removed wins
// the race at the moment a directory's entries are listed — the directory
// whose real path ends with SWAP_DIR_SUFFIX is moved aside and replaced by a
// link to SWAP_TARGET (standing for protected data), once. It recognises the
// directory whether it is listed by path or through /proc/self/fd/<n>, and
// writes SWAP_MARK (when set) so a test can tell the race really happened.
const fs = require('node:fs');
const real = fs.readdirSync;
const suffix = process.env.SWAP_DIR_SUFFIX;
let done = false;
const resolve = p => { const s = Buffer.isBuffer(p) ? p.toString() : String(p); const m = /^\/proc\/self\/fd\/(\d+)$/.exec(s); if (!m) return s; try { return fs.readlinkSync(s); } catch { return s; } };
fs.readdirSync = function (p, ...rest) {
  if (!done && suffix && (typeof p === 'string' || Buffer.isBuffer(p))) {
    const dir = resolve(p);
    if (dir.endsWith(suffix)) {
      done = true;
      fs.renameSync(dir, `${dir}.moved`);
      fs.symlinkSync(process.env.SWAP_TARGET, dir);
      if (process.env.SWAP_MARK) fs.writeFileSync(process.env.SWAP_MARK, dir);
    }
  }
  return real.call(this, p, ...rest);
};
