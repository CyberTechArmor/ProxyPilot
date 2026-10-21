// Test hook (node --require): the owner of an entry's parent directory wins
// the race around the first rename (the quarantine rename) — for the duration
// of that one call the parent is a link to SWAP_TARGET (standing for /etc),
// and a real directory again right after. It recognises the parent whether
// the rename names it by path or through /proc/self/fd/<n>, and writes
// SWAP_MARK (when set) so a test can tell the race really happened.
const fs = require('node:fs');
const path = require('node:path');
const real = fs.renameSync;
let n = 0;
fs.renameSync = function (from, to) {
  n += 1;
  if (n !== 1) return real.call(fs, from, to);
  const s = Buffer.isBuffer(from) ? from.toString() : String(from);
  const m = /^\/proc\/self\/fd\/(\d+)\//.exec(s);
  const parent = m ? fs.readlinkSync(`/proc/self/fd/${m[1]}`) : path.dirname(s);
  real.call(fs, parent, `${parent}.real`);
  fs.symlinkSync(process.env.SWAP_TARGET, parent);
  if (process.env.SWAP_MARK) fs.writeFileSync(process.env.SWAP_MARK, parent);
  try { return real.call(fs, from, to); }
  finally { fs.unlinkSync(parent); real.call(fs, `${parent}.real`, parent); }
};
