#!/usr/bin/env node
// Entry point for proxypilot-ssh-access-touch.service. Idempotent.
// Exits 0 on success, 0 on best-effort failure (we don't want the
// systemd unit to enter a failure state when `last` isn't installed
// or the journal isn't readable — the dashboard handles missing data
// gracefully). Logs to stdout/stderr for journalctl visibility.

import { touchLastSeen } from '../src/core/ssh-access/last-seen.js';

try {
  const r = touchLastSeen();
  if (r.ok) {
    console.log(`[ssh-access-touch] users_seen=${r.users_seen} updated=${r.updated}`);
    process.exit(0);
  }
  console.warn(`[ssh-access-touch] skipped: ${r.reason}`);
  process.exit(0);
} catch (e) {
  console.error(`[ssh-access-touch] fatal: ${e.message}`);
  process.exit(1);
}
