// Per-service scope resolver for the Backups feature.
//
// scope shape on the wire:
//   null                      → 'all' (legacy default; pack
//                                everything in the chosen tier)
//   '{"service_ids":[...]}'   → JSON-stringified.  The named
//                                services are the only ones
//                                whose file roots, docker
//                                volumes, and incus instances
//                                land in the artifact.  config-
//                                tier assets (DB, .env, cve-
//                                inbox) are always included
//                                regardless of scope; they're
//                                the dashboard's own state, not
//                                a per-service concern.
//
// resolveScope() reads service rows for the requested IDs and
// returns concrete name lists the packer collectors can filter
// against:
//
//   {
//     all: false,
//     service_names: ['svc-a', 'svc-b'],         ← match services/<name>
//     docker_container_names: ['nginx-svc-a'],   ← match docker volumes
//     incus_instance_names: ['pp-svc-b'],        ← match `incus list`
//   }
//
// Pure-ish — touches the DB but no S3 / fs.

import { getDb } from '../db.js';

// resolveScope(scopeJson) → concrete filter object the packers
// consume.  Falls through to { all: true } for null / empty / a
// scope spec that doesn't pick any service.  Belt-and-braces:
// callers should treat all=true as 'pack everything' even if the
// fields below are populated.
export function resolveScope(scopeJson) {
  if (!scopeJson || scopeJson === 'all') return { all: true };
  let parsed;
  try {
    parsed = typeof scopeJson === 'string' ? JSON.parse(scopeJson) : scopeJson;
  } catch {
    return { all: true };
  }
  const ids = Array.isArray(parsed?.service_ids) ? parsed.service_ids : [];
  if (ids.length === 0) return { all: true };

  // Build a parameter list with the right number of '?' placeholders.
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().prepare(
    `SELECT id, name, kind, runtime, lxc_container_name, container_name
     FROM services
     WHERE id IN (${placeholders})`
  ).all(...ids);

  const service_names = [];
  const docker_container_names = [];
  const incus_instance_names = [];
  for (const r of rows) {
    if (r.name) service_names.push(r.name);
    if (r.runtime === 'docker' && r.container_name) {
      docker_container_names.push(r.container_name);
    }
    if (r.runtime === 'lxc' && r.lxc_container_name) {
      incus_instance_names.push(r.lxc_container_name);
    }
  }
  return {
    all: false,
    service_ids: ids,
    service_names,
    docker_container_names,
    incus_instance_names,
  };
}

// listScopeOptions() → operator-facing service list with the
// fields the picker UI cares about.  Stable name + kind +
// runtime + the container/instance name so the multi-select can
// render a meaningful row.
export function listScopeOptions() {
  return getDb().prepare(`
    SELECT id, name, kind, runtime, lxc_container_name, container_name, status
    FROM services
    ORDER BY name ASC
  `).all().map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    runtime: r.runtime || null,
    lxc_container_name: r.lxc_container_name || null,
    container_name: r.container_name || null,
    status: r.status || null,
  }));
}
