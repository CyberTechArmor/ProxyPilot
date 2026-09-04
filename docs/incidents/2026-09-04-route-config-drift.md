# Route-config drift — investigation report (2026-09-04)

Status: **Implemented.** Stages 1–3 complete; the fix is on
`claude/proxypilot-route-config-drift-fcgurp` and has NOT been deployed to the
host. See §9 for what shipped and §10 for what is verified versus what still
needs a deployed environment.

One severity claim in §3.1a is corrected by §10 — `mail.techmations.com` turns
out not to be served by this edge at all, so the defect there destroyed a config
file and orphaned a row rather than taking down a mail server. Details in
`2026-09-04-verification-baseline.md`.

---

## 0. Access constraint — read this first

This investigation ran from an ephemeral dev container holding a fresh clone of the
repo. It is **not** the production host:

```
$ ls /etc/caddy   → No such file or directory
$ which caddy incus → (nothing)
```

So everything below is sourced from one of two places, and each claim says which:

- **Source** — the checked-out code, cited by `file:line`. Authoritative for mechanism.
- **Live** — the production ProxyPilot MCP endpoint (`list_routes`, `get_route`,
  `list_lxc_containers`). Authoritative for current state. Read-only.

What I **could not** reach from here, and therefore did not verify or do:
`/etc/caddy/sites/*` file contents and mtimes, `/var/log/caddy/*.log` history,
the `audit_log` table, `caddy validate`, and any host-side backup. Items that
depend on those are marked **UNVERIFIED** with the exact command to settle them.

---

## 1. Verdict on the working hypothesis

> *"The DB stores a container name and resolves its current IP at read time, so it is
> always correct; the Caddy site file stores a literal IP, frozen at the moment the
> route was last written, and goes stale silently."*

**Half right, and the wrong half matters.**

| Claim | Verdict |
|---|---|
| Caddy site files store a literal IP frozen at last write | ✅ **Confirmed** |
| Two stores, different lifetimes, nothing reconciles them | ✅ **Confirmed** |
| The DB resolves the container's IP at read time | ❌ **Refuted** |
| The DB is "always correct" | ❌ **Refuted** — it is a cache, and it can be wrong |

The database stores a **literal IP too**, in `services.target_ip`
(`admin/backend/src/db.js:396`). Nothing resolves it at read time.
`list_routes` / `get_route` read the stored column verbatim
(`admin/backend/src/routes/mcp.js:1923`, `1941`) — the `ip` field you saw in the
route record was a cached value, not a live lookup.

**Why this correction matters.** If the DB were live-resolving, the fix would be
"re-render Caddy from the DB." It is not. Both stores are caches of Incus state,
and the actual bug is that **one specific code path refreshes the DB cache and
re-renders only one of the domains that depend on it**. Re-rendering from the DB
is still necessary, but on its own it would have re-rendered `.22` — the stale
value — for `git.fractionate.ai` and fixed nothing.

---

## 2. The real failure mechanism

### Failure 1 — silent stale upstream (`git.fractionate.ai` → 502)

The culprit is `findOrCreateLxcService()`, `admin/backend/src/routes/lxc.js:1771-1795`:

```js
export function findOrCreateLxcService(db, name, ip) {
  const existing = db.prepare(
    `SELECT * FROM services WHERE lxc_container_name = ? AND is_admin = 0 LIMIT 1`
  ).get(name);
  if (existing) {
    if (ip && existing.target_ip !== ip) {
      db.prepare(
        `UPDATE services SET target_ip = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(ip, existing.id);          // ← DB cache moves forward
      existing.target_ip = ip;
    }
    return existing;                    // ← no Caddy re-render, for any domain
  }
  ...
}
```

There is **one `services` row per LXC**, and it owns **every** route on that
container. `mock2`'s row owns both `git.fractionate.ai` and `mock2.fractionate.ai`.

Its callers each re-render exactly one domain — the one being written:

| Caller | Site |
|---|---|
| LXC quick-add | `lxc.js:1968`, `2329`, `2372` |
| MCP `set_route` | `mcp.js:2262` → then `regenerateDomainCaddyConfig(db, domain)` at `mcp.js:2311` — **singular** |

So the sequence was:

1. `mock2` moved `10.185.17.22` → `10.185.17.224` on a DHCP lease renewal.
2. Someone wrote **one** route on `mock2` (quick-add, or `set_route` for
   `mock2.fractionate.ai`).
3. `findOrCreateLxcService` noticed the drift and updated `services.target_ip`
   to `.224` — for the whole service row.
4. Only the domain being written got re-rendered. `git.fractionate.ai`'s site
   file stayed frozen at `reverse_proxy 10.185.17.22:3000`.
5. `.22` was later reassigned to `unlimited-lighting`, which has nothing on 3000
   → 502.

This is not "Caddy went stale on its own." **An unrelated write to a sibling
domain actively advanced the DB and deliberately left the other domains behind.**
The blast radius is every *other* hostname on the same container.

### Failure 2 — non-atomic delete (both hostnames lost TLS)

Two independent bugs compose.

**(a) Routes are attributed to containers by IP substring.**
`admin/backend/src/routes/lxc.js:1651`, inside `GET /containers/:name/services`:

```js
const files = await readdir(CADDY_SITES_DIR);
for (const file of files) {
  const content = await readFile(filePath, 'utf-8');
  if (!content.includes(ip)) continue;   // ← attribution is a substring match
```

Two defects in one line:

1. **Attribution is by literal IP, not by name** — confirming the hypothesis
   drawn from the banner. Any site file containing the page's container IP is
   listed under that container.
2. **It is an unanchored substring match**, so it collides on prefixes:

   ```
   '10.185.17.224:3000'.includes('10.185.17.22')  →  true
   ```

   Verified. This means `git.fractionate.ai` and `mock2.fractionate.ai` appear on
   the `unlimited-lighting` page **whether their upstream is `.22` (stale) or
   `.224` (correct)**. The recovery did not clear this.

**(b) Entries found by the file scan are deleted file-only.**
Entries from the DB carry a `routeId`; file-scan entries do not
(`lxc.js:1660-1633` vs `1664-1676`). `DELETE /containers/:name/services/:domain`
branches on it (`lxc.js:2686`):

- with `routeId` → delete row + `regenerateDomainCaddyConfig` + reload ✅
- without → the "legacy fast-path" at `lxc.js:2734-2745`:

```js
const configPath = join(CADDY_SITES_DIR, domain);
await unlink(configPath);      // ← file gone. DB never touched.
```

And the two pipelines **write the same filename** — `caddyFileName()` only
rewrites wildcards (`services.js:253-259`), so both the merged renderer and the
legacy path use `/etc/caddy/sites/<domain>`. The "legacy" delete therefore unlinks
files that *are* backed by DB rows.

Composed: the operator opened `unlimited-lighting`, saw two hostnames that belong
to `mock2` (via the substring match), deleted them, and hit the file-only path.
Caddy lost the site blocks — hence no certificate to present and a failed TLS
handshake, not a 502 — while `service_http_routes` kept intact rows. `set_route`
re-rendered from those rows and both recovered. Exactly as observed.

---

## 3. Findings beyond the reported incident

Three more instances of the same class, none of which were part of the incident
report. The first is materially worse than what actually happened.

### 3.1 Container delete sweeps other tenants' site files — `lxc.js:3819-3830`

`DELETE /containers/:name` (sudo-gated) deletes the guest, then:

```js
const files = await readdir(CADDY_SITES_DIR);
for (const file of files) {
  const content = await readFile(filePath, 'utf-8');
  if (content.includes(containerIp)) {     // ← same unanchored substring match
    await unlink(filePath);
  }
}
```

No DB write anywhere. **On this host, today:** deleting `unlimited-lighting`
(`10.185.17.22`) would unlink `unlimited.lighting`, **plus** `git.fractionate.ai`
and `mock2.fractionate.ai` (both contain `10.185.17.224`, which contains
`10.185.17.22`), and leave all three DB rows orphaned. One sudo delete, three
hostnames down, two of them another project's.

### 3.1a The same collision is live on the mail server

Enumerating the 12 managed guest IPs for substring collisions returns **two**
pairs, not one:

```
'10.185.17.22'  (unlimited-lighting)  is a substring of  '10.185.17.224' (mock2)
'10.185.17.14'  (RustDesk)            is a substring of  '10.185.17.145' (mailcow)
```

The second pair was not part of the incident and is worse. `mail.techmations.com`
routes to `10.185.17.145` (mailcow); `rd.fractionate.ai` routes to `10.185.17.14`
(RustDesk). Therefore, **right now**:

- `mail.techmations.com` is listed on the **RustDesk** container page, deletable
  via the file-only path (§2 Failure 2b).
- Deleting the **RustDesk** container (§3.1) unlinks
  `/etc/caddy/sites/mail.techmations.com` and orphans its row.

Both are one operator action away, on the production mail server that this
engagement was explicitly told not to touch. Nothing warns; the page renders the
hostname as if it belonged there. This raises Step 1 from "fixes the reported
incident" to the immediate priority.

### 3.2 `transfer-routes` never re-renders Caddy — `lxc.js:3487-3680`

`POST /containers/:name/transfer-routes` updates `lxc_container_name` **and**
`target_ip` on every moved service row (`lxc.js:3568-3577`), reconciles L4
forwards — and never calls `regenerateDomainCaddyConfig` or reloads Caddy.
Grepping the whole handler for `regenerateDomain|caddy reload|caddyReload`
returns nothing. Its own comment at `lxc.js:3552-3556` says *"Caddy regen reads
target_ip from the row directly"* — but nothing invokes it. Every HTTP route on a
transferred service keeps pointing at the **old** container's IP indefinitely.

### 3.3 The 502 diagnostic probes the wrong host — `lxc.js:1694`

```js
svc.reachable = await probeTcp(ip, svc.port, 2000);   // ip = the page's container
svc.staleIp   = svc.upstreamIp && svc.upstreamIp !== ip;
```

The probe targets the container whose **page you are on**, while the address shown
in the banner is `svc.upstreamIp`, parsed from the Caddy file
(`LxcContainers.jsx:3060`). That is precisely the split that produced the reported
banner: the address `10.185.17.22:3000` came from `git.fractionate.ai`'s Caddy
file; the port inventory (`80, 5355 / 53, 8787`) came from scanning
`unlimited-lighting`. The banner was internally inconsistent and pointed the
operator at the wrong guest.

`staleIp` looks like drift detection but is not: it compares against the wrong
container, so on a misattributed entry it reports drift when there is none and
stays silent when there is.

---

## 4. Answers to the Stage 1 questions

**Q1 — Where is the upstream persisted, in what form?**

*Two stores, both literal IPv4, neither authoritative.*

- **DB**, `services` table (`db.js:378-401`):
  `target_ip TEXT` (line 396) — the literal IP, and `lxc_container_name TEXT`
  (line 397) — the guest name. Ports live per-route in
  `service_http_routes.target_port`. Both IP columns are caches of Incus state;
  no code resolves the name at read time.
- **Caddy**, one file per domain at `/etc/caddy/sites/<domain>`
  (`services.js:253-259`). Generated block, from `buildDomainCaddyConfig`
  (`services.js:6155-6455`) with the upstream emitted at `services.js:6056`:

```caddy
git.fractionate.ai {
    handle {
        reverse_proxy 10.185.17.224:3000 {
            flush_interval -1
            transport http {
                keepalive 30s
                keepalive_idle_conns 10
                read_timeout 86400s
                write_timeout 86400s
            }
        }
    }

    header {
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    log {
        output file /var/log/caddy/git.fractionate.ai.log
    }
}
```

*(Shape reconstructed from the generator; the live file is host-side —
**UNVERIFIED** in byte detail.)*

**Q2 — How is config generated? Enumerate every writer.**

Per-domain files, not one file. The main `Caddyfile` does
`import /etc/caddy/sites/*` (`services.js:147`) — an unfiltered glob, so both
naming conventions load. There is **no single render function**. Seven writers:

| # | Writer | Location | DB-derived? |
|---|---|---|---|
| 1 | `regenerateDomainCaddyConfig` | `services.js:6456` | ✅ yes — the good path, ~18 call sites |
| 2 | LXC quick-add legacy fast-path | `lxc.js:2288-2294` | ❌ hand-rolled template |
| 3 | LXC create-status writer | `lxc.js:1132-1134` | ❌ hand-rolled template |
| 4 | LXC service rename | `lxc.js:2649-2651` | ❌ hand-rolled template |
| 5 | `PUT /services/:id/caddy-config` | `services.js:2320` | ❌ raw operator-supplied text |
| 6 | CLI | `cli/src/caddy/client.js:75-126`, `reconcile.js:64` | ❌ separate pipeline |
| 7 | Domain provisioning | `domains.js:268` | ❌ ACME token snippets |

Writers 2–4 emit a single-line template
(`${domain} { reverse_proxy ${ip}:${port} ... }`) that bypasses the DB entirely.
Writer 5 lets an operator hand-write a site file that drifts on save. Mock2 is
clean — it owns a separate directory (`/etc/caddy/mock2`, `mock2/caddy.js:28`)
and never touches `sites/`.

**Q3 — What happens when a guest's IP changes?**

**Nothing automatic.** There is no hook, no timer, no lease-renewal event, and no
reconciliation loop for HTTP route config. The write path is only ever triggered
by an explicit user action. Three ways an IP change reaches config, all
operator-initiated:

- `POST /services/:id/refresh-ip` (`services.js:2388`) — re-queries Incus,
  updates `target_ip`, regenerates **every** domain the service touches
  (`services.js:2486-2545`). This one is correct and is the model the fix should
  generalize.
- `POST /services/caddy/regenerate-all` (`services.js:927`) — full render of every
  domain from the DB, with backup/validate/revert. Correct, and never called
  automatically.
- `findOrCreateLxcService` (`lxc.js:1771`) — updates the DB, re-renders only the
  domain being written. **This is the bug.**

At boot, `index.js:748-780` reconciles L4 forwards, cert mounts, VPN, and mock2
domains — but **never** the core services→Caddy render.

**Q4 — What backs the LXC page delete, and why did it remove the file but not the row?**

`DELETE /containers/:name/services/:domain` (`lxc.js:2686`). It is **not** the same
path as the route page's delete or `set_route`. It branches on a `?routeId=` query
param: present → DB delete + regenerate (`lxc.js:2698-2731`); absent → unlink only
(`lxc.js:2734-2745`). `routeId` is present only for entries the GET sourced from
the DB. Entries from the IP-substring file scan have none, so a routes-pipeline
file discovered by misattribution is deleted through the file-only branch — and
because both pipelines write the identical filename, that branch really does
delete a live, DB-backed site block. See §2 Failure 2.

**Q5 — How does the LXC page attribute routes to containers?**

**Both ways, and the IP way is the problem.** `lxc.js:1600-1618` pulls DB routes by
`WHERE s.lxc_container_name = ?` — correct, by name. Then `lxc.js:1646-1676`
scans every Caddy site file and attributes by `content.includes(ip)` — by literal
IP, unanchored. Anything the name query missed gets swept up by IP. Hypothesis
**confirmed**, and the unanchored match is an additional defect the banner
evidence could not have revealed.

**Q6 — Where does the port-scan diagnostic get its target address?**

From two different places, which is the defect.
`LxcContainers.jsx:3060`: `const target = \`${svc.upstreamIp || '?'}:${svc.port}\``
— for a file-scan entry, `svc.upstreamIp` is regex-parsed out of the **Caddy file**
(`lxc.js:1662`). The port inventory beside it (`containerListening.reachable` /
`.loopbackOnly`, `LxcContainers.jsx:3064-3065`) comes from
`GET /containers/:name/listening-ports` (`lxc.js:1521`) — scanning the **page's**
container. Address from one host, port list from another.

**Q7 — Does any DB↔Caddy drift detection exist?**

**No.** Nothing in the backend reads Caddy's admin API, which is enabled and
listening (`admin localhost:2019`, `services.js:144`). Grepping the route and lib
trees for drift logic returns only unrelated subsystems. Two near-misses:

- `l4-diagnose.js:318-321` does exactly the right thing for **L4 forwards** —
  compares cached `service.target_ip` against the live Incus IP and surfaces
  `"LXC's current IP doesn't match the forward's connect IP → click Reconcile"`
  (`l4-diagnose.js:224`). Never applied to HTTP routes. **This is the in-repo
  precedent the fix should follow.**
- `staleIp` (`lxc.js:1695`) — compares against the wrong container, per §3.3.

**Q8 — Was `mock2.fractionate.ai` also bound to `10.185.17.22`?**

**UNVERIFIED — and it cannot be settled from here.** Git history does not answer it
(these lines all trace to one squashed merge, `f7c171e`, 2026-07-30) and the
evidence is host-side. Both files were rewritten to `.224` during recovery, so
current state is silent on it.

Reasoning from the mechanism, the likely answer is **no**, and the reasoning is
worth stating because it is falsifiable: the drift is injected by a write that
re-renders exactly one domain. For the DB to have held `.224`, some write must
have gone through `findOrCreateLxcService` — and that write re-rendered *its own*
domain to `.224`. If that write was for `mock2.fractionate.ai`, then
`mock2.fractionate.ai` was correct and only `git.fractionate.ai` was stale, which
is exactly the observed symptom set (one 502, no other complaint). If the write
was for some third domain, both would have been stale — and `mock2.fractionate.ai`
would have been silently serving `unlimited-lighting`'s nginx on :80 with a valid
cert and a 200.

Three host-side commands settle it definitively. Worth running before anything is
overwritten:

```bash
# 1. When was each site file last written? (mtimes predate the recovery only if untouched)
stat -c '%y  %n' /etc/caddy/sites/git.fractionate.ai /etc/caddy/sites/mock2.fractionate.ai

# 2. Did unlimited-lighting's nginx ever serve requests for mock2.fractionate.ai?
#    (definitive proof of cross-tenant serving, if the vhost logs Host)
incus exec pp-unlimited-lighting -- grep -c 'mock2\.fractionate\.ai' /var/log/nginx/access.log

# 3. What did the audit log record, and when?
sqlite3 /opt/proxypilot/data/db/proxypilot.db \
  "SELECT created_at, action, details FROM audit_log
    WHERE details LIKE '%fractionate%' ORDER BY created_at DESC LIMIT 40;"
```

Command 2 is the one that matters for the containment question. If it returns
non-zero, this was a confirmed cross-tenant data-path breach, not a near miss.

---

## 5. Severity

The framing in the incident report is correct and I would go further.

The 502 was **luck**. `unlimited-lighting` happened to have nothing on 3000. Had it
been listening, `git.fractionate.ai` would have served another project's app over a
valid Let's Encrypt certificate for `git.fractionate.ai`, returning 200, with no
error raised anywhere — no 5xx in the access log, no failed probe, no banner.
Nothing in the system today would detect that state. `list_routes` would report
the route as healthy, because it reads the DB cache that says `.224`.

Two things make this a containment failure rather than an availability bug:

1. **A recycled DHCP lease silently cross-wires one project's hostname into
   another project's guest**, and the only reason anyone noticed was that the
   recipient guest had a closed port.
2. **§3.1 makes it reachable by a single operator action**: one sudo container
   delete unlinks other projects' site files by prefix collision — and §3.1a shows
   the collision is live on `mail.techmations.com` today, not merely possible.

For HIPAA/SOC 2 evidence purposes, there is currently no artifact showing the
running edge matches declared intent. Design target #4 (drift check) is therefore
not just a bug guard — it is the missing control.

---

## 6. Proposed fix

Ordered by leverage, each step independently verifiable and independently
revertible. Steps 1–3 stop the bleeding without touching the data model.

### Step 1 — Attribute by name; make IP matching exact (fixes Failure 2's cause)

*Revert: single commit, no data change.*

`lxc.js:1651` — the file scan is the only thing that can misfile a hostname.
Restrict it to files that are genuinely unmanaged, and make any IP comparison
exact rather than substring:

```diff
-        if (!content.includes(ip)) continue;
+        // Attribution is by NAME. A file whose domain has a row in
+        // service_http_routes belongs to that row's container, full stop —
+        // never to whoever currently holds the IP the file happens to name.
+        const fileDomain = parseSiteAddress(content);
+        if (!fileDomain) continue;
+        if (managedDomains.has(fileDomain)) continue;   // DB owns it; not ours to list
+        const upstream = parseUpstreamIp(content);      // exact match, not includes()
+        if (upstream !== ip) continue;
```

where `managedDomains` is one query for **all** `service_http_routes.domain`
values (not just this container's). Add a `conflict` field to any entry whose
Caddy upstream disagrees with its owning row, so a stale binding renders as a
visible conflict — *"record says mock2 (10.185.17.224), Caddy says 10.185.17.22 =
unlimited-lighting"* — instead of being filed under the wrong container
(design target #5).

Same exact-match fix at `lxc.js:3826` (container delete sweep, §3.1), plus a
guard that refuses to unlink any file whose domain has a live DB row.

*Verify:* `unlimited-lighting`'s page lists only `unlimited.lighting`;
`git.fractionate.ai` and `mock2.fractionate.ai` appear only under `mock2`. Unit
test the prefix collision (`.22` vs `.224`) directly.

### Step 2 — Make every mutation re-render every affected domain (fixes Failure 1)

*Revert: single commit, no data change.*

Introduce one function, and route all upstream mutations through it:

```js
// admin/backend/src/lib/route-render.js
export async function applyServiceUpstream(db, serviceId, { ip }) {
  // 1. update services.target_ip
  // 2. SELECT DISTINCT domain FROM service_http_routes WHERE service_id = ?
  // 3. regenerateDomainCaddyConfig for EVERY one of them
  // 4. caddyAdapt() → validate
  // 5. caddyReload() — or restore backups and throw, loudly
}
```

This is exactly what `refresh-ip` already does correctly
(`services.js:2486-2545`); the change is to generalize it and make it the only
way to move an IP. Then:

- `findOrCreateLxcService` (`lxc.js:1771`) stops writing `target_ip` as a side
  effect — it either re-renders all affected domains or returns the drift to the
  caller.
- `transfer-routes` (`lxc.js:3568`) calls it (fixes §3.2).
- `set_route` (`mcp.js:2262`) calls it.

*Verify:* the deliberate reproduction below — move a scratch guest's IP, touch one
of its two routes, confirm **both** site files move.

### Step 3 — One delete path, atomic across both stores (fixes Failure 2's blast)

*Revert: single commit, no data change.*

Delete the legacy fast-path at `lxc.js:2734-2745`. Resolve the domain to its DB
row server-side rather than trusting the client's `routeId`; when a row exists,
always take the DB-delete + regenerate path. Only a file with **no** DB row may be
unlinked, and that case gets an explicit "unmanaged file" confirmation. Same
treatment for writers 2–4 (`lxc.js:1134`, `2294`, `2651`) — retire the hand-rolled
templates in favour of `regenerateDomainCaddyConfig`, so Caddy config becomes a
pure function of the route table (design target #1) and drift stops being a
reachable state.

*Verify:* delete a scratch route, confirm both stores agree with no orphan in
either direction.

### Step 4 — Drift check against Caddy's running config (design target #4)

*Revert: additive; the endpoint can be ignored.*

New `lib/route-drift.js`: fetch `GET http://localhost:2019/config/` (already
enabled, `services.js:144`), render a fresh config from the DB, and diff upstream
bindings per `(domain, path_prefix)`. Report per-domain: `match` / `drift` /
`missing-in-caddy` / `unmanaged-in-caddy`. Surface at
`GET /api/services/route-drift`, render on the dashboard, and run it at boot —
**reporting only, never auto-overwriting**, matching the architecture decision the
cert-mount reconciler already states (`index.js:764-768`: drift is surfaced, not
silently overwritten, because operator edits beat ProxyPilot intent at boot).
Auto-repair stays an explicit one-click action.

This also catches manual host-side edits and is the GRC artifact that the running
edge matches declared intent.

### Step 5 — Alarm on cross-tenant bindings (design target #6)

*Revert: additive.*

In the same pass: for every route whose upstream IP resolves to a **different**
managed guest than the route names, emit a high-severity notification through the
existing `notification-dispatch` channel. This condition is never benign, and it
is the specific alarm that would have caught the incident silently — including the
200-with-wrong-tenant case that raises nothing today.

### Step 6 — Stop depending on DHCP (design target #2)

*Revert: config-only; static reservations are removable.*

The above makes drift **detected and self-healing**; step 6 makes it **impossible**.
Sequenced last because it touches guest networking and needs its own change window:

1. Static reservations for every managed guest on the Incus bridge
   (`set_lxc_network` already exists — `set_route`'s own hint at `mcp.js:2333`
   recommends this today).
2. Refuse to create a route against a guest with no reservation.
3. Only then evaluate `dynamic a` upstreams backed by Incus DNS. Note this
   changes Caddy dial-time behaviour host-wide and is the one step I would not
   bundle with anything else.

---

## 7. Verification plan

To run **after** approval, before and after each step:

1. **Route inventory diff.** `list_routes` + `test_route` against all 14
   hostnames; record status codes before and after each step and diff.
   Baseline captured 2026-09-04, saved alongside this report.
2. **Deliberate reproduction.** Create a scratch guest with two hostnames on it,
   change its IP, touch one route, confirm the other follows without manual
   intervention. This must **fail** before step 2 and **pass** after.
3. **Delete atomicity.** Delete a scratch route; confirm `list_routes` and the
   site file agree, with no orphan in either direction.
4. **Drift check honesty.** Clean against a good state; then inject a bad state
   by hand-editing one scratch site file and confirm it names that specific
   difference.
5. **Scratch hostname end-to-end.** Full create → serve → delete on a throwaway
   hostname before any live route is touched.

`mail.techmations.com` and `unlimited.lighting` are excluded from every test.
No step goes near ACME or existing certificates.

---

## 8. Backup and restore

**To be run on the host before the first change** (I could not run these from the
dev container — see §0):

```bash
# Backup
sudo tar czf /var/lib/proxypilot/backups/caddy-config-$(date +%Y%m%d-%H%M%S).tar.gz \
  -C /etc caddy
sudo sqlite3 /opt/proxypilot/data/db/proxypilot.db \
  ".backup '/var/lib/proxypilot/backups/proxypilot-$(date +%Y%m%d-%H%M%S).db'"

# Restore — Caddy config
sudo tar xzf /var/lib/proxypilot/backups/caddy-config-<STAMP>.tar.gz -C /etc
sudo caddy validate --config /etc/caddy/Caddyfile \
  && sudo caddy reload --config /etc/caddy/Caddyfile --force

# Restore — route table (stop the backend first)
sudo systemctl stop proxypilot-admin
sudo cp /var/lib/proxypilot/backups/proxypilot-<STAMP>.db \
        /opt/proxypilot/data/db/proxypilot.db
sudo systemctl start proxypilot-admin
```

Every generated config passes `caddy validate` before going live; reload only,
never restart. No step in §6 requires a Caddy or guest restart — if that changes
during implementation, I will stop and ask first.


---

## 9. What shipped

Two commits on `claude/proxypilot-route-config-drift-fcgurp`.

**Step 1 — attribution by name; exact-match addresses.**
New `lib/caddy-site-file.js` parses generated site files properly (every
upstream, not just the first) and compares addresses exactly. Both attribution
sites now ask the database who owns a domain:
- `lxc.js` GET `/containers/:name/services` lists a file-scan entry only when no
  route row anywhere claims its domain, then only on an exact upstream match.
- `lxc.js` DELETE `/containers/:name` deletes the rows it owns and re-renders,
  instead of unlinking every file containing its address as a substring.
- The 502 diagnostic probes the address the edge actually dials, and no longer
  pairs an address from one guest with a port scan of another.

**Step 2 — an address change re-renders every domain that depends on it.**
New `lib/route-render.js`. `applyServiceUpstream()` moves `services.target_ip`
and re-renders every domain on that service, validating before reload and
restoring both stores on any failure. `findOrCreateLxcService` no longer writes
`target_ip` as a side effect. Wired into LXC quick-add, container create, the
MEET preset, MCP `set_route`, and `transfer-routes` (which never re-rendered at
all).

**Step 3 — one delete path, one writer.**
DELETE `/containers/:name/services/:domain` resolves ownership from the
database rather than from the presence of `?routeId`. Rows owned by this
container are deleted and re-rendered; rows owned by another container are
refused with the real owner named; a file with no rows is unlinked only on an
exact upstream match. All four hand-rolled Caddy templates are gone — every
write goes through `regenerateDomainCaddyConfig`. This needed migration 106
(`service_http_routes.health_path`), because the operator's health path
previously existed only as a marker comment in the hand-written files and the
merged renderer had no way to represent it.

**Steps 4 + 5 — drift detection and the cross-tenant alarm.**
New `lib/route-drift.js` compares the route table against the on-disk site
files and against Caddy's running config from `GET /config/` on the admin API.
Reports `match` / `drift` / `missing_in_caddy` / `unmanaged_in_caddy`, and
raises an error-level finding for any route whose upstream resolves to a
different managed guest than the route names. Reporting only, never repair,
matching the cert-mount reconciler's stated position. Surfaced at
`GET /api/services/route-drift`, in a boot sweep that logs and notifies, and in
a Dashboard banner that keeps cross-tenant findings visually separate from
ordinary staleness.

**Step 6 — reservation awareness, warn-only.**
The drift report marks routes whose guest has no static address reservation
(`expanded_devices.eth0["ipv4.address"]`), and the banner names those
containers. Deliberately does not affect `clean`, does not notify, and does not
refuse route creation: an unreserved guest is a standing risk, not an event, and
a permanently-red dashboard trains people to ignore it. No dial-time or guest
networking change was made — `dynamic a` upstreams remain unimplemented, as
planned.

---

## 10. Verification status — what is proven and what is not

**Proven here.**
- 56 new unit tests, all passing. They cover the prefix collision directly
  (`'10.185.17.224:3000'.includes('10.185.17.22') === true` is the bug; the
  replacement returns false), a regression test asserting that moving an address
  re-renders *every* domain on the service, rollback of both stores on render /
  validate / reload failure, the incident state reported with both addresses and
  the tenant it leaked to, the silent 200-with-wrong-tenant case, and the
  prefix-collision pair NOT raising a false alarm.
- Backend suite unchanged from `main`: the same 7 failures before and after —
  the 6 documented in CLAUDE.md as missing native deps, plus one subtest from
  `mock2-ui-checks.test.js`, already recorded in `docs/known-issues.md` as
  flaking under full-suite parallelism. Confirmed by running the suite on a
  stashed tree: byte-identical failure set with and without this branch.
- Frontend builds clean with the new banner.
- Live route baseline captured for before/after diffing
  (`2026-09-04-verification-baseline.md`), including three pre-existing
  conditions that would otherwise be misread as regressions.

**NOT verified — needs a deployed environment.**
This work was done in an ephemeral container with no access to the host
(§0). The following items from the plan's verification list require the code to
be running on the edge, and none of them have been performed:

1. Re-probing all 14 routes after deployment and diffing against the baseline.
2. Deliberately moving a scratch guest's address and confirming the route
   follows with no manual step. This is the headline claim of Step 2; the unit
   test proves the logic, not the integration.
3. Deleting a scratch route and confirming both stores agree afterwards.
4. Confirming the drift check reports clean against a good state and names the
   specific difference against an injected bad one.
5. An end-to-end create → serve → delete on a scratch hostname.
6. `caddy validate` against real generated output. The code calls `caddyAdapt()`
   before every reload and restores on failure, but that path has not been
   exercised against a real Caddy binary.

Item 2 is the one I would not skip. Suggested sequence on the host, after
taking the backups in §8: deploy, run the drift check (`GET
/api/services/route-drift`) and confirm it is clean apart from the known
`starter.fractionate.ai` app-down case, then create a scratch hostname against a
throwaway guest, move that guest's address with `set_lxc_network`, touch a
second route on the same guest, and confirm the scratch hostname follows.

**Also unresolved:** Q8 (§4) — whether `mock2.fractionate.ai` was serving
`unlimited-lighting`'s nginx before the incident. The three host-side commands
that settle it are in §4. The nginx access-log grep is the one that matters:
non-zero means a confirmed cross-tenant data path, not a near miss.
