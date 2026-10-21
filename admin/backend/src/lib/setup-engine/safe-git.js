// Git over a repository someone else may control, from a root program in a
// container. A repository's own config can name commands git runs
// (core.fsmonitor, hooks, a pager), and the repository may belong to the
// application's service user, so git must never run those as root:
//   - git runs AS THE REPOSITORY'S OWNER (uid/gid of the work tree) whenever
//     that owner is not root, so the ownership guard (safe.directory) holds
//     without ever being widened — `safe.directory=*` is never passed;
//   - `-c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager`
//     switch off what the repository config could start;
//   - no system or global config, no terminal prompt, and no GIT_* variable
//     inherited from the caller.
// It is serialized into the guest programs (SAFE_GIT_SOURCE), so it references
// nothing outside its parameters. The storage check's scan program (WS1)
// follows the same rule.
//
//   safeGit(cp, fs, dir, args, opts?) → spawnSync result (encoding utf8);
//   `dir` is the work tree (git -C dir), `opts` extra spawnSync options.

export function safeGit(cp, fs, dir, args, opts = {}) {
  const argv = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-pager', '-C', dir, ...args];
  const env = {};
  for (const [k, v] of Object.entries(process.env || {})) if (!/^GIT_/.test(k)) env[k] = v;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  // The work tree itself: a real directory, never a link (refused, git not run).
  let st = null;
  try { st = fs.lstatSync(dir); } catch (e) { st = null; }
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return { status: 1, stdout: '', stderr: 'unsafe repository path', unsafe: true };
  const owner = st.uid !== 0 ? { uid: st.uid, gid: st.gid } : null;
  if (owner) env.HOME = '/nonexistent';
  return cp.spawnSync('git', argv, { encoding: 'utf8', maxBuffer: 1024 * 1024, ...opts, env, ...(owner || {}) });
}

export const SAFE_GIT_SOURCE = `const safeGit=${safeGit.toString()};`;
