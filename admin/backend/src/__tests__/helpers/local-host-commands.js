// Tests with real child commands own files in the test process's namespace.
// Model the host boundary without escaping a Docker test environment: preserve
// the command, argv, stdin and streams and run the real command locally.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function localHostCommands(t) {
  const bin = mkdtempSync(join(tmpdir(), 'pp-test-host-'));
  const before = process.env.PATH;
  writeFileSync(join(bin, 'nsenter'), `#!/bin/sh
test "$1 $2 $3 $4 $5 $6" = '-t 1 -m -u -n -i' || exit 90
shift 6
exec "$@"
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${before}`;
  t.after(() => { process.env.PATH = before; rmSync(bin, { recursive: true, force: true }); });
}
