import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertCurrent, fail } from "./store.js";
import { renderDomains } from "../route-render.js";

export async function configureRecoveryRoute(
  db,
  { fingerprint, render, fence },
) {
  const r = assertCurrent(db, fingerprint),
    c = r.config,
    domain = new URL(c.recoveryOrigin).hostname;
  const serviceId = "proxypilot-local-recovery",
    routeId = "proxypilot-local-recovery";
  const port = Number(process.env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw fail("Invalid ProxyPilot backend port.");
  const same = (name) =>
    name &&
    (name === domain ||
      (name.startsWith("*.") && domain.endsWith(name.slice(1))));
  if (
    db
      .prepare("SELECT id,domain FROM service_http_routes")
      .all()
      .some((x) => same(x.domain) && x.id !== routeId)
  )
    throw fail("Recovery hostname belongs to another route.");
  const old = db
    .prepare("SELECT * FROM service_http_routes WHERE id=?")
    .get(routeId);
  if (
    old &&
    (old.service_id !== serviceId ||
      old.path_prefix !== "/" ||
      !old.ssl_enabled ||
      !old.force_https)
  )
    throw fail("Recovery route ownership or HTTPS settings changed.");
  if (old && old.domain !== domain)
    throw fail(
      "Keep the existing recovery hostname; changing it needs a separate operator migration.",
    );
  const service = db
    .prepare("SELECT * FROM services WHERE id=?")
    .get(serviceId);
  if (
    service &&
    (service.name !== serviceId || service.target_ip !== "127.0.0.1")
  )
    throw fail("Recovery service ownership changed.");
  const path = render.caddyFilePath(domain),
    root = dirname(dirname(path));
  const paths = [
    process.env.CADDY_CONFIG_FILE || join(root, "Caddyfile"),
  ].filter(existsSync);
  for (const dir of [dirname(path), join(root, "custom")])
    if (existsSync(dir))
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (!name.startsWith(".") && !existsSync(p + "/")) paths.push(p);
      }
  const pattern = new RegExp(
    `(^|[\\s,/:])(?:${domain.replaceAll(".", "\\.")}|\\*\\.${domain.slice(domain.indexOf(".") + 1).replaceAll(".", "\\.")})(?=[\\s,:/{]|$)`,
    "im",
  );
  for (const p of paths) {
    if (p === path && old) continue;
    if (p === path || pattern.test(readFileSync(p, "utf8")))
      throw fail(
        "Recovery hostname collides with unmanaged Caddy configuration.",
      );
  }
  fence();
  if (!service)
    db.prepare(
      "INSERT INTO services(id,name,kind,runtime,target_ip,type,status) VALUES (?,?,'container_service','docker','127.0.0.1','proxy','active')",
    ).run(serviceId, serviceId);
  fence();
  db.prepare(
    `INSERT INTO service_http_routes(id,service_id,domain,path_prefix,target_port,websocket_enabled,ssl_enabled,force_https,max_upload_size,strip_prefix,ip_allowlist_json)
 VALUES (?,?,?,'/',?,0,1,1,'1G',0,?) ON CONFLICT(id) DO UPDATE SET ip_allowlist_json=excluded.ip_allowlist_json,target_port=excluded.target_port`,
  ).run(routeId, serviceId, domain, port, JSON.stringify(c.recoveryNetworks));
  await renderDomains({ db, domains: [domain], ...render, fence });
  fence();
  assertCurrent(db, fingerprint);
  return {
    created: old ? [] : [domain],
    existing: old ? [domain] : [],
    rendered: [domain],
  };
}
