# Connect an agent (OpenBao or Infisical)

ProxyPilot runs Infisical's **free** self-hosted edition, and everything here is
built for it. There are two ways to give an agent or machine its credentials:

- **OpenBao:** the agent reads its own values, and only its own. Least privilege
  is fully enforced.
- **Infisical Agent Proxy:** the agent sends a placeholder and the proxy puts in
  the real value. Each agent has its own project, so a compromise stays inside
  that agent's credentials.

## OpenBao

Platform Setup → Use your platform → **Agents and machines (OpenBao)**. Available
once OpenBao is verified with automatic custody.

### What it does

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

### Access and audit

- `GET /api/setup/platform/openbao/agents`: the list; no values.
- `POST /agents`, `PUT /agents/:name/credentials/:key`,
  `DELETE /agents/:name/credentials/:key`, `POST /agents/:name/rotate`,
  `DELETE /agents/:name`: each needs sudo and a fresh local sign-in, and is
  audited (`OPENBAO_AGENT_*`) without values.
- There is no MCP tool, because credential values and secret IDs are secret
  input and output.

### How an agent uses it

```bash
TOKEN=$(curl -s -X POST https://<openbao>/v1/auth/<approle-mount>/login \
  -d '{"role_id":"'"$OPENBAO_ROLE_ID"'","secret_id":"'"$OPENBAO_SECRET_ID"'"}' | jq -r .auth.client_token)
curl -s -H "X-Vault-Token: $TOKEN" https://<openbao>/v1/<kv>/data/agents/<name>/<KEY> | jq -r .data.data.value
```

The OpenBao route admits only the restricted networks, so the agent must reach
it from one of them (for example over the VPN).

## Infisical Agent Proxy (one project per agent)

Platform Setup → Use your platform → **Agents through the Infisical Agent
Proxy**. Available once Infisical is verified with the Agent Proxy.

### Why one project per agent
On the free edition, only Infisical's built-in **Admin** role may use the Agent
Proxy. Narrower custom roles are a paid feature, and ProxyPilot does not use
them. So an agent's identity must be Admin of *some* project. ProxyPilot makes
that project the agent's own:

- **Register** creates:
  - a project, `pp-agent-<name>`, with one environment, `agent`;
  - a machine identity with **No Access** in the organization and **Admin** of
    that project only;
  - Viewer membership in that project for the managed Agent Proxy identity, so
    the proxy can put the values in;
  - a Universal Auth client secret (5-minute tokens), shown **once**.
- **Assign a credential** stores the value as a secret in the agent's project
  and creates a proxied service. For requests to the sites you name
  (`host[:port][/path]`, comma separated), the proxy replaces the placeholder
  `pp-placeholder-<agent>-<key>` (in headers by default) with the real value.
  Assigning it again updates both.
- **Issue a new client secret** revokes the previous one.
- **Remove** deletes the project (its secrets and proxied services) and the
  identity.

What a compromised agent can and cannot do: it can read the values in **its own**
project, because it is Admin there. It cannot reach another agent's project,
ProxyPilot's own project, or the organization. Give each agent its own account
with the provider (a dedicated API key, never a personal one), so a leak is
contained and can be rotated.

### Authority and audit
- Changes are made as the Infisical administrator, signed in for that request
  only:
  - the password is read from OpenBao when it is kept there
    (`team/infisical-administrator`);
  - otherwise the person types it for the change, and it is never stored or
    logged;
  - an administrator with Infisical's two-factor authentication turned on is
    refused; make the change in Infisical itself.
- Routes are under `/api/setup/platform/infisical/agents`. Each change needs
  sudo and a fresh local sign-in, and is audited (`INFISICAL_AGENT_*`) without
  values. There is no MCP tool.
- The registry table (`infisical_agents`, migration 1018) holds names, IDs and
  sites only.

### How an agent uses it
```bash
TOKEN=$(curl -s -X POST https://<infisical>/api/v1/auth/universal-auth/login \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"'"$INFISICAL_CLIENT_ID"'","clientSecret":"'"$INFISICAL_CLIENT_SECRET"'"}' | jq -r .accessToken)
curl -x http://<private-ip>:17322 --proxy-user "<projectId>:agent/:$TOKEN" \
  -H "Authorization: Bearer pp-placeholder-<agent>-<key>" https://<site>/...
```

- The agent must reach Infisical, which admits only the restricted networks,
  and the Agent Proxy, which listens only on this host's private address. For
  an agent in a container on this host, use "Runs in container" (below). An
  agent elsewhere needs the VPN or an entry in Restricted networks. Don't put
  a VPN config inside an agent: its key would open every restricted service.

### Agents in containers on this host ("Runs in container")
Choose the container when you register the agent, or link it later
(`POST …/agents/:name/container`; unlink with `…/container/remove`). This is
`lib/setup-engine/agent-network.js`:

1. **Admitted on the Infisical route only.** The container's fixed eth0
   address is added as a `/32` when the Infisical route is rendered
   (`agentSourcesForRoute` → `extraAllow` in `routeEdgeOptionLines`). The
   stored restricted networks and every other route (OpenBao, Recovery,
   Keycloak admin, the dashboard) are unchanged. A container without a fixed
   address is refused, so the admitted address cannot move to another
   container.
2. **The name points at this host inside the container.** One marked
   `/etc/hosts` line (`# proxypilot-infisical-agent`) maps the Infisical
   hostname to the bridge gateway. Requests then reach Caddy directly with the
   container's own address, instead of looping through the router and arriving
   as the router's address.
3. **Checked from inside.** A TCP check to Infisical (443 on the gateway) and to
   the Agent Proxy is reported, using nc, bash or python3, whichever the image
   has.

If the route update fails, nothing is admitted and the hosts line is removed.
Unlinking, or removing the agent, re-renders the route without the address, and
removes the hosts line once no other agent uses that container. A five-minute
sweep (`sweepAgentContainers`, from `index.js`) drops a link whose container is
gone, has a different address, or is a different container with the same name
(`volatile.uuid`). An unreadable inventory changes nothing. Linking needs no
Infisical authority, but it does need sudo and a fresh local sign-in, and it is
audited (`INFISICAL_AGENT_CONTAINER_*`). Migration 1019 adds the columns.
- For HTTPS sites the proxy inspects the request, so the agent must trust the
  Agent Proxy's CA certificate (see Infisical's Agent Proxy documentation).

## Which one to use

| | OpenBao | Infisical Agent Proxy |
| --- | --- | --- |
| The agent handles | the real value | a placeholder; the proxy puts in the value |
| A compromised agent can read | its own credentials | its own credentials (it is Admin of its own project) |
| Other agents' credentials | unreachable | unreachable (separate projects) |
| Limits where a value is sent | no | yes, only to the sites you name |
| Good default for | agents that must read a value (SDKs, databases) | agents calling HTTP APIs, where the value should stay out of the agent's code and logs |
