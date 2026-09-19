import { P, tool, mutating, destructive } from './shared.js';

export const EDGE_TOOLS = [
  destructive('delete_route', 'Delete one route (domain + path_prefix). The domain\'s site file is re-rendered from what remains, or removed when it was the last route. Rolls back on any Caddy failure. Needs a confirmation_token.',
    { domain: P.domain, path_prefix: P.path_prefix }, ['domain']),
  mutating('set_route_path', 'Bind a SUB-PATH of a domain (e.g. /api) to a container (preferred) or ip:port — the fan-out route set_route (root only) cannot create. TLS stance is inherited from the root route. An existing binding needs confirm_overwrite.',
    { domain: P.domain, path_prefix: { type: 'string', description: 'Sub-path like /api (not /).' }, upstream_container: { type: 'string' }, upstream_ip: { type: 'string' }, upstream_port: { type: 'number' }, strip_prefix: { type: 'boolean', description: 'Strip the prefix before proxying (handle_path).' }, websocket: { type: 'boolean', description: 'Default true.' }, tls: { type: 'boolean' }, confirm_overwrite: { type: 'boolean' } }, ['domain', 'path_prefix', 'upstream_port', 'confirm']),
  mutating('set_route_options', 'Per-route edge options on an existing route: websocket, strip_prefix, read/write timeouts, max_body_bytes, host_header_override, allow_framing + frame_ancestors, health_path, tls (shared per domain), plus headers { name: value|null }, csp, basic_auth [{ username, password }] (bcrypt-hashed at rest), ip_allowlist [cidr…] and rate_limit { events, window, key: ip|path } (needs the caddy-ratelimit module). Rendered into the site file; rolled back on any Caddy failure.',
    { domain: P.domain, path_prefix: P.path_prefix, options: { type: 'object', description: 'The options to set; a null value removes an option.' } }, ['domain', 'options', 'confirm']),
  tool('list_certs', 'Every certificate ProxyPilot serves: manual (pasted) certs with expiry, ACME on-disk state per TLS-enabled domain, provisioned DNS-01 domains, and which are expiring.', {}),
  tool('get_cert', 'One certificate: by manual cert id, or the ACME certificate serving a domain (issuer directory, expiry, TLS policy). Key material is never returned.', { id: { type: 'number' }, domain: P.domain }),
  mutating('renew_cert', 'Force ACME re-issuance for a domain by moving its on-disk certificate aside (kept as a backup) and reloading Caddy. Rate-limited by the issuer — use only when the current certificate is actually wrong.', { domain: P.domain }, ['domain', 'confirm']),
  mutating('upload_cert', 'Store a manual certificate (PEM cert + private key, optional chain / passphrase), materialize it for Caddy and apply it to every host it covers. Key material is encrypted at rest and never echoed.',
    { label: { type: 'string' }, certificate: { type: 'string', description: 'PEM.' }, private_key: { type: 'string', description: 'PEM.' }, chain: { type: 'string' }, passphrase: { type: 'string' } }, ['label', 'certificate', 'private_key', 'confirm']),
  mutating('set_dns_challenge', 'DNS-01 issuance settings: store (or clear with null) the global Cloudflare API token, and/or the list of domains issued via DNS-01 (wildcards as *.example.com). Reports whether Caddy carries the Cloudflare DNS plugin.',
    { cloudflare_token: { type: ['string', 'null'] }, dns01_domains: { type: 'array', items: { type: 'string' } } }, ['confirm']),
  tool('get_route_access_log', 'A domain\'s Caddy access log: request/5xx counts for the window plus the newest entries (filter by status_min / path).',
    { domain: P.domain, window_seconds: { type: 'number' }, tail_bytes: { type: 'number' }, entries: { type: 'number' }, status_min: { type: 'number' }, path: { type: 'string' } }, ['domain']),
  tool('list_dns_records', 'DNS records of a Cloudflare zone (the zone is found from any hostname inside it) through the stored DNS-01 token. Filter by type / name.', { zone: { type: 'string' }, domain: P.domain, type: { type: 'string' }, name: { type: 'string' } }),
  mutating('set_dns_record', 'Create, update, upsert (default) or delete a Cloudflare DNS record: type, name, content, ttl (1 = auto), proxied. Returns the previous value for reversal.',
    { name: { type: 'string', description: 'Fully qualified record name.' }, type: { type: 'string', enum: ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA'] }, content: { type: 'string' }, ttl: { type: 'number' }, proxied: { type: 'boolean' }, action: { type: 'string', enum: ['add', 'update', 'upsert', 'delete'] } }, ['name', 'confirm']),
];

export const STATIC_ADMIN_TOOLS = [
  destructive('delete_static_site', 'Delete a static site: the docroot is archived as a release first, the service row and its routes are removed and every affected domain re-rendered. The docroot stays on disk unless remove_files: true. Needs a confirmation_token.',
    { site_id: P.site_id, remove_files: { type: 'boolean' } }, ['site_id']),
  mutating('delete_static_site_file', 'Delete a file or folder in a static site\'s docroot (files keep a copy as <name>.old unless keep_old: false; folders need recursive: true).',
    { site_id: P.site_id, path: { type: 'string', description: 'Docroot-relative path.' }, recursive: { type: 'boolean' }, keep_old: { type: 'boolean' } }, ['site_id', 'path', 'confirm']),
  tool('create_static_release', 'Capture the current docroot as a release (a full copy under /var/lib/proxypilot/static-releases) with an optional label.', { site_id: P.site_id, label: { type: 'string' }, dry_run: P.dry_run }, ['site_id']),
  tool('list_static_releases', 'Releases captured for a static site (newest first) with file counts and sizes.', { site_id: P.site_id }, ['site_id']),
  destructive('rollback_static_site', 'Replace a static site\'s docroot with a release. The current docroot is captured as another release first, so the rollback is reversible. Needs a confirmation_token.',
    { site_id: P.site_id, release: { type: 'string', description: 'Release id from list_static_releases.' } }, ['site_id', 'release']),
  mutating('set_static_site_aliases', 'Set the extra hostnames a static site answers on (root routes on the same service, same TLS stance). Adds missing aliases, removes extra ones; the primary domain is never touched.',
    { site_id: P.site_id, aliases: { type: 'array', items: { type: 'string' } } }, ['site_id', 'aliases', 'confirm']),
];
