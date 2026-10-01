# Self-contained ProxyPilot direction and deployment compatibility

## Accepted direction — 2026-10-01

ProxyPilot remains self-contained, including its own
identity stack, with Keycloak as the intended identity provider. ProxyPilot can
continue on its current product path. A separate, optional management platform is
future scope. Neither that platform nor preparatory fleet/control-plane work is
part of the current OpenBao/broker, project/agent setup or theme updates.

This direction does not block completion of the current local implementation.
Live identity configuration, custody/placement and the exact real-service pilot
still need their existing deployment decisions; this direction does not authorize
deployment, host changes or real credential enrollment. The alternatives below
are retained as investigation context, not additional deliverables.

Keycloak is the intended identity provider. Existing browser integrations must
remain compatible; they are separate from the new typed API broker proof.
No infrastructure change or production activation is authorized by this document.

## What the current contracts support

Each configured broker has its own state directory, TLS identities, OIDC issuer/
client/subject mapping, independent authority source public keys, KV mount/opaque
credential slots and restricted reader/enroller AppRoles. Each worker has an
explicit mTLS registration and private state. Separate instances per entity/client
therefore fit without sharing credentials or adding global-root authority.
Keycloak realm/client/issuer choices remain configuration decisions; no live realm,
client, account mapping or persistent credential has been created.

| Option | Fit and remaining work |
| --- | --- |
| One ProxyPilot plus broker/vault/worker deployment per entity | Fits the current single-backend/single-broker routing. Separates admin/state/custody only to the extent the chosen host and administrators are independent. Full platform features remain on each instance; fleet operations are separate. |
| Personal main dashboard plus client instances, with a limited control plane | Client instances can keep their own broker/vault/runner authority. A central view needs explicit instance registration, transport identities, bounded status/change contracts and per-entity authorization. That control plane is not implemented in this slice; it must not inherit host-root or secret-reveal authority. |
| One shared dashboard/broker across entities | Current ownership/grants support multiple people/projects, but there is no hard tenant boundary or tenant-specific administrative isolation claim. Do not equate an Operations project with a legal/client security boundary. Requires additional reviewed tenancy, routing, custody and isolation work. |

## Specific constraints to avoid future rework

- Dashboard environment configuration currently selects **one broker and one
  worker**. There is no central broker registry or fleet router. A future central
  UI must route through an authorized instance/entity binding, never an agent URL
  or caller-supplied vault path. Keep catalogue IDs local to that approved context.
- One broker identity configuration has one issuer/client and exact subject map.
  Per-entity Keycloak realms work with separate broker configurations. Federating
  several issuers through one broker would require an explicit identity contract
  extension; email or display-name matching is not an acceptable shortcut.
- Each authority record kind has exactly one independent source within a broker.
  Independent per-entity keys/sources fit separate instances. A shared multi-entity
  source requires reviewed partitioning and ceilings; dashboard-signed assertions
  alone cannot establish independence.
- Protected task records bind project/agent/user/configuration, registered worker,
  grant/connection, guide/check/environment revisions and explicit human start.
  Nothing in these records grants fleet administration or dashboard MCP run control.
- Recovery archives pin reviewed configuration/build and require fresh authority
  and exact policy revalidation. Do not restore a client archive into another
  instance as an implicit identity/policy migration.

A separate VM on the same root-equivalent host still trusts that host and
hypervisor. For protection from a compromised main backend, recommend a separate
privilege domain with independently administered source/signing custody. A limited
central control plane can preserve that boundary only if client instances enforce
local ceilings and human identity independently. S6/SEC-01 remains open.

This document records compatibility and gaps. It does not add fleet orchestration,
select shared tenancy, create infrastructure, authorize a real-service adapter or
change networking. Production root steps remain reviewed pastes the operator runs.
