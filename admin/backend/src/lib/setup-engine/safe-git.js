// Git over a repository someone else may control, from a root program in a
// container. A repository's own config can name commands git runs
// (core.fsmonitor, hooks, a pager, an ssh command, clean/smudge filter
// drivers that `git status` runs), and the repository may belong to the
// application's service user, so git must never run those as root. This is
// the ONE safe git: the release guest program, the storage cleanup and the
// storage check's scan program embed SAFE_GIT_SOURCE.
//   - Read-only git never runs as root. It runs as the first non-root owner
//     among the work tree, `.git` and `.git/config` (whoever can write the
//     configuration), otherwise as `nobody` (the guest's own nobody, else
//     65534:65534), with `-c safe.directory=<that exact path>` (command-line
//     config is protected scope; `safe.directory=*` is never passed) and
//     --no-optional-locks. When that identity cannot read the tree, git
//     fails and the answer is unknown: callers then remove nothing.
//   - opts.asRoot (only the release stage's checkout into the fresh clone
//     root itself just made) runs as root, and only when the work tree,
//     `.git` and `.git/config` all belong to root and none of `.git` and
//     its config is writable by a non-root group or others.
//   - All owners root but `.git` or `.git/config` writable by a non-root
//     group or others: git is not run at all (unsafe).
//   - On the command line (which wins over the repository's config):
//     --no-pager, --no-optional-locks, core.fsmonitor=false,
//     core.hooksPath=/dev/null, core.attributesFile=/dev/null,
//     core.sshCommand=false, protocol.allow=never.
//   - A clean environment: PATH, HOME=/nonexistent, no system or global
//     config, no prompt, no optional locks, GIT_PAGER=cat, LC_ALL=C — nothing
//     else from the caller; stdin closed; run from `/`; bounded output and
//     time (20 s unless opts.timeout says otherwise).
//   - A work tree, `.git` or `.git/config` that is a link, a missing work
//     tree, or a `.git` that is not a directory: not run (unsafe). A caller
//     that is not root only runs git over its own (or root's) repositories.
// It is serialized into the guest programs (SAFE_GIT_SOURCE), so it references
// nothing outside its parameters and the `process` global.
//
//   safeGit(cp, fs, dir, args, opts?) → { ok, status, stdout, stderr, asUid,
//     reason?, unsafe? } — `dir` is the work tree (git -C dir); opts:
//     { timeout, maxBuffer, asRoot }. ok is status === 0; unsafe is set when
//     git was not run; asUid is the identity git ran as (null: root).

export function safeGit(cp, fs, dir, args, opts = {}) {
  const ARGS = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'core.sshCommand=false', '-c', 'protocol.allow=never'];
  const unsafe = reason => ({ ok: false, status: 1, stdout: '', stderr: `unsafe repository: ${reason}`, asUid: null, unsafe: true, reason });
  if (typeof dir !== 'string' || dir.charAt(0) !== '/' || dir.indexOf('\0') !== -1) return unsafe('not an absolute path');
  let owner = null, writable = false;
  const parts = [dir, `${dir}/.git`, `${dir}/.git/config`];
  for (let i = 0; i < parts.length; i += 1) {
    let st = null;
    try { st = fs.lstatSync(parts[i]); } catch (e) { st = null; }
    if (!st) { if (i === 0) return unsafe('missing work tree'); continue; }
    if (st.isSymbolicLink()) return unsafe('a link');
    if (i < 2 && !st.isDirectory()) return unsafe(i === 0 ? 'not a directory' : '.git is not a directory');
    if (!owner && st.uid !== 0) owner = { uid: st.uid, gid: st.gid };
    if (i > 0 && ((st.mode & 0o002) || ((st.mode & 0o020) && st.gid !== 0))) writable = true;
  }
  if (!owner && writable) return unsafe('configuration writable by a non-root group or others');
  let real = dir;
  try { real = fs.realpathSync(dir); } catch (e) { return unsafe('unreadable path'); }
  const me = typeof process.getuid === 'function' ? process.getuid() : null;
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' };
  let as = null;
  if (opts.asRoot) {
    if (owner) return unsafe('not owned by root');
  } else if (me === 0) {
    as = owner;
    if (!as) {
      // The guest's own unprivileged account, else the conventional 65534.
      as = { uid: 65534, gid: 65534 };
      try {
        const line = String(fs.readFileSync('/etc/passwd', 'utf8')).split('\n').find(l => l.split(':')[0] === 'nobody');
        const f = line ? line.split(':') : null;
        if (f && /^[0-9]+$/.test(f[2]) && /^[0-9]+$/.test(f[3]) && Number(f[2]) !== 0) as = { uid: Number(f[2]), gid: Number(f[3]) };
      } catch (e) { /* the conventional ids */ }
    }
  } else if (me !== null && owner && owner.uid !== me) return unsafe('owned by another account');
  const scoped = opts.asRoot ? [] : ['-c', `safe.directory=${real}`, '-c', `safe.directory=${real}/.git`];
  const { asRoot, ...spawnOpts } = opts;
  let r;
  try { r = cp.spawnSync('git', ARGS.concat(scoped, ['-C', dir], args), { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 20000, ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'], cwd: '/', env, ...(as ? { uid: as.uid, gid: as.gid } : {}) }); }
  catch (e) { return { ok: false, status: 1, stdout: '', stderr: '', asUid: as ? as.uid : null, reason: 'git could not start' }; }
  const status = r.error ? 1 : r.status;
  return { ok: status === 0, status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), asUid: as ? as.uid : null, ...(status === 0 ? {} : { reason: 'git refused or failed' }) };
}

export const SAFE_GIT_SOURCE = `const safeGit=${safeGit.toString()};`;
