/**
 * POSIX single-quote shell escape. Inside single quotes EVERY byte
 * is literal except the single quote itself, which we encode by
 * closing the literal, emitting an escaped quote, and reopening:
 *   foo'bar  →  'foo'\''bar'
 * Safe against `$()`, backticks, `$VAR`, newlines, `;`, `&&`, `|`,
 * etc. Every operator-supplied value passed into a shell command
 * (peer name, scope, rule id, container name, label text, etc.)
 * MUST go through this helper before being concatenated into the
 * argv string. Do NOT swap this for JSON.stringify — the
 * double-quote form leaves `$()` and backticks live for command
 * substitution, which would let a label like `$(rm -rf /)` execute
 * as root in the host PID namespace.
 */
export function shellSingleQuote(s) {
  if (s === undefined || s === null) return "''";
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
