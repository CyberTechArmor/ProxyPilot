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

## 2026-09-27 exact-subject continuation

Current deployed main was read back as `aba43253b18bc068418b2ee129bfcb83afa070a8`
(PR #696), clean. PRs #694 and #695 are merged and deployed. The live MCP
connection still advertises an older tool catalog: `get_route_protection`,
`set_route_protection`, and `inspect_a3_vm` are not callable in this session.
No protection policy was applied.

Read-only MCP `get_lxc_container(nodus)` showed `pp-nodus` Running at
`10.185.17.240` and `fd42:53c1:d5e6:16b0:1266:6aff:fe92:72ae`.
`run_lxc_command(fractionate-demo, "curl -I --max-time 8
http://10.185.17.240:3001/")` returned HTTP 200 in 33 ms, confirming the
same-bridge bypass remains open. An IPv6 `curl` and `probe_lxc_port` were
refused by the MCP argument validators, so IPv6 denial is not proved.
The continuation source permits a bare IPv6 literal in `probe_lxc_port`
and brackets it in the curl URL; this is not yet deployed or a bypass proof.
`test_route(nodus-admin.fractionate.ai, test_websocket=true)` showed edge
HTTP 302 to `/admin/`, direct upstream HTTP 200 and no WebSocket upgrade.
An unauthenticated browser loaded the Nodus admin landing page without a
Pomerium redirect. The public `nodus.fractionate.ai` route remains separate.

Source in the continuation branch adds optional exact-email lookup to
`get_route_protection`, using the already configured Keycloak `view-users`
observer. It requires one exact match, reads that user back by ID, and
refuses disabled, missing, ambiguous, changed or wrong-issuer results.
`set_route_protection` checks any subject without an existing verified SSO
link against the same observer on both review and apply; the existing
revision and single-use confirmation checks remain. The supplied
`thomas@fractinate.ai` is test input, not a guessed ID. No live subject ID
has been read back. The managed LXC ingress-fence refusal remains active.

Local affected tests: seven focused Pomerium/MCP/identity tests passed;
22 MCP catalog, Debian 13 and VM creation tests passed. The full Pomerium
and Full Platform tests were attempted on Windows and failed on their
Unix-specific ownership/path assumptions; their exact pre-change PR heads
passed Linux Security regression runs 101 and 103. The unsuppressed host
boundary inventory returned 96 candidate backend files with S6 open.
Rollback for this source-only identity extension is a code revert; no
Keycloak user, credential, Pomerium policy, firewall or guest was changed.
Live acceptance still requires the persistent host bridge ingress fence,
independent IPv4/IPv6 bypass denial, resolved Keycloak ID, MCP policy apply
and readback, and authorized plus unauthenticated browser checks.
