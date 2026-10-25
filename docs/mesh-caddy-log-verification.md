# Mesh credential-log verification

The Mesh rollout uses a single Caddy filter with ordered regexp operations for
global/dashboard logs: mask MCP token paths, then remove complete query strings.
Nested filters did not compose on the same request URI in Caddy 2.11.4.
Managed service logs use the dedicated query filter, deleting auth, rauth and
login from URI and Referer while retaining other query fields.

The updater verifies the active global configuration and an isolated loopback
fixture before rebuilding. The fixture covers normal requests, refused upstream
connections, encoded/repeated query keys, Referer and an MCP token-path sentinel.
The existing get_route_access_log result includes a sanitized credential_redaction
proof for the exact loaded domain logger after regeneration. No raw config or
request data is returned by that proof.

Keep review-runtime identity checks enabled during updates. The configured A3
proof VM must be running: pp-agents-a3-debian13-proof-20260927, UUID
49592202-a8b0-45af-9ac6-5439761d73e4. A stopped VM cannot provide live identity
proof. Start the existing VM, verify its actual identity, and retry the pinned
update; do not rewrite its keys or bypass the refresh guard.
