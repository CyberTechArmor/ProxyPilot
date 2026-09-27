# Nodus administrator route protection status

Scope: `nodus-admin.fractionate.ai` only. The public
`nodus.fractionate.ai` route remains outside this protection request.

Read-only ProxyPilot MCP route inventory on 2026-09-27 showed the admin
hostname routing to managed LXC `nodus` at `10.185.17.240:3001`, with TLS
enabled and `websocket=false`. The public hostname routed to the same LXC at
port 3000 with WebSocket enabled. Keycloak and Pomerium were verified as
managed services, but the deployed MCP catalog did not expose the exact
verified Keycloak subject ID for Thomas. The supplied email spelling cannot
substitute for that subject ID.

Source now has `get_route_protection` and a revision-bound,
confirmation-token `set_route_protection` using the existing Pomerium review
and save operations. Platform-owned routes are identified by their recorded
owner; an unrelated managed LXC application on port 3001 can be reviewed.
WebSocket intent is preserved in generated Pomerium configuration. The MCP
apply action refuses managed LXC protection before queuing any job because
a persistent host ingress fence and direct-IP bypass proof do not yet exist.
The runner independently refuses this case before changing Caddy. The
administrator route therefore remains **unprotected by Pomerium**.

An independent read-only peer probe from the running `fractionate-demo`
container used ProxyPilot MCP `run_lxc_command` with
`curl -I --max-time 8 http://10.185.17.240:3001/`. It returned HTTP 200 in
189 ms on 2026-09-27 at 10:23 UTC. This is a concrete same-bridge direct-IP
bypass of the planned gateway. The probe did not change either guest.
`get_lxc_container(nodus)` also reported a bridge IPv6 address,
`fd42:53c1:d5e6:16b0:1266:6aff:fe92:72ae`; a fence limited to IPv4 would
be incomplete. An attempted IPv6 peer `curl` was refused by the current MCP
argument validator (`INVALID_ARGUMENT`), so IPv6 reachability remains
unmeasured rather than assumed denied.

Focused SQLite/MCP tests covered verified subjects, stale revisions,
single-use confirmation, MCP job provenance, managed LXC/WebSocket review,
and refusal without a host fence. The extended MCP catalog tests passed.
The full Pomerium and Full Platform test files have Windows-specific
Unix ownership/path failures in this checkout; their passing focused tests
do not establish Linux runtime behavior. Draft PR #694 head
`8a6298a10dbb957b77f9e9526b6f45e5aade4f7d` passed
[Security regression run 98](https://github.com/CyberTechArmor/ProxyPilot/actions/runs/36312310823),
which ran both full files on Linux. The unsuppressed host-boundary inventory
reported 96 candidate backend files and S6 open.

Next acceptance requires a persistent host ingress fence for the exact
Incus guest identity and all guest addresses; independent direct-IP probes
from another guest and routed source; a verified Keycloak subject readback;
and an actual browser sign-in through the admin hostname. The protected
route must retain its existing restrictions and pass WebSocket behavior if
the admin app needs it. No guest, including running `pp-nodus`, was started,
stopped, restarted, upgraded or deleted for this work. Rollback is a source
revert while the route remains unprotected; a future live apply needs a
separate verified fence removal order that never exposes the upstream.
