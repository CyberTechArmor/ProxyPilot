// Test hook (node --require): right after the entry whose real path ends
// with SWAP_DIR_SUFFIX has been looked at (lstat), it is moved aside and
// replaced by a link to SWAP_TARGET (standing for a protected file), once.
// It recognises the entry whether it is named by path or through
// /proc/self/fd/<n>/<name>, and writes SWAP_MARK (when set) so a test can
// tell the race really happened.
const fs = require('node:fs');
const real = fs.lstatSync;
const suffix = process.env.SWAP_DIR_SUFFIX;
let done = false;
const resolve = p => { const s = Buffer.isBuffer(p) ? p.toString() : String(p); const m = /^\/proc\/self\/fd\/(\d+)\/(.+)$/.exec(s); if (!m) return s; try { return `${fs.readlinkSync(`/proc/self/fd/${m[1]}`)}/${m[2]}`; } catch { return s; } };
fs.lstatSync = function (p, ...rest) {
  const out = real.call(this, p, ...rest);
  if (!done && suffix && (typeof p === 'string' || Buffer.isBuffer(p))) {
    const entry = resolve(p);
    if (entry.endsWith(suffix)) {
      done = true;
      fs.renameSync(entry, `${entry}.moved`);
      fs.symlinkSync(process.env.SWAP_TARGET, entry);
      if (process.env.SWAP_MARK) fs.writeFileSync(process.env.SWAP_MARK, entry);
    }
  }
  return out;
};
