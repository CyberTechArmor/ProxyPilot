// Seed payload packing — a dependency-free ustar writer.
//
// WHY THIS EXISTS. The provisioning seed used to inline every template file,
// base64-encoded, into one shell script passed as a single argv entry. Linux
// caps a SINGLE argv entry at MAX_ARG_STRLEN (128 KiB, 32 pages) — not the
// total, the entry — so once the template grew past ~96 KiB of source the
// spawn failed with `E2BIG` and every new project reported
// "bare repo seed failed: spawn failed: spawn E2BIG".
//
// The established fix in this codebase (see concept.js / audit.js) is: keep the
// SCRIPT tiny and fixed in argv, and put the PAYLOAD on stdin, which has no
// size limit. This packs the whole file set into a tar so the script is one
// `tar -x` instead of N mkdir + printf + base64 chains — smaller, faster, and
// it carries file modes properly.
//
// PURE: bytes in, bytes out. No I/O, no spawning, no native modules.

const BLOCK = 512;
// A fixed mtime keeps the seed byte-reproducible: two provisions of the same
// template produce the same tar, which makes this testable and makes a diff
// between two seeds meaningful.
const MTIME = 0;

function padTo(buf, size) {
  const rem = buf.length % size;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(size - rem)]);
}

function writeString(header, value, offset, length) {
  header.write(String(value).slice(0, length - 1), offset, length - 1, 'utf8');
}

// ustar numeric fields are octal, NUL- or space-terminated.
function writeOctal(header, value, offset, length) {
  const s = Number(value).toString(8).padStart(length - 1, '0');
  header.write(s.slice(-(length - 1)), offset, length - 1, 'ascii');
}

// ustar splits a long path into prefix + name (155 + 100). Split on a '/' so
// both halves are valid path segments; a path that cannot be split is a bug in
// the caller, not something to silently truncate into the wrong file.
function splitPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  const err = new Error(`seed path too long for tar (max 100 + 155): ${path}`);
  err.code = 'PATH_TOO_LONG';
  throw err;
}

function header({ path, size, mode }) {
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitPath(path);
  writeString(h, name, 0, 100);
  writeOctal(h, mode ?? 0o644, 100, 8);   // mode
  writeOctal(h, 0, 108, 8);               // uid
  writeOctal(h, 0, 116, 8);               // gid
  writeOctal(h, size, 124, 12);           // size
  writeOctal(h, MTIME, 136, 12);          // mtime
  h.write('        ', 148, 8, 'ascii');   // checksum placeholder: 8 spaces
  h.write('0', 156, 1, 'ascii');          // typeflag: regular file
  h.write('ustar\0', 257, 6, 'ascii');    // magic
  h.write('00', 263, 2, 'ascii');         // version
  writeString(h, 'root', 265, 32);        // uname
  writeString(h, 'root', 297, 32);        // gname
  writeString(h, prefix, 345, 155);

  // Checksum is the unsigned sum of every header byte with the checksum field
  // itself read as spaces — which is why it is written last.
  let sum = 0;
  for (const b of h) sum += b;
  writeOctal(h, sum, 148, 7);
  h.write('\0', 154, 1, 'ascii');
  return h;
}

// buildSeedTar(files) → Buffer. files: [{ path, content, mode? }]
export function buildSeedTar(files) {
  const chunks = [];
  for (const f of files || []) {
    const body = Buffer.from(String(f.content ?? ''), 'utf8');
    chunks.push(header({ path: f.path, size: body.length, mode: f.mode }));
    chunks.push(padTo(body, BLOCK));
  }
  // Two zero blocks mark end-of-archive.
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

// The stdin payload: base64 so it survives as a string through the host runner
// (which takes `input` as text), and because base64 is a shell-safe charset.
export function buildSeedPayload(files) {
  return buildSeedTar(files).toString('base64');
}
