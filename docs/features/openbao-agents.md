# Connect an agent (OpenBao)

Platform Setup → Use your platform → **Agents and machines (OpenBao)**. Available
once OpenBao is verified with automatic custody.

## What it does

Each agent or machine gets its own OpenBao **AppRole** (`agent-<name>` on the
owned AppRole mount) and its own policy (`<prefix>-agent-<name>`):

```text
path "<kv>/data/agents/<name>/*"     { capabilities = ["read"] }
path "<kv>/metadata/agents/<name>/*" { capabilities = ["read", "list"] }
path "auth/token/lookup-self"        { capabilities = ["read"] }
path "auth/token/renew-self"         { capabilities = ["update"] }
path "auth/token/revoke-self"        { capabilities = ["update"] }
```

An agent is never an administrator. It can read only the credentials assigned
to it: no other agent's, not the team area, not any setting. Tokens last 1 hour
(4 hours max). Optional IPv4 ranges bind both the secret ID and its tokens to
the agent's addresses.

- **Register:** creates the policy and the role and issues one secret ID. The
  role ID and secret ID are shown **once**, in that response only; ProxyPilot
  keeps only the secret ID's accessor, so it can destroy the ID later.
- **Assign a credential:** the value typed in the dashboard is written to
  `<kv>/agents/<name>/<KEY>` as `{ value, description }`. Writing it again
  creates a new version.
- **Issue a new secret ID:** a new ID is shown once and the previous one is
  destroyed.
- **Remove:** deletes the role (which ends its secret IDs), every credential
  under the agent's path, and the policy.

The registry table (`openbao_agents`, migration 1017) holds names,
descriptions, ranges and credential *names* only. Every change uses a transient
root token from the automatic-custody shares, revoked and proved revoked
(`withTransientRoot`). Existing OpenBao objects with the same names are never
overwritten.

## Access and audit

- `GET /api/setup/platform/openbao/agents`: the list; no values.
- `POST /agents`, `PUT /agents/:name/credentials/:key`,
  `DELETE /agents/:name/credentials/:key`, `POST /agents/:name/rotate`,
  `DELETE /agents/:name`: each needs sudo and a fresh local sign-in, and is
  audited (`OPENBAO_AGENT_*`) without values.
- There is no MCP tool, because credential values and secret IDs are secret
  input and output.

## How an agent uses it

```bash
TOKEN=$(curl -s -X POST https://<openbao>/v1/auth/<approle-mount>/login \
  -d '{"role_id":"'"$OPENBAO_ROLE_ID"'","secret_id":"'"$OPENBAO_SECRET_ID"'"}' | jq -r .auth.client_token)
curl -s -H "X-Vault-Token: $TOKEN" https://<openbao>/v1/<kv>/data/agents/<name>/<KEY> | jq -r .data.data.value
```

The OpenBao route admits only the restricted networks, so the agent must reach
it from one of them (for example over the VPN).

## OpenBao or Infisical's Agent Proxy?

| | OpenBao (this page) | Infisical Agent Proxy |
| --- | --- | --- |
| The agent receives | the credential value | a placeholder; the proxy substitutes the real value in flight |
| The agent's rights | read its own path only | free edition: Admin of the ProxyPilot project (it could read every value there) |
| Best for | per-agent least privilege today | "never sees the value", once Enterprise custom roles are available |
