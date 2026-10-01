# Configured bounded worker

The worker is a separate process and registered mTLS identity. It accepts only
an explicit bounded list of the selected adapter's typed operations. It does
not execute arbitrary code, URLs or shell commands. Project/agent saving never
calls it; the dashboard's separate human start action dispatches an independently
registered task. The task source must sign current user, project, agent, worker,
grant, connection, attempt/fence and scope. The dashboard cannot sign this data.

Run locally with `node services/credential-broker/runner-main.mjs --config /absolute/private/worker.json`.
The JSON file (0600, service UID, no symlinks) contains:

```json
{
  "schema_version": 1,
  "state_dir": "/var/lib/fractionate-worker",
  "listener": {
    "host": "127.0.0.1", "port": 9444,
    "key_file": "/etc/fractionate-worker/server.key",
    "cert_file": "/etc/fractionate-worker/server.crt",
    "ca_file": "/etc/fractionate-worker/dashboard-ca.crt"
  },
  "broker": {
    "agent_origin": "https://broker-agent.example.invalid:9443",
    "ca_file": "/etc/fractionate-worker/broker-ca.crt",
    "cert_file": "/etc/fractionate-worker/worker.crt",
    "key_file": "/etc/fractionate-worker/worker.key"
  },
  "dashboard_fingerprints": ["REPLACE_WITH_EXACT_SHA256_HEX_CLIENT_CERTIFICATE_FINGERPRINT"]
}
```

These are documentation placeholders, not enabled destinations or host commands.
State directory must already exist, service-owned and0700. Private keys are read
from protected files; none are accepted in task bodies or command arguments.
The runner client in the dashboard uses a separately reviewed private config.
A ten-second authenticated readiness heartbeat proves the registered worker is
reachable to the broker; it mints no session and starts no work. Expired heartbeat
keeps execution disabled. TLS and exact client certificate pins protect task RPCs.

The worker reserves a durable task before requesting one broker session. The
broker independently reserves only one session per signed task epoch. Writes
pause with an exact pending request/session reference; a person reviews and
approves it on the broker's own authenticated surface. The worker can only
forward the returned approval ID. It cannot approve, widen policy or read vault
values. Bearers remain in memory; persisted state contains typed inputs and
sanitized receipt IDs/statuses. This metadata still requires restricted access.

Cancellation asks the broker to durably end the exact task epoch. An acknowledged
end prevents future sends; an already accepted upstream request cannot be undone.
`end_confirmed:false` means the terminal denial was not acknowledged; retrying
cancel only narrows authority. Possible-send transport failure is `uncertain`,
never automatic retry. Restart marks incomplete tasks interrupted (possible-send
state uncertain), discards sessions, and will not repeat the task ID. Recover by
reviewing receipts and registering a new linked task with fresh human approval.

Worker state is separate from broker recovery archives. Retain the private worker
SQLite database and WAL together under a stopped-process backup policy before
production activation; restoring it never resumes execution. The broker's signed
current task state remains the execution authority. No production installation,
network exception, service identity or live-task approval is implied by this file.
