# Deploying an app inside an LXC behind ProxyPilot

This doc is for an operator who's never deployed an app behind
ProxyPilot before. It covers the shape ProxyPilot expects, why it's
shaped that way, and how to verify each layer is working.

The example throughout uses an [XRay](https://github.com/xtls/xray-core)
deployment, but the architecture applies to any HTTP backend running
inside an Incus LXC.


## 1. Architecture

```
   ┌──────────────┐    HTTPS (443)     ┌──────────────────────┐
   │   Browser    │ ─────────────────▶ │   ProxyPilot host    │
   └──────────────┘                    │   ┌────────────────┐ │
                                       │   │ Caddy          │ │
                                       │   │ • TLS terminate│ │
                                       │   │ • ACME / certs │ │
                                       │   └───────┬────────┘ │
                                       │           │ plaintext│
                                       │           │ HTTP     │
                                       │   Incus bridge       │
                                       │      │               │
                                       │      ▼               │
                                       │  10.x.y.z:<port>     │
                                       │   ┌────────────────┐ │
                                       │   │  LXC container │ │
                                       │   │  app on 0.0.0.0│ │
                                       │   │  no nginx      │ │
                                       │   │  no certbot    │ │
                                       │   └────────────────┘ │
                                       └──────────────────────┘
```

Browser → host Caddy (terminates TLS) → Incus bridge IP → your app
listening on plaintext HTTP inside the container.


## 2. Why TLS terminates on the host

TLS lives in exactly one place — the host's Caddy. ProxyPilot is
opinionated about this for a few good reasons:

- **One certificate lifecycle.** Caddy on the host runs ACME against
  Let's Encrypt and renews. Nothing inside the LXC needs certbot, no
  deploy hooks, no per-container certificate state.
- **No port-80 fight.** Only one process on the host needs to bind 80
  for ACME HTTP-01 challenges. Inside the LXC the app can bind any
  port without coordinating with anything else.
- **No ACME automation inside the LXC.** No certbot timer, no
  acme-companion sidecar, nothing to break when the container is
  snapshotted or migrated.
- **TLS to the LXC buys nothing here.** The host-to-LXC hop is a
  single interface on the same physical machine — there is no third
  party on the wire and no untrusted network in between. Re-encrypting
  that hop adds latency, certificate management, and another failure
  mode for zero security gain in this shape.

If you have a deployment where the host-to-LXC hop is not local
(remote LXC, mTLS audit requirement, etc.), this design is not for
you. For everything else, this is one less thing to manage.


## 3. What the LXC's app must do

Three rules. All three matter.

1. **Bind on `0.0.0.0:<port>`.** Not `127.0.0.1:<port>`. Caddy on the
   host reaches the app over the Incus bridge interface — anything
   bound to loopback inside the container is unreachable from the
   host. ProxyPilot's reachability badge will flag this; see §8.

   Docker compose: `ports: ["3000:3000"]`, **not**
   `["127.0.0.1:3000:3000"]`.

2. **Speak plaintext HTTP.** Caddy talks to the upstream as
   `reverse_proxy <ip>:<port>` over plain HTTP. Don't run TLS inside
   the container.

3. **Don't run an inner reverse proxy.** No nginx. No Caddy. No
   Apache. No Traefik. Your app talks to its socket directly, and
   ProxyPilot's Caddy talks to your app directly. Two reverse proxies
   in series buys you nothing and obscures every error to two layers
   deep — which is exactly the problem this PR makes easier to debug
   (see §8 row 1).


## 4. The matching ProxyPilot service entry

In ProxyPilot, open the LXC's detail panel and scroll to the
**Services** section.

| Field        | Example                       | Notes                                                                                          |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Domain       | `app.example.com`             | The hostname the user will hit. DNS must resolve to your host's public IP.                     |
| Port         | `3000`                        | The plaintext HTTP port your app listens on inside the container.                              |
| SSL (Shield) | on                            | Let Caddy provision an ACME cert. Only turn off when you're testing on a domain without DNS.   |
| Health path  | `/healthz` *(optional)*       | Empty: TCP-only check. Set: HEAD request layered on top — see §8 row 1 for what this catches.  |

You can equivalently configure the same domain in the standalone
**Service Settings** dialog — but pick one or the other. Adding the
same domain in both surfaces returns 409 in either direction; the
two surfaces own the Caddy site file mutually exclusively. (The
guard message tells you where to edit it.)


## 5. How to verify

Three checks, in order. If one fails, fix that layer before moving on.

**Layer 1 — the upstream is reachable from the host.**

Hover the badge next to the service. Green "OK" means Caddy can open
a TCP connection to your app's port over the bridge. Red "502" means
it can't.

Equivalent shell check from the ProxyPilot host:

```sh
curl -fsS http://10.64.250.163:3000/   # use the IP shown in the LXC panel
```

If this fails the proxy will too. Fix this before looking at TLS.

**Layer 2 — the app is actually listening on a reachable interface.**

Open the LXC's **Terminal** tab and run:

```sh
ss -tlnp | grep :3000
```

You want to see `0.0.0.0:3000` or `*:3000` or your bridge IP. If you
see only `127.0.0.1:3000`, see §3 rule 1.

If the LXC image is minimal and `ss` isn't installed, ProxyPilot
introspects this for you via `/proc/net/tcp` (commit
`e679fca`) — the diagnostic line under a 502 badge tells you exactly
which ports are listening and on which interface.

**Layer 3 — the app responds to HTTP correctly.**

Set the **Health path** field on the service to a real endpoint
(`/healthz`, `/`, anything that returns 2xx for a healthy app). The
badge flips amber "TCP" if the listener accepts but the application
returns errors. Hover for the status code.


## 6. Snapshot strategy

LXC snapshots capture the container's full filesystem, which means
**Docker volumes mounted inside the LXC are captured as part of the
snapshot.** That sounds great until you remember databases.

The right pattern is layered:

1. **Application-layer backups, taken by the app's own tool.**
   `pg_dump`, `mongodump`, `mysqldump`, your S3 sync job, whatever.
   Cron these from inside the container or trigger them from the
   host. These are the only point-in-time consistent backups your
   database has.
2. **LXC snapshots underneath, on top of the app-layer backups.**
   The snapshot captures everything — the DB at whatever moment it
   was crash-consistent, the app, configs, the most recent
   pg_dump. Use these for fast full-stack rollback.

If you only take LXC snapshots, you can roll the whole container
back but a database that was mid-transaction at snapshot time may
not come up cleanly. If you only take pg_dumps you have your data
but lose the rest of the system. Do both.


## 7. Migrating from "nginx + certbot in LXC"

The pre-ProxyPilot pattern is to run nginx (or Caddy, or Apache, or
Traefik) inside the container, terminate TLS there, and proxy_pass
to the actual app on localhost. This works but pays for it with two
TLS certificates per service, two log streams to debug, and a
double reverse proxy that hides every error one extra hop deep.

To migrate:

1. **Stop and disable the inner reverse proxy.**
   ```sh
   systemctl disable --now nginx
   ```
2. **Free port 443 in the LXC.** Nothing inside the container needs
   to bind 443; ProxyPilot's host Caddy owns that port for the host
   IP, and the LXC traffic is plaintext on whatever upstream port
   the app uses. Confirm with `ss -tlnp | grep :443`.
3. **Rebind the backend to `0.0.0.0:<port>`.** If your app was bound
   to `127.0.0.1:<port>` because nginx was localhost-fronting it,
   change that now. Restart the app and re-check with `ss`.
4. **Add the ProxyPilot service entry** (§4). Caddy reload happens
   automatically on save and any error is surfaced as a warning toast
   (commit `f689b61`).
5. **Stop and remove certbot.** No more renewal hooks. The cert
   lives on the host now.

XRay's `install.sh` emits a refuse-message when it detects this
pattern (XRay prompt T.3) — if you hit that message, this section is
the migration path.


## 8. Troubleshooting matrix

One row per symptom. The diagnostics under the badge come from this
PR chain — when you see one, the corresponding row is the fix.

| Symptom                                                              | What's actually happening                                                                                                                                                                          | Fix                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser shows 502 but the badge says **OK**                          | TCP layer is up — Caddy opened a connection — but the application returned a 5xx, or there's an inner reverse proxy returning errors. The TCP probe (commit `d519580`) can't see this.             | Set **Health path** on the service. The badge flips to amber "TCP" with the actual HTTP status when the app is replying with errors. If the inner-RP situation is the cause, see §3 rule 3 and §7.            |
| Browser shows 502, badge says **502**, diagnostic mentions *"Listening on a reachable interface inside the container"* | TCP refused. The container is listening on a non-loopback interface but on a different port than the service is configured for. (Commits `589568e`, `e679fca`.)                                  | Edit the service entry, change the port to one of the listed ports, ✓ to save.                                                                                                                                 |
| Badge says **502**, diagnostic mentions *"Bound to 127.0.0.1 only"*  | App is up but bound to loopback inside the container; Caddy on the host can't reach loopback inside an LXC.                                                                                       | Rebind the app to `0.0.0.0:<port>`. Docker: `ports: ["3000:3000"]`, not `["127.0.0.1:3000:3000"]`. (§3 rule 1.)                                                                                                |
| Badge briefly amber **stale IP** after restart                       | The LXC restarted and got a new bridge IP from the Incus DHCP server. The Caddy site file still references the old IP. (Commit `c06ffb4` is the bridge-picking that ensures the *new* IP is right.) | Edit the service entry and click ✓ to regenerate. The new IP is picked up on save.                                                                                                                             |
| Adding domain in LXC services list returns 409 *"already managed in the Service Settings dialog"* | Same domain is already configured in the standalone Service Settings surface; both surfaces would write the same Caddy site file and the second writer would silently clobber the first.        | Either edit the existing entry in Service Settings, or remove it there and add it in the LXC inline list. Pick one surface per domain.                                                                       |
| Adding domain in Service Settings returns 409 *"managed in the LXC's inline Services list"* | Inverse of the row above — Service Settings detected an LXC-managed Caddy file (its `reverse_proxy` upstream is a live LXC IP).                                                                  | Remove or edit the entry from the LXC's inline list, or add this domain there instead.                                                                                                                         |
| Container Terminal disconnects during a long install                 | Long-idle WebSocket dropped by an intermediate proxy. Out of scope here, but worth knowing — the heartbeat in commit `47704b8` covers most cases.                                                | Reconnect; the terminal session is preserved. Heartbeat sends ping/pong every 30s so most idle-timeout proxies keep the connection alive.                                                                      |


## See also

- `admin/backend/src/routes/lxc.js` — `/containers/:name/services`
  endpoints, `probeTcp` / `probeHttp` / `listListeningPorts` helpers.
- `admin/backend/src/routes/services.js` — standalone Service Settings
  dialog backend, `ensureCaddyStructure`, and the LXC-managed-file
  conflict guard.
- `admin/frontend/src/pages/LxcContainers.jsx` — inline services list
  UI, badges, and inline diagnostic rendering.
