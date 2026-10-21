// Test hook (node --require): the first time a file with more than one link
// is read, WRITE_TARGET (its other name, outside the tree) is appended to,
// once, standing for the service user writing to its own copy while the seal
// copies it. Writes SWAP_MARK (when set) so a test can tell the race happened.
const fs = require('node:fs');
const real = fs.readSync;
let done = false;
fs.readSync = function (fd, ...rest) {
  if (!done && process.env.WRITE_TARGET) {
    let shared = false;
    try { shared = fs.fstatSync(fd).nlink > 1; } catch { shared = false; }
    if (shared) {
      done = true;
      fs.appendFileSync(process.env.WRITE_TARGET, ' changed');
      if (process.env.SWAP_MARK) fs.writeFileSync(process.env.SWAP_MARK, 'written');
    }
  }
  return real.call(this, fd, ...rest);
};
