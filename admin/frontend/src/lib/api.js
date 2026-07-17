import { requestSudo } from './sudo.js';

const API_BASE = '/api';

class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    // Pass through any additional fields from the response
    Object.assign(this, data);
  }
}

// Read a cookie value from document.cookie. Used for the pp_csrf
// cookie which is intentionally not HttpOnly so JS can echo it.
function readCookie(name) {
  const match = document.cookie.match(
    new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)')
  );
  return match ? decodeURIComponent(match[1]) : null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function request(endpoint, options = {}, _retryOnSudo = true) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // Echo the CSRF cookie back as a header on state-changing requests.
  // Backend's CSRF middleware compares the two — same value means the
  // request came from JS that can read same-origin cookies (i.e. our
  // own frontend). GETs are exempt.
  if (!SAFE_METHODS.has(method)) {
    const csrf = readCookie('pp_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    // Send the httpOnly pp_token cookie on every request — this is
    // how the browser carries the session post-B4. Required for
    // same-origin to pick up cookies.
    credentials: 'include',
  });

  // Defensive parse: an empty body or non-JSON body would throw
  // 'Unexpected end of JSON input' which is unhelpful to the
  // operator.  Surface the actual HTTP status text + raw body
  // snippet instead so the toast says something actionable.
  let data;
  try {
    const text = await response.text();
    data = text.length === 0 ? {} : JSON.parse(text);
  } catch (parseErr) {
    if (response.ok) {
      // Successful status with non-JSON body (e.g. plain text
      // health endpoint).  Treat as empty payload.
      data = {};
    } else {
      throw new ApiError(
        `${response.status} ${response.statusText || 'error'} (no JSON body)`,
        response.status,
      );
    }
  }

  if (response.status === 401) {
    // Sudo gate: backend wants password+TOTP re-auth before letting
    // this destructive request through. Trigger the global modal,
    // wait for the user to clear sudo, then retry the original call
    // exactly once. Only retry if we're not already inside a retry.
    if (data.sudo_required && _retryOnSudo) {
      try {
        await requestSudo();
      } catch {
        throw new ApiError('Sudo cancelled', 401, data);
      }
      return request(endpoint, options, false);
    }
    // Don't redirect if this is a login/setup attempt with special flow flags
    if (data.totpRequired || data.totpSetupRequired || data.setupRequired) {
      throw new ApiError(data.error || 'Authentication step required', 401, data);
    }
    // Don't redirect if already on login page (prevents "Session expired" on bad credentials)
    if (window.location.pathname === '/login') {
      throw new ApiError(data.error || 'Invalid credentials', 401, data);
    }
    // Cookie was rejected/expired — clear cached user metadata and
    // bounce to login. The backend's logout endpoint clears the
    // httpOnly cookies; a 401 here means it's already gone.
    localStorage.removeItem('user');
    window.location.href = '/login';
    throw new ApiError('Session expired', 401);
  }

  if (!response.ok) {
    throw new ApiError(data.error || 'Request failed', response.status, data);
  }

  return data;
}

export const api = {
  // Auth
  login: (credentials) => request('/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
  }),

  getSetupStatus: () => request('/auth/setup-status'),

  initialSetup: (data) => request('/auth/initial-setup', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  completeTotpSetup: (data) => request('/auth/complete-totp-setup', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  verify: () => request('/auth/verify'),

  logout: () => request('/auth/logout', { method: 'POST' }),

  // Sudo re-auth (K.2). Always passes _retryOnSudo=false so that a
  // failed sudo (bad password / bad TOTP) doesn't recursively prompt
  // the user back into the same modal — the modal handles the error
  // inline.
  sudo: ({ password, totpCode }) =>
    request('/auth/sudo', {
      method: 'POST',
      body: JSON.stringify({ password, totpCode }),
    }, false),

  // Passkey (WebAuthn). The server-issued options come back from /begin
  // and are passed verbatim to startRegistration / startAuthentication
  // by lib/passkey.js — this layer is just transport.
  passkeyRegisterBegin: ({ totpCode } = {}) => request('/auth/passkey/register/begin', {
    method: 'POST',
    body: JSON.stringify({ totpCode }),
  }),

  passkeyRegisterVerify: ({ response, label }) => request('/auth/passkey/register/verify', {
    method: 'POST',
    body: JSON.stringify({ response, label }),
  }),

  passkeyAuthBegin: ({ username } = {}) => request('/auth/passkey/authenticate/begin', {
    method: 'POST',
    body: JSON.stringify({ username }),
  }),

  passkeyAuthVerify: ({ challengeId, response, registerDevice }) => request('/auth/passkey/authenticate/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, response, registerDevice }),
  }),

  // Sudo via passkey. Always passes _retryOnSudo=false for the same
  // reason as the password+TOTP `sudo` above — this IS the sudo path.
  sudoPasskeyBegin: () => request('/auth/sudo/passkey/begin', { method: 'POST' }, false),

  sudoPasskeyVerify: ({ response }) => request('/auth/sudo/passkey/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  }, false),

  // Per-action confirmation challenge (Step 7). Returns a fresh
  // PublicKeyCredentialRequestOptions plus a challengeId; the caller
  // attaches the resulting assertion to the destructive request as
  // `passkeyAssertion`.
  passkeyChallengeForAction: () => request('/user/passkey/challenge', { method: 'POST' }),

  listPasskeys: () => request('/user/passkeys'),

  renamePasskey: (id, label) => request(`/user/passkeys/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ label }),
  }),

  deletePasskey: (id, { totpCode, passkeyAssertion } = {}) => request(`/user/passkeys/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ totpCode, passkeyAssertion }),
  }),

  // Services. Phase 2b audit: a service now represents one logical workload
  // (typically an LXC or Docker container) that can expose multiple HTTP
  // routes via a nested `routes: [...]` array on every GET response. The
  // service is identified by `id` alone — (domain, pathPrefix) is now a
  // property of individual routes in `service_http_routes`, not of the
  // service itself. The only direct domain reference in this file is
  // `checkSslStatus(domain)` (a fire-and-forget GET, no cache). Nothing in
  // this client keys any cache on domain.
  getServices: () => request('/services'),

  getService: (id) => request(`/services/${id}`),

  createService: (data) => request('/services', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  updateService: (id, data) => request(`/services/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),

  deleteService: (id, totpOrPayload) => {
    const body = typeof totpOrPayload === 'string'
      ? { totpCode: totpOrPayload }
      : (totpOrPayload || {});
    return request(`/services/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    });
  },

  toggleFavorite: (id) => request(`/services/${id}/favorite`, {
    method: 'POST',
  }),

  // Phase 2b G.2: per-service HTTP route CRUD. A service can have multiple
  // routes; each row carries its own (domain, pathPrefix, targetPort,
  // sslEnabled, forceHttps, websocketEnabled, maxUploadSize).
  getServiceRoutes: (serviceId) => request(`/services/${serviceId}/routes`),

  createRoute: (serviceId, route) => request(`/services/${serviceId}/routes`, {
    method: 'POST',
    body: JSON.stringify(route),
  }),

  updateRoute: (serviceId, routeId, route) => request(`/services/${serviceId}/routes/${routeId}`, {
    method: 'PUT',
    body: JSON.stringify(route),
  }),

  deleteRoute: (serviceId, routeId) => request(`/services/${serviceId}/routes/${routeId}`, {
    method: 'DELETE',
  }),

  // Phase 2c: L4 forwards under /services/:id/l4-forwards. Each row
  // produces an Incus proxy device + a paired host firewall rule via
  // the backend reconciler — the create/delete calls are the
  // operator's single click for both.
  getServiceL4Forwards: (serviceId) =>
    request(`/services/${serviceId}/l4-forwards`),
  createServiceL4Forward: (serviceId, forward) =>
    request(`/services/${serviceId}/l4-forwards`, {
      method: 'POST',
      body: JSON.stringify(forward),
    }),
  deleteServiceL4Forward: (serviceId, forwardId) =>
    request(`/services/${serviceId}/l4-forwards/${forwardId}`, {
      method: 'DELETE',
    }),
  // Re-run the L4 reconciler against the live host state. Recreates
  // proxy devices and firewall rules that the DB still claims but
  // that have disappeared from the host (typically after a reboot
  // where an ephemeral UDP socket conflicted with a forward range).
  reconcileServiceL4Forwards: (serviceId) =>
    request(`/services/${serviceId}/l4-forwards/reconcile`, {
      method: 'POST',
    }),
  // Read-only diagnostic across the four host-side layers ProxyPilot
  // can verify (bridge IP drift, incus device, host firewall, LXC
  // listener). Returns per-forward `next_step` text the UI can show.
  diagnoseServiceL4Forwards: (serviceId) =>
    request(`/services/${serviceId}/l4-forwards/diagnose`, {
      method: 'POST',
    }),

  // TLS cert bind-mount: surface the Caddy cert directory for a
  // service and let the operator attach it as a read-only `disk`
  // device on a sibling LXC. Intent lives in service_cert_mounts;
  // the live device is owned by Incus. See
  // backend/src/lib/cert-mount-reconciler.js for the auto-heal /
  // drift policy.
  getServiceCertMounts: (serviceId) =>
    request(`/services/${serviceId}/cert-mounts`),
  createServiceCertMount: (serviceId, payload) =>
    request(`/services/${serviceId}/cert-mounts`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteServiceCertMount: (serviceId, mountId) =>
    request(`/services/${serviceId}/cert-mounts/${mountId}`, {
      method: 'DELETE',
    }),
  reconcileServiceCertMount: (serviceId, mountId) =>
    request(`/services/${serviceId}/cert-mounts/${mountId}/reconcile`, {
      method: 'POST',
    }),
  // Cert-mount target picker uses the unfiltered LXC listing — the
  // consumer container (e.g. coturn) is typically NOT a `pp-`
  // container, so the regular getLxcContainers() endpoint won't show it.
  getAllLxcContainers: () => request('/lxc/all-containers'),
  // LXC-detail view of cert mounts: returns mounts targeting this
  // container plus the services bound to this LXC with their cert
  // availability so the panel can render a "Bind <domain>'s cert" CTA
  // without a second round trip per service.
  getLxcContainerCertMounts: (name) =>
    request(`/lxc/containers/${encodeURIComponent(name)}/cert-mounts`),

  // Phase 2c: detected-ports cache + rescan trigger. The cache read
  // is cheap; rescan walks /proc/net inside the LXC, optionally
  // gating on `docker compose ps healthy` first.
  getDetectedPorts: (serviceId) =>
    request(`/services/${serviceId}/detected-ports`),
  rescanDetectedPorts: (serviceId) =>
    request(`/services/${serviceId}/detected-ports/rescan`, {
      method: 'POST',
    }),

  // Phase 2b G.3: refresh the cached LXC container IP for a service.
  // Re-queries Incus, updates services.target_ip if changed, and
  // regenerates the merged Caddy config for every affected domain.
  refreshLxcIp: (serviceId) => request(`/services/${serviceId}/refresh-ip`, {
    method: 'POST',
  }),

  getDockerContainers: () => request('/services/docker/containers'),

  // Caddy
  reloadCaddy: () => request('/services/caddy/reload', {
    method: 'POST',
  }),

  regenerateAllConfigs: () => request('/services/caddy/regenerate-all', {
    method: 'POST',
  }),

  checkSslStatus: (domain) => request(`/services/ssl-status/${domain}`),

  regenerateConfig: (serviceId) => request(`/services/${serviceId}/regenerate-config`, {
    method: 'POST',
  }),

  obtainCertificate: (serviceId) => request(`/services/${serviceId}/obtain-certificate`, {
    method: 'POST',
  }),

  removeCertificate: (serviceId, totpOrPayload) => {
    const body = typeof totpOrPayload === 'string'
      ? { totpCode: totpOrPayload }
      : (totpOrPayload || {});
    return request(`/services/${serviceId}/certificate`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    });
  },

  // File Management
  getFiles: (serviceId) => request(`/services/${serviceId}/files`),

  getFileContent: (serviceId, filePath) => request(`/services/${serviceId}/files/${filePath}`),

  saveFile: (serviceId, filePath, content, notes) => request(`/services/${serviceId}/files/${filePath}`, {
    method: 'PUT',
    body: JSON.stringify({ content, notes }),
  }),

  deleteFile: (serviceId, filePath) => request(`/services/${serviceId}/files/${filePath}`, {
    method: 'DELETE',
  }),

  uploadFile: (serviceId, filePath, content, encoding = 'text') => request(`/services/${serviceId}/upload/${filePath}`, {
    method: 'POST',
    body: JSON.stringify({ content, encoding }),
  }),

  downloadFile: (serviceId, filePath) => request(`/services/${serviceId}/download/${filePath}`),

  // File Version Control
  getFileVersions: (serviceId, filePath) => request(`/services/${serviceId}/versions/${filePath}`),

  getVersionContent: (serviceId, versionId) => request(`/services/${serviceId}/version/${versionId}`),

  revertToVersion: (serviceId, versionId) => request(`/services/${serviceId}/revert/${versionId}`, {
    method: 'POST',
  }),

  updateVersionNotes: (serviceId, versionId, notes) => request(`/services/${serviceId}/version/${versionId}/notes`, {
    method: 'PUT',
    body: JSON.stringify({ notes }),
  }),

  // File Export/Import (per service)
  exportServiceFiles: (serviceId) => request(`/services/${serviceId}/export-files`),

  importServiceFiles: (serviceId, files) => request(`/services/${serviceId}/import-files`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  }),

  // Export/Import Services
  exportServices: (serviceIds = [], includeFiles = false) => request('/services/export', {
    method: 'POST',
    body: JSON.stringify({ serviceIds, includeFiles }),
  }),

  importServices: (services, overwrite = false) => request('/services/import', {
    method: 'POST',
    body: JSON.stringify({ services, overwrite }),
  }),

  // Terminal
  executeCommand: (command, workingDir, timeout, signal) => request('/services/terminal/execute', {
    method: 'POST',
    body: JSON.stringify({ command, workingDir, timeout }),
    signal,
  }),

  writeFile: (filePath, content, createDirs = true) => request('/services/terminal/write-file', {
    method: 'POST',
    body: JSON.stringify({ filePath, content, createDirs }),
  }),

  uploadFileToDirectory: (directory, filename, content, encoding = 'base64') => request('/services/terminal/upload-file', {
    method: 'POST',
    body: JSON.stringify({ directory, filename, content, encoding }),
  }),

  getSystemInfo: () => request('/services/terminal/system-info'),

  getSystemStats: () => request('/services/system/stats'),

  // Docker
  listContainers: () => request('/services/docker/containers'),

  containerAction: (action, containerId, containerName) => request(`/services/docker/container/${action}`, {
    method: 'POST',
    body: JSON.stringify({ containerId, containerName }),
  }),

  dockerCompose: (action, path, serviceName, options = null) => request('/services/docker/compose', {
    method: 'POST',
    body: JSON.stringify({ action, path, serviceName, options }),
  }),

  dockerComposeDestroy: (path, totpOrPayload, options = {}) => {
    const confirm = typeof totpOrPayload === 'string'
      ? { totpCode: totpOrPayload }
      : (totpOrPayload || {});
    return request('/services/docker/compose/destroy', {
      method: 'POST',
      body: JSON.stringify({ path, ...confirm, options }),
    });
  },

  // User
  getProfile: () => request('/user/profile'),

  changePassword: (data) => request('/user/change-password', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  generateTotp: (password) => request('/user/totp/generate', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: password }),
  }),

  verifyTotp: (data) => request('/user/totp/verify', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  getAuditLog: (limit = 50, offset = 0) =>
    request(`/user/audit-log?limit=${limit}&offset=${offset}`),

  // Device Management
  getDevices: () => request('/user/devices'),

  // Confirm-payload accepts either a 6-digit totpCode string OR an
  // object { totpCode, passkeyAssertion }. The string form is the
  // pre-passkey shape kept for backwards compatibility.
  revokeDevice: (deviceId, totpOrPayload) => {
    const body = typeof totpOrPayload === 'string'
      ? { totpCode: totpOrPayload }
      : (totpOrPayload || {});
    return request(`/user/devices/${deviceId}`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    });
  },

  revokeAllDevices: (totpOrPayload, keepCurrent) => {
    const body = typeof totpOrPayload === 'string'
      ? { totpCode: totpOrPayload, keepCurrent }
      : { ...(totpOrPayload || {}), keepCurrent };
    return request('/user/devices/revoke-all', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // Service Config Versions
  getConfigVersions: (serviceId) => request(`/services/${serviceId}/config-versions`),

  revertConfig: (serviceId, versionId) => request(`/services/${serviceId}/revert-config/${versionId}`, {
    method: 'POST',
  }),

  // Caddy Config (Advanced)
  getCaddyConfig: (serviceId) => request(`/services/${serviceId}/caddy-config`),

  saveCaddyConfig: (serviceId, config) => request(`/services/${serviceId}/caddy-config`, {
    method: 'PUT',
    body: JSON.stringify({ config }),
  }),

  // System Security
  secureSystem: (totpOrPayload) => {
    const body = typeof totpOrPayload === 'string'
      ? { totpCode: totpOrPayload }
      : (totpOrPayload || {});
    return request('/services/system/secure', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // Discover existing sites
  discoverCaddySites: () => request('/services/discover/caddy-sites'),

  importDiscoveredSite: (site) => request('/services/discover/import', {
    method: 'POST',
    body: JSON.stringify(site),
  }),

  // Docker Compose services
  discoverDockerCompose: () => request('/services/discover/docker-compose'),

  getDockerComposeServices: () => request('/services/docker-compose/services'),

  // User Management (Admin only)
  getUsers: () => request('/user/users'),

  createUser: (data) => request('/user/users', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  updateUser: (id, data) => request(`/user/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),

  // Deletion is protected by the sudo gate server-side (the modal
  // prompts automatically on a stale grant) — no per-request TOTP.
  deleteUser: (id) => request(`/user/users/${id}`, {
    method: 'DELETE',
    body: '{}',
  }),

  // LDAPS directory connections (Admin only). bindPassword/caCert are
  // write-only: omit them on update to keep the stored values.
  getLdapConnections: () => request('/ldap/connections'),

  createLdapConnection: (data) => request('/ldap/connections', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  updateLdapConnection: (id, data) => request(`/ldap/connections/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),

  deleteLdapConnection: (id) => request(`/ldap/connections/${id}`, {
    method: 'DELETE',
    body: '{}',
  }),

  testLdapConnection: (id) => request(`/ldap/connections/${id}/test`, {
    method: 'POST',
    body: '{}',
  }),

  getUserAccess: (id) => request(`/user/users/${id}/access`),

  updateUserAccess: (id, access) => request(`/user/users/${id}/access`, {
    method: 'PUT',
    body: JSON.stringify({ access }),
  }),

  // Feature permissions for the 'user' role: 'proxy' (containers &
  // routing) and 'developer' (Projects module). Enforced from the DB
  // per-request, so changes are live for the target user immediately.
  updateUserPermissions: (id, permissions) => request(`/user/users/${id}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ permissions }),
  }),

  getUserFolderAccess: (id) => request(`/user/users/${id}/folder-access`),

  updateUserFolderAccess: (id, folderAccess) => request(`/user/users/${id}/folder-access`, {
    method: 'PUT',
    body: JSON.stringify({ folderAccess }),
  }),

  changeInitialPassword: (data) => request('/user/change-initial-password', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  // Docker Volumes
  getDockerVolumes: () => request('/services/docker/volumes'),

  exportVolume: (volumeName) => request('/services/docker/volumes/export', {
    method: 'POST',
    body: JSON.stringify({ volumeName }),
  }),

  importVolume: (volumeName, backupFile) => request('/services/docker/volumes/import', {
    method: 'POST',
    body: JSON.stringify({ volumeName, backupFile }),
  }),

  getVolumeBackups: () => request('/services/docker/volumes/backups'),

  // Version (display-only). The auto-update flow was removed —
  // operators update via their own deploy mechanism.
  getVersion: () => request('/user/version'),

  // LXC Container Management
  getLxcStatus: () => request('/lxc/status'),

  getLxcContainers: () => request('/lxc/containers'),

  // Phase 2b G.1: compact listing used by the Add Service wizard's LXC
  // dropdown. Returns {containers: [{name, status, ipv4, ipv6}]} with
  // the `pp-` instance prefix already stripped.
  getLxcContainersWithIp: () => request('/lxc/containers/with-ip'),

  getLxcContainer: (name) => request(`/lxc/containers/${name}`),

  getLxcContainerState: (name) => request(`/lxc/containers/${name}/state`),

  createLxcContainer: (data) => request('/lxc/containers', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  getLxcCreateStatus: (name) => request(`/lxc/containers/${name}/create-status`),

  startLxcContainer: (name) => request(`/lxc/containers/${name}/start`, {
    method: 'POST',
  }),

  stopLxcContainer: (name) => request(`/lxc/containers/${name}/stop`, {
    method: 'POST',
  }),

  restartLxcContainer: (name) => request(`/lxc/containers/${name}/restart`, {
    method: 'POST',
  }),

  rebootLxcContainer: (name) => request(`/lxc/containers/${name}/reboot`, {
    method: 'POST',
  }),

  // Rename a container.  Incus requires the container to be
  // stopped; the route surfaces a clear hint when the operator
  // forgets.  Updates services.lxc_container_name on success.
  renameLxcContainer: (name, newName) => request(`/lxc/containers/${name}/rename`, {
    method: 'POST',
    body: JSON.stringify({ newName }),
  }),

  // Transfer (clone) every service whose lxc_container_name points
  // at `fromName` to a fresh row pointing at `toName`.  Used after
  // a Pull-from-S3 to copy the routing rules onto the restored
  // sibling without re-typing them.
  transferLxcContainerRoutes: (fromName, toName) => request(`/lxc/containers/${fromName}/transfer-routes`, {
    method: 'POST',
    body: JSON.stringify({ toName }),
  }),

  deleteLxcContainer: (name) => request(`/lxc/containers/${name}`, {
    method: 'DELETE',
  }),

  resizeLxcContainer: (name, limits) => request(`/lxc/containers/${name}/resize`, {
    method: 'POST',
    body: JSON.stringify(limits),
  }),

  // LXC Container Services (Caddy reverse proxy mappings)
  getLxcServices: (name) => request(`/lxc/containers/${name}/services`),

  // Phase 2c: TCP + UDP ports the LXC is currently listening on.
  // Backs the container-detail panel's exposed-ports chip row and
  // the port-input typeahead in the "add service" form.
  getLxcListeningPorts: (name) => request(`/lxc/containers/${name}/listening-ports`),

  // Phase 2c: one-shot MEET single-domain installer. Inserts the
  // four canonical HTTP routes (/livekit, /api, /ws, /) and the
  // two L4 forwards (tcp/7881, udp/50000-60000) in one call so
  // the operator doesn't have to enter them by hand.
  quickAddMeet: (name, domain) =>
    request(`/lxc/containers/${name}/quick-add/meet`, {
      method: 'POST',
      body: JSON.stringify({ domain }),
    }),

  // Phase 2c: force-rebuild every merged Caddyfile this LXC owns
  // and reload Caddy. Used when on-disk state has drifted from the
  // routes table (a missed reload, a manual edit gone stale).
  // Operator action of last resort that doesn't require host
  // shell access.
  regenerateLxcCaddy: (name) =>
    request(`/lxc/containers/${name}/services/regenerate`, {
      method: 'POST',
    }),

  addLxcService: (name, service) => request(`/lxc/containers/${name}/services`, {
    method: 'POST',
    body: JSON.stringify(service),
  }),

  // Phase 2c: pass routeId for db-source rows so the backend
  // updates the matching service_http_routes row instead of
  // operating on the legacy per-domain Caddyfile (which it can't
  // disambiguate when multiple paths share a domain).
  updateLxcService: (name, oldDomain, service, routeId) => {
    const qs = routeId ? `?routeId=${encodeURIComponent(routeId)}` : '';
    return request(`/lxc/containers/${name}/services/${encodeURIComponent(oldDomain)}${qs}`, {
      method: 'PUT',
      body: JSON.stringify(service),
    });
  },

  // Phase 2c: when the service entry came from the routes table
  // (source='db'), pass the route id so the backend can target
  // the row + regenerate the merged Caddyfile. Legacy file-only
  // entries (source='file') leave routeId undefined and the
  // backend falls back to the per-domain unlink.
  deleteLxcService: (name, domain, routeId) => {
    const qs = routeId ? `?routeId=${encodeURIComponent(routeId)}` : '';
    return request(`/lxc/containers/${name}/services/${encodeURIComponent(domain)}${qs}`, {
      method: 'DELETE',
    });
  },

  getLxcSnapshots: (name) => request(`/lxc/containers/${name}/snapshots`),

  // Snapshots are always created local-only.  Promotion to S3
  // happens via exportLxcSnapshotToS3 (per-row Push to S3 dialog).
  createLxcSnapshot: (name, snapshotName, note) =>
    request(`/lxc/containers/${name}/snapshot`, {
      method: 'POST',
      body: JSON.stringify({ snapshotName, note }),
    }),

  // Per-snapshot S3 export rows (one per destination).  Used by
  // the snapshots panel to render 'on-site ✓ · off-site ✗'
  // chips next to each snapshot.
  getLxcSnapshotExports: (name) =>
    request(`/lxc/containers/${name}/snapshot-exports`),

  // Retroactive export: push an existing local snapshot to one
  // or more S3 destinations after the fact.
  exportLxcSnapshotToS3: (name, snapshotName, destinationIds) =>
    request(
      `/lxc/containers/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snapshotName)}/s3-export`,
      {
        method: 'POST',
        body: JSON.stringify({ destination_ids: destinationIds }),
      },
    ),

  deleteLxcSnapshotS3Export: (name, snapshotName, exportId) =>
    request(
      `/lxc/containers/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snapshotName)}/s3-export/${encodeURIComponent(exportId)}`,
      { method: 'DELETE' },
    ),

  // HEAD-style metadata for a single S3 copy: object size,
  // last-modified, plus retention/legal-hold info.  Used by the
  // delete-confirm dialog to show 'retained until ...' before the
  // operator commits.  Returns 404 / 502 via ApiError when the
  // bucket is unreachable.
  getLxcSnapshotS3ExportInfo: (name, snapshotName, exportId) =>
    request(
      `/lxc/containers/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snapshotName)}/s3-export/${encodeURIComponent(exportId)}/info`,
    ),

  // Cancel an in-flight S3 export.  No-op when the row already
  // reached a terminal state (returns { alreadyFinished: true }).
  cancelLxcSnapshotS3Export: (name, snapshotName, exportId) =>
    request(
      `/lxc/containers/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snapshotName)}/s3-export/${encodeURIComponent(exportId)}/cancel`,
      { method: 'POST' },
    ),

  // Poll an in-flight snapshot job kicked off by createLxcSnapshot.
  // Returns { status, elapsedMs, estimateMs, error? }.
  getLxcSnapshotJob: (name, jobId) => request(`/lxc/containers/${name}/snapshot-jobs/${jobId}`),

  restoreLxcSnapshot: (name, snapshotName) => request(`/lxc/containers/${name}/snapshot/${snapshotName}/restore`, {
    method: 'POST',
  }),

  // Whole-snapshot delete: removes both the local copy AND every
  // S3 copy.  Use deleteLxcSnapshotLocal to keep S3 copies, or
  // deleteLxcSnapshotS3Export to drop a single S3 destination.
  deleteLxcSnapshot: (name, snapshotName) => request(`/lxc/containers/${name}/snapshot/${snapshotName}`, {
    method: 'DELETE',
  }),

  // Local-only delete: drops the snapshot from the host's Incus
  // pool but leaves every S3 copy in place.
  deleteLxcSnapshotLocal: (name, snapshotName) => request(
    `/lxc/containers/${name}/snapshot/${snapshotName}/local`,
    { method: 'DELETE' },
  ),

  // Pull a previously-exported S3 tarball back into the local
  // Incus pool as a snapshot of the same name.  Fails with 409
  // if a local snapshot of that name already exists.
  restoreLxcSnapshotFromS3: (name, snapshotName, exportId) => request(
    `/lxc/containers/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snapshotName)}/s3-export/${encodeURIComponent(exportId)}/restore`,
    { method: 'POST' },
  ),

  // Polled by the Pull-from-S3 dialog while the long-running
  // download/import dance runs.  { found, phase, label,
  // bytes_loaded?, bytes_total?, error? }.
  getLxcSnapshotS3ImportProgress: (name, snapshotName, exportId) => request(
    `/lxc/containers/${encodeURIComponent(name)}/snapshot/${encodeURIComponent(snapshotName)}/s3-export/${encodeURIComponent(exportId)}/import-progress`,
  ),

  // Global snapshot-export queue status.  Returns running + queued
  // jobs across all containers.  Drives the admin-wide banner.
  getSnapshotExportQueue: () => request('/lxc/containers/snapshot-export-queue'),

  // Pre-flight estimate for downloading a previously-taken snapshot.
  getLxcSnapshotExportInfo: (name, snapshotName) =>
    request(`/lxc/containers/${name}/snapshot/${snapshotName}/export-info`),

  getSnapshotNotes: (name, snapshotName) => request(`/lxc/containers/${name}/snapshot/${snapshotName}/notes`),

  addSnapshotNote: (name, snapshotName, note) => request(`/lxc/containers/${name}/snapshot/${snapshotName}/notes`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  }),

  deleteSnapshotNote: (name, snapshotName, noteId) => request(`/lxc/containers/${name}/snapshot/${snapshotName}/notes/${noteId}`, {
    method: 'DELETE',
  }),

  // Host cleanup — enumerate and delete safely-removable artifacts
  // (unused incus images, orphaned snapshot-export temp containers,
  // stale upload temp files). Two-step: preview, then execute only
  // the categories the operator opts into.
  getLxcCleanupPreview: () => request('/lxc/cleanup/preview'),
  executeLxcCleanup: (categories) => request('/lxc/cleanup/execute', {
    method: 'POST',
    body: JSON.stringify({ categories }),
  }),

  getLxcImages: () => request('/lxc/images'),

  // Incus Infrastructure Management
  getIncusNetworks: () => request('/lxc/networks'),
  getIncusNetwork: (name) => request(`/lxc/networks/${name}`),
  updateIncusNetwork: (name, config) => request(`/lxc/networks/${name}`, {
    method: 'PUT',
    body: JSON.stringify({ config }),
  }),
  unsetIncusNetworkKey: (name, key) => request(`/lxc/networks/${name}/unset`, {
    method: 'POST',
    body: JSON.stringify({ key }),
  }),
  getIncusStoragePools: () => request('/lxc/storage-pools'),
  getIncusProfiles: () => request('/lxc/profiles'),
  getIncusProfile: (name) => request(`/lxc/profiles/${name}`),
  getIncusCachedImages: () => request('/lxc/cached-images'),
  deleteIncusCachedImage: (fingerprint) => request(`/lxc/cached-images/${fingerprint}`, {
    method: 'DELETE',
  }),

  // Container file management (exec/tab-complete retired with the
  // legacy request-response ContainerTerminal — InteractiveTerminal
  // streams over WebSocket instead).
  importContainer: async (name, file) => {
    const csrf = readCookie('pp_csrf');
    const formData = new FormData();
    formData.append('name', name);
    formData.append('backup', file);
    const response = await fetch(`${API_BASE}/lxc/containers/import`, {
      method: 'POST',
      credentials: 'include',
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.error || 'Import failed', response.status, data);
    return data;
  },

  // Pre-flight info for an export — backend returns
  // { estimatedBytes, isRunning } so the UI can render a sized progress
  // bar before the actual streaming download starts.
  getLxcExportInfo: (name) => request(`/lxc/containers/${name}/export-info`),

  // Import with upload-progress callback. fetch() doesn't expose upload
  // progress; XMLHttpRequest does via xhr.upload.onprogress. Returns a
  // promise resolving with the parsed response. onProgress is called
  // with { loaded, total, phase }, where phase is 'uploading' during
  // the byte transfer and 'processing' once the body is fully sent and
  // we're waiting on incus to finish the import on the host.
  importContainerWithProgress: (name, file, onProgress) => {
    return new Promise((resolve, reject) => {
      const csrf = readCookie('pp_csrf');
      const formData = new FormData();
      formData.append('name', name);
      formData.append('backup', file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/lxc/containers/import`);
      xhr.withCredentials = true;
      if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.upload.addEventListener('progress', (e) => {
        if (onProgress && e.lengthComputable) {
          onProgress({ loaded: e.loaded, total: e.total, phase: 'uploading' });
        }
      });
      // Once the upload byte stream finishes, the backend is still
      // running `incus import` on the host. Surface that distinct
      // phase so the UI can swap from a determinate progress bar to
      // a "processing on host..." spinner with elapsed time.
      xhr.upload.addEventListener('load', () => {
        if (onProgress) onProgress({ loaded: file.size, total: file.size, phase: 'processing' });
      });
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new ApiError(data.error || `Import failed (HTTP ${xhr.status})`, xhr.status, data));
        }
      };
      xhr.onerror = () => reject(new ApiError('Network error during import', 0, {}));
      xhr.onabort = () => reject(new ApiError('Import cancelled', 0, {}));
      xhr.send(formData);
    });
  },

  listContainerFiles: (name, path = '/root') => request(`/lxc/containers/${name}/files?path=${encodeURIComponent(path)}`),

  getContainerFileDownloadUrl: (name, path) => `${API_BASE}/lxc/containers/${name}/files/download?path=${encodeURIComponent(path)}`,

  // ── SSH access (per-device authorized_keys ledger) ─────────────────────
  listSshAccess: (filter = 'active') =>
    request(`/ssh-access?filter=${encodeURIComponent(filter)}`),
  getSshAccess: (id) =>
    request(`/ssh-access/${encodeURIComponent(id)}`),
  getSshAccessBootstrapScript: (id, { user, server, shell } = {}) => {
    const params = new URLSearchParams();
    if (user) params.set('user', user);
    if (server) params.set('server', server);
    if (shell) params.set('shell', shell);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return request(`/ssh-access/${encodeURIComponent(id)}/bootstrap-script${qs}`);
  },
  addSshAccess: (data) =>
    request('/ssh-access', { method: 'POST', body: JSON.stringify(data) }),
  revokeSshAccess: (id, body) =>
    request(`/ssh-access/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),
  removeSshAccess: (id, body) =>
    request(`/ssh-access/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify(body || {}),
    }),
  reconcileSshAccess: (dryRun = false) =>
    request('/ssh-access/reconcile', {
      method: 'POST',
      body: JSON.stringify({ dry_run: !!dryRun }),
    }),

  // ── SSH host key fingerprints (read-only) ──────────────────────────────
  // GET host-keys: { ok, keys: [{ type, fingerprint, bits, file, mtime }] }
  // Surfaced in the connect modal so an operator can compare against the
  // fingerprint SSH warns about when host keys have been regenerated.
  getSshHostKeys: () => request('/ssh-access/host-keys'),

  // ── SSH password-auth toggle (sshd_config PasswordAuthentication) ─────
  // GET status: { ok, password_auth: 'yes'|'no'|'default', effective_default,
  //   match_overrides[], active_keys_total, active_keys_per_user }
  // POST set: { enabled: boolean, force?: boolean }
  // 409 with code=NO_ACTIVE_KEYS + requires_force=true on disable when
  // no active ssh-access entries exist (lockout guard).
  getSshPasswordAuthStatus: () => request('/ssh-access/password-auth/status'),
  setSshPasswordAuth: (body) =>
    request('/ssh-access/password-auth', {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),

  // ── Firewall manager ──────────────────────────────────────────────────
  // The CLI's --json contract is the wire format: list returns a bare
  // array of rules, status returns the bare object, the toggle paths
  // wrap their result in { ok, action, rule, warnings, reconcile }.
  // Helpers below preserve that shape — frontend reads `rules`, `status`,
  // `entries`, `services` directly off the parsed body.
  listFirewall: () => request('/firewall'),
  getFirewallStatus: () => request('/firewall/status'),
  listFirewallEgress: () => request('/firewall/egress'),
  enableFirewallRule: (id, body = {}) =>
    request(`/firewall/${encodeURIComponent(id)}/enable`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  disableFirewallRule: (id) =>
    request(`/firewall/${encodeURIComponent(id)}/disable`, { method: 'POST', body: '{}' }),
  setFirewallRuleScope: (id, body) =>
    request(`/firewall/${encodeURIComponent(id)}/set-scope`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),
  addFirewallManualRule: (body) =>
    request('/firewall/manual', { method: 'POST', body: JSON.stringify(body || {}) }),
  removeFirewallManualRule: (id) =>
    request(`/firewall/manual/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' }),
  reconcileFirewall: (dryRun = false) =>
    request('/firewall/reconcile', {
      method: 'POST',
      body: JSON.stringify({ dry_run: !!dryRun }),
    }),
  scanFirewall: () => request('/firewall/scan', { method: 'POST', body: '{}' }),
  panicCloseFirewall: () => request('/firewall/panic-close', { method: 'POST', body: '{}' }),
  panicOpenFirewall: () => request('/firewall/panic-open', { method: 'POST', body: '{}' }),
  allowFirewallEgress: (body) =>
    request('/firewall/egress/allow', { method: 'POST', body: JSON.stringify(body || {}) }),
  denyFirewallEgress: (body) =>
    request('/firewall/egress/deny', { method: 'POST', body: JSON.stringify(body || {}) }),

  // ── VPN manager ───────────────────────────────────────────────────────
  // GET / returns { ok, status, peers } (status = vpn-status JSON shape,
  // peers = peer-list JSON shape with wg-show data joined). addVpnPeer's
  // response carries `private_key` + `config` once — the frontend renders
  // QR + textarea immediately and DOES NOT round-trip the key back later.
  // 409 + requires_force on a destructive call signals one of
  // { LAST_ENABLED_PEER, RECENTLY_ACTIVE, LAST_FULL_ADMIN_DEMOTE };
  // the dashboard re-prompts the operator with a typed phrase before
  // re-issuing with force:true.
  listVpn: () => request('/vpn'),
  getVpnPeer: (name) => request(`/vpn/${encodeURIComponent(name)}`),
  enableVpn: (body) => request('/vpn/enable', { method: 'POST', body: JSON.stringify(body || {}) }),
  disableVpn: () => request('/vpn/disable', { method: 'POST', body: '{}' }),
  // Change WG server listen port. Backend pins to the safe range
  // 49000-49999 — outside the kernel ephemeral pool and the typical
  // WebRTC media range — and rewrites wg0.conf, restarts wg-quick,
  // re-reconciles the firewall, all in one transaction.
  setVpnListenPort: (port) =>
    request('/vpn/server/listen-port', {
      method: 'POST',
      body: JSON.stringify({ port }),
    }),
  addVpnPeer: (body) => request('/vpn/peers', { method: 'POST', body: JSON.stringify(body || {}) }),
  rotateVpnPeer: (name) =>
    request(`/vpn/peers/${encodeURIComponent(name)}/rotate`, { method: 'POST', body: '{}' }),
  enableVpnPeer: (name) =>
    request(`/vpn/peers/${encodeURIComponent(name)}/enable`, { method: 'POST', body: '{}' }),
  disableVpnPeer: (name, body = {}) =>
    request(`/vpn/peers/${encodeURIComponent(name)}/disable`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeVpnPeer: (name, body = {}) =>
    request(`/vpn/peers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    }),
  setVpnPeerScope: (name, body) =>
    request(`/vpn/peers/${encodeURIComponent(name)}/set-scope`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),

  // Security / CVE inbox — wraps the agent-side
  // security.cve_<id>.check / .patch RPCs through the backend
  // /api/security/cve/<id> surface. The patch call is sudo-gated,
  // so the existing useSudo hook will prompt and replay on
  // sudo_required envelopes.
  cveCheck: (cveId) =>
    request(`/security/cve/${encodeURIComponent(cveId)}`),
  cvePatch: (cveId, body = {}) =>
    request(`/security/cve/${encodeURIComponent(cveId)}/patch`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // CVE inbox — Claude writes spec YAMLs into the inbox dir; the
  // Python engine reads + executes them per-host. These endpoints
  // back the dashboard's CVEs section: list view, detail view, and
  // the operator-driven actions (mark seen, dismiss, run-on-this-host).
  // Mock2 module presence probe. 200 when enabled; 404 on a disabled or
  // production-pinned host (ADR-001) — callers key their UI off which.
  // Mock2 enabled-probe. Every Mock2 page gates its render on this resolving.
  // A disabled/unmounted module makes /api/mock2/status 404 (JSON) — request()
  // throws, the gate goes 'disabled', correct. Defensively, if a stale backend
  // (without the /api JSON-404 guard) lets the SPA answer the GET with a 200
  // HTML body, request() surfaces that as {} — so require the real status
  // payload before treating the module as enabled.
  mock2Status: async () => {
    const res = await request('/mock2/status');
    if (!res || (res.enabled !== true && res.status !== 'ok')) {
      throw new ApiError('Mock2 module is not enabled on this host', 404);
    }
    return res;
  },

  // Mock2 parent domains (Phase M1). Admin-gated; delete requires sudo.
  mock2ListParentDomains: () => request('/mock2/parent-domains'),
  mock2GetParentDomain: (id) => request(`/mock2/parent-domains/${id}`),
  mock2RegisterParentDomain: (domain) =>
    request('/mock2/parent-domains', { method: 'POST', body: JSON.stringify({ domain }) }),
  mock2VerifyParentDomain: (id) =>
    request(`/mock2/parent-domains/${id}/verify`, { method: 'POST' }),
  mock2EnableParentDomain: (id) =>
    request(`/mock2/parent-domains/${id}/enable`, { method: 'POST' }),
  mock2DisableParentDomain: (id) =>
    request(`/mock2/parent-domains/${id}/disable`, { method: 'POST' }),
  mock2DeleteParentDomain: (id) =>
    request(`/mock2/parent-domains/${id}`, { method: 'DELETE' }),

  // Mock2 projects (Phase M2). Create is admin-gated + provisions async
  // (202 → poll provision-status); delete requires sudo.
  mock2ListProjects: () => request('/mock2/projects'),
  mock2GetProject: (id) => request(`/mock2/projects/${id}`),
  mock2CreateProject: ({ name, description, parent_domain_id }) =>
    request('/mock2/projects', {
      method: 'POST',
      body: JSON.stringify({ name, description, parent_domain_id }),
    }),
  mock2ProjectProvisionStatus: (id) => request(`/mock2/projects/${id}/provision-status`),
  mock2RotateProjectSlug: (id) => request(`/mock2/projects/${id}/rotate-slug`, { method: 'POST' }),
  mock2SetProjectMember: (id, { user_id, role }) =>
    request(`/mock2/projects/${id}/members`, { method: 'POST', body: JSON.stringify({ user_id, role }) }),
  mock2RemoveProjectMember: (id, userId) =>
    request(`/mock2/projects/${id}/members/${userId}`, { method: 'DELETE' }),
  mock2FlagProject: (id, { flagged, reason }) =>
    request(`/mock2/projects/${id}/flag`, { method: 'POST', body: JSON.stringify({ flagged, reason }) }),
  mock2SetProjectCustomDomain: (id, domain) =>
    request(`/mock2/projects/${id}/custom-domain`, { method: 'POST', body: JSON.stringify({ domain }) }),
  mock2DeleteProject: (id) => request(`/mock2/projects/${id}`, { method: 'DELETE' }),
  mock2ArchiveProject: (id) => request(`/mock2/projects/${id}/archive`, { method: 'POST' }),
  mock2RehydrateProject: (id) => request(`/mock2/projects/${id}/rehydrate`, { method: 'POST' }),
  mock2WakeProject: (id) => request(`/mock2/projects/${id}/wake`, { method: 'POST' }),
  mock2GetIdleStopDays: () => request('/mock2/settings/idle-stop-days'),
  mock2SetIdleStopDays: (days) =>
    request('/mock2/settings/idle-stop-days', { method: 'POST', body: JSON.stringify({ days }) }),

  // Mock2 concept chat message limit (admin-only). Read returns the current
  // ceiling and the selectable options (4k/8k/16k/32k).
  mock2GetChatMaxChars: () => request('/mock2/settings/chat-max-chars'),
  mock2SetChatMaxChars: (maxChars) =>
    request('/mock2/settings/chat-max-chars', { method: 'POST', body: JSON.stringify({ max_chars: maxChars }) }),

  // Mock2 integration-gate mode (admin-only) — the block/approve loop relief
  // valve. Read returns the current mode and the options (enforce/pending/monitor).
  mock2GetIntegrationGateMode: () => request('/mock2/settings/integration-gate-mode'),
  mock2SetIntegrationGateMode: (mode) =>
    request('/mock2/settings/integration-gate-mode', { method: 'POST', body: JSON.stringify({ mode }) }),

  // Mock2 component auto-apply (admin-only) — when enabled, every published
  // standard component is installed into every build automatically instead of
  // waiting on a capability-match suggestion + per-project confirm.
  mock2GetComponentAutoApply: () => request('/mock2/settings/component-auto-apply'),
  mock2SetComponentAutoApply: (enabled) =>
    request('/mock2/settings/component-auto-apply', { method: 'POST', body: JSON.stringify({ enabled }) }),

  // Mock2 per-project egress traffic log — where the container's traffic went, as
  // the FIREWALL recorded it (nftables logs each new outbound connection; squid
  // was removed). Read-only, member-visible. Entries are destination IP:port.
  mock2GetEgressLog: (id, limit = 200) => request(`/mock2/projects/${id}/egress-log?limit=${limit}`),

  // Time tracking: flush accumulated active-typing seconds; read the derived summary.
  mock2AddTyping: (id, seconds) =>
    request(`/mock2/projects/${id}/typing`, { method: 'POST', body: JSON.stringify({ seconds }) }),
  mock2GetTimeSummary: (id) => request(`/mock2/projects/${id}/time-summary`),

  // Declared egress grants — the internal hosts the app declared in mock2.yaml
  // `egress:`, each with its admin-decision status and host-reachability probe.
  // Member-visible list; admin re-probe (does the HOST route to it?). Approve/deny
  // flows through the admin queue (mock2SetQueueItemStatus on the egress_grant item).
  mock2ListEgress: (id) => request(`/mock2/projects/${id}/egress`),
  mock2ProbeEgress: (id, grantId) =>
    request(`/mock2/projects/${id}/egress/${grantId}/probe`, { method: 'POST' }),
  // Operator-initiated egress grant (admin) — open the build fence to a LAN /
  // external host:port directly, without waiting for the app to declare it in
  // mock2.yaml. Created already-approved; the fence is reconciled immediately.
  mock2AddEgress: (id, body) =>
    request(`/mock2/projects/${id}/egress`, { method: 'POST', body: JSON.stringify(body || {}) }),
  // Accept a BLOCKED build as pending live verification (admin) — convert an
  // unverifiable-in-fence integration block to pending-operator-verification and
  // deploy, with a required attestation; never records "succeeded".
  mock2AcceptPending: (id, cycleId, attestation) =>
    request(`/mock2/projects/${id}/cycles/${cycleId}/accept-pending`, { method: 'POST', body: JSON.stringify({ attestation }) }),

  // ---- M5: model connectors, slots, prices ----
  mock2ListConnectors: () => request('/mock2/connectors'),
  mock2GetConnector: (id) => request(`/mock2/connectors/${id}`),
  mock2CreateConnector: (body) =>
    request('/mock2/connectors', { method: 'POST', body: JSON.stringify(body) }),
  mock2UpdateConnector: (id, body) =>
    request(`/mock2/connectors/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  mock2DeleteConnector: (id) => request(`/mock2/connectors/${id}`, { method: 'DELETE' }),
  mock2TestConnector: (id) => request(`/mock2/connectors/${id}/test`, { method: 'POST' }),
  mock2AckConnectorBaa: (id) => request(`/mock2/connectors/${id}/baa-ack`, { method: 'POST' }),
  mock2ListModelSlots: () => request('/mock2/model-slots'),
  mock2AssignModelSlot: (slot, body) =>
    request(`/mock2/model-slots/${slot}`, { method: 'PUT', body: JSON.stringify(body) }),
  mock2ClearModelSlot: (slot) => request(`/mock2/model-slots/${slot}`, { method: 'DELETE' }),
  mock2ListPrices: (id) => request(`/mock2/connectors/${id}/prices`),
  mock2SetPrice: (id, body) =>
    request(`/mock2/connectors/${id}/prices`, { method: 'POST', body: JSON.stringify(body) }),
  mock2DeletePrice: (id, priceId) =>
    request(`/mock2/connectors/${id}/prices/${priceId}`, { method: 'DELETE' }),

  // ---- M5: quotas ----
  mock2ListQuotas: () => request('/mock2/quotas'),
  mock2SetQuota: (body) => request('/mock2/quotas', { method: 'POST', body: JSON.stringify(body) }),
  mock2DeleteQuota: (id) => request(`/mock2/quotas/${id}`, { method: 'DELETE' }),

  // ---- M5: git connectors + project remotes ----
  mock2ListGitConnectors: () => request('/mock2/git-connectors'),
  mock2CreateGitConnector: (body) =>
    request('/mock2/git-connectors', { method: 'POST', body: JSON.stringify(body) }),
  mock2UpdateGitConnector: (id, body) =>
    request(`/mock2/git-connectors/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  mock2DeleteGitConnector: (id) => request(`/mock2/git-connectors/${id}`, { method: 'DELETE' }),
  mock2TestGitConnector: (id) => request(`/mock2/git-connectors/${id}/test`, { method: 'POST' }),
  mock2GetProjectRemote: (id) => request(`/mock2/projects/${id}/remote`),
  mock2SetProjectRemote: (id, body) =>
    request(`/mock2/projects/${id}/remote`, { method: 'POST', body: JSON.stringify(body) }),
  mock2ClearProjectRemote: (id) => request(`/mock2/projects/${id}/remote`, { method: 'DELETE' }),
  // Zip export is a binary GET — link to it directly (cookie auth rides along).
  mock2ProjectExportZipUrl: (id) => `/api/mock2/projects/${id}/export.zip`,
  // Full git repository (git bundle with history) — clone with `git clone <file>.bundle`.
  mock2ProjectRepoBundleUrl: (id) => `/api/mock2/projects/${id}/repo.bundle`,

  // ---- M5: framework registry ----
  mock2ListFrameworkVersions: () => request('/mock2/framework/versions'),
  mock2GetFrameworkVersion: (id) => request(`/mock2/framework/versions/${id}`),
  mock2GetCurrentFramework: () => request('/mock2/framework/current'),
  mock2PublishFramework: (body) =>
    request('/mock2/framework/versions', { method: 'POST', body: JSON.stringify(body) }),
  mock2RevertFramework: (id, changelog) =>
    request(`/mock2/framework/versions/${id}/revert`, { method: 'POST', body: JSON.stringify({ changelog }) }),
  // Portable framework export/import ("download the harness"): export returns the
  // JSON document (the caller blob-downloads it); import creates a NEW version
  // from a document, held to the same content bar as a publish.
  mock2ExportFramework: (id) => request(`/mock2/framework/versions/${id}/export`),
  mock2ImportFramework: (doc, changelog) =>
    request('/mock2/framework/import', { method: 'POST', body: JSON.stringify(changelog ? { doc, changelog } : { doc }) }),

  // ---- Component library (migration 516): reusable, versioned building blocks ----
  mock2ListComponents: (status) =>
    request(`/mock2/components${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  mock2GetComponent: (id) => request(`/mock2/components/${id}`),
  mock2CreateComponent: (body) =>
    request('/mock2/components', { method: 'POST', body: JSON.stringify(body) }),
  mock2UpdateComponent: (id, body) =>
    request(`/mock2/components/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  mock2DeleteComponent: (id) =>
    request(`/mock2/components/${id}`, { method: 'DELETE' }),
  mock2ListComponentVersions: (id) => request(`/mock2/components/${id}/versions`),
  mock2GetComponentVersion: (id, vid) => request(`/mock2/components/${id}/versions/${vid}`),
  mock2PublishComponentVersion: (id, body) =>
    request(`/mock2/components/${id}/versions`, { method: 'POST', body: JSON.stringify(body) }),
  mock2RevertComponentVersion: (id, vid, change_reason) =>
    request(`/mock2/components/${id}/versions/${vid}/revert`, { method: 'POST', body: JSON.stringify({ change_reason }) }),
  mock2ExportComponent: (id) => request(`/mock2/components/${id}/export`),
  mock2ImportComponent: (doc, change_reason) =>
    request('/mock2/components/import', { method: 'POST', body: JSON.stringify({ doc, change_reason }) }),
  mock2CreateComponentSubmission: (projectId, body) =>
    request(`/mock2/projects/${projectId}/component-submissions`, { method: 'POST', body: JSON.stringify(body) }),
  mock2ListProjectComponentSubmissions: (projectId) =>
    request(`/mock2/projects/${projectId}/component-submissions`),
  mock2ListComponentSubmissions: (status) =>
    request(`/mock2/component-submissions${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  mock2GetComponentSubmission: (id) => request(`/mock2/component-submissions/${id}`),
  mock2ReviewComponentSubmission: (id, body) =>
    request(`/mock2/component-submissions/${id}/review`, { method: 'POST', body: JSON.stringify(body) }),
  // Per-project component selection (migration 524): which library components a
  // project uses — suggested at define time, confirmed in chat, or picked here —
  // and the deterministic zero-token install.
  mock2ListProjectComponents: (projectId) =>
    request(`/mock2/projects/${projectId}/components`),
  mock2SelectProjectComponent: (projectId, { key, decision = 'confirmed', options } = {}) =>
    request(`/mock2/projects/${projectId}/components`, { method: 'POST', body: JSON.stringify({ key, decision, ...(options ? { options } : {}) }) }),
  mock2InstallProjectComponents: (projectId) =>
    request(`/mock2/projects/${projectId}/components/install`, { method: 'POST' }),
  // Ask lane: a codebase question / bounded read-and-run task in the build chat
  // (no build cycle). 202 + poll; the answer lands as a chat message.
  mock2Ask: (projectId, question, images = null) =>
    request(`/mock2/projects/${projectId}/ask`, {
      method: 'POST',
      body: JSON.stringify(images?.length ? { question, images } : { question }),
    }),
  mock2AskStatus: (projectId) => request(`/mock2/projects/${projectId}/ask/status`),

  // Model routing knowledge base (admin): the task-kind → model/effort
  // dictionary and the outcome evidence it is tuned against.
  mock2RoutingRules: () => request('/mock2/routing/rules'),
  mock2UpdateRoutingRule: (kind, body) =>
    request(`/mock2/routing/rules/${kind}`, { method: 'PATCH', body: JSON.stringify(body) }),
  mock2RoutingOutcomes: (kind) =>
    request(`/mock2/routing/outcomes${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`),

  // ---- Mock2 M6: cycle runner + checkout lock ----
  // mode: 'full' (default — audited build, whole gate battery) or 'mvp' (speed
  // path — rule interview skipped, reduced battery, fast model).
  mock2StartCycle: (id, instruction, images = null, mode = null) =>
    request(`/mock2/projects/${id}/cycles`, {
      method: 'POST',
      body: JSON.stringify({
        instruction,
        ...(images?.length ? { images } : {}),
        ...(mode ? { mode } : {}),
      }),
    }),
  mock2GetLatestCycle: (id) => request(`/mock2/projects/${id}/cycle`),
  mock2GetCycle: (id, cycleId) => request(`/mock2/projects/${id}/cycles/${cycleId}`),
  mock2ListCycles: (id) => request(`/mock2/projects/${id}/cycles`),
  mock2InterruptCycle: (id, cycleId, action) =>
    request(`/mock2/projects/${id}/cycles/${cycleId}/interrupt`, { method: 'POST', body: JSON.stringify({ action }) }),
  // Resume a stalled/blocked cycle. Optional { message, option } carries operator
  // guidance (a free-text message and/or a chosen halt resolution option) into the
  // resumed cycle. A bare call resumes with no new context.
  mock2RetryCycle: (id, cycleId, body = null) =>
    request(`/mock2/projects/${id}/cycles/${cycleId}/retry`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }),
  // "Explain this" — plain-language rewrite of a blocker/authorization/deviation/rule
  // card via the summary lane. Read-only; returns { ok, explanation } or { ok:false }.
  // With a `question` (+ optional `prior` explanation context) in the body it answers
  // an operator follow-up instead, returning { ok, answer }.
  mock2ExplainCard: (id, body) =>
    request(`/mock2/projects/${id}/explain`, { method: 'POST', body: JSON.stringify(body) }),
  // Scoped one-time authorizations (Part 4).
  mock2ListAuthorizations: (id) => request(`/mock2/projects/${id}/authorizations`),
  mock2DecideAuthorization: (id, authId, approved, conditions) =>
    request(`/mock2/projects/${id}/authorizations/${authId}/decision`, { method: 'POST', body: JSON.stringify({ approved, ...(conditions ? { conditions } : {}) }) }),
  // Redeploy the app from the existing checkpoint (install → migrate → build →
  // start → health) — no model calls, no gate battery. Works for a failed deploy
  // AND for restarting a finished build whose app stopped serving (502); the
  // cycle's terminal status is restored afterwards.
  mock2RetryDeploy: (id, cycleId) =>
    request(`/mock2/projects/${id}/cycles/${cycleId}/retry-deploy`, { method: 'POST' }),
  mock2StopAllCycles: () => request('/mock2/cycles/stop-all', { method: 'POST' }),
  mock2GetLock: (id) => request(`/mock2/projects/${id}/lock`),
  mock2RequestTakeover: (id) => request(`/mock2/projects/${id}/lock/takeover`, { method: 'POST' }),
  mock2ForceReleaseLock: (id) => request(`/mock2/projects/${id}/lock/force-release`, { method: 'POST' }),
  mock2GetChangeRecords: (id) => request(`/mock2/projects/${id}/change-records`),
  // Roll the project back to checkpoint `seq` (append-only: a NEW checkpoint
  // restores that point's code + database; the next build works off it).
  mock2RestoreCheckpoint: (id, seq) =>
    request(`/mock2/projects/${id}/restore`, { method: 'POST', body: JSON.stringify({ seq }) }),
  // Downloadable build transcript. THE log surface is per-REQUEST (one build
  // request = one merged, deduplicated log artifact, idempotent per content —
  // the same request always downloads as the same file); the per-cycle log
  // remains for legacy records whose cycle predates the request umbrella, and
  // the project log is the everything-export.
  mock2GetRequestLog: (id, requestId) => request(`/mock2/projects/${id}/requests/${requestId}/log`),
  mock2ListRequests: (id) => request(`/mock2/projects/${id}/requests`),
  mock2GetCycleLog: (id, cycleId) => request(`/mock2/projects/${id}/cycles/${cycleId}/log`),
  mock2SubmitCycleFeedback: (id, cycleId, body) =>
    request(`/mock2/projects/${id}/cycles/${cycleId}/feedback`, { method: 'POST', body: JSON.stringify(body) }),
  mock2GetProjectLog: (id) => request(`/mock2/projects/${id}/log`),
  mock2GetLockIdleMinutes: () => request('/mock2/settings/lock-idle-minutes'),
  mock2SetLockIdleMinutes: (minutes) =>
    request('/mock2/settings/lock-idle-minutes', { method: 'POST', body: JSON.stringify({ minutes }) }),

  // ---- Mock2 M7: Stage 1 (Concept) — chat, mockup, design approval ----
  mock2GetChat: (id) => request(`/mock2/projects/${id}/chat`),
  mock2SendChatMessage: (id, message, mode, images = null) =>
    request(`/mock2/projects/${id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message, ...(mode ? { mode } : {}), ...(images?.length ? { images } : {}) }),
    }),
  mock2ApproveDesign: (id) =>
    request(`/mock2/projects/${id}/design/approve`, { method: 'POST' }),
  // Design template — the design/mockup only (mockup HTML + original brief +
  // conversation + tokens), never code. Export returns the portable JSON doc
  // (the caller blob-downloads it); import seeds THIS project's Concept stage
  // from an uploaded doc ({ doc }) or another project ({ source_project_id }),
  // with optional { notes } (changes/context carried into the initial build).
  mock2ExportDesignTemplate: (id) => request(`/mock2/projects/${id}/design-template`),
  mock2ImportDesignTemplate: (id, body) =>
    request(`/mock2/projects/${id}/design-template/import`, { method: 'POST', body: JSON.stringify(body) }),
  // Integration truthfulness (AUDIT.md; B.4/B.5/B.6): the reported outcome, the
  // pending-operator-verification checklist, active confirmations, open findings,
  // and the operator confirm/waive action (an observed result is required).
  mock2GetIntegrationStatus: (id) => request(`/mock2/projects/${id}/integration-status`),
  mock2VerifyIntegrationItem: (id, cycleId, body) =>
    request(`/mock2/projects/${id}/cycles/${cycleId}/verify`, { method: 'POST', body: JSON.stringify(body) }),
  // PATCH2 B.2 — confirm/waive a capability's live check independently of any
  // build cycle (verification is a property of the capability's lifecycle).
  mock2VerifyCapabilityCheck: (id, body) =>
    request(`/mock2/projects/${id}/capability-checks/verify`, { method: 'POST', body: JSON.stringify(body) }),
  // Operator reports a live capability check FAILED against the real system —
  // records the observation (append-only) and opens a REAL bug-fix build
  // carrying it (the pending-verification lifecycle's failure branch).
  mock2ReportCapabilityFailure: (id, body) =>
    request(`/mock2/projects/${id}/capability-checks/report-failure`, { method: 'POST', body: JSON.stringify(body) }),
  // Operator DEFERS a live check — can't verify it in this environment right now
  // (no route to the endpoint, app not deployed/reachable, no credentials). Records
  // an honest note and leaves the build calmly pending; no false confirm, no
  // bug-fix build. body: { item_id, reason }.
  mock2DeferCapabilityCheck: (id, body) =>
    request(`/mock2/projects/${id}/capability-checks/defer`, { method: 'POST', body: JSON.stringify(body) }),
  // Admin escape hatch: release EVERY outstanding live capability check at once
  // (recorded as admin waivers) and advance the pending build(s) to succeeded —
  // the guaranteed way out of pending-operator-verification. body: { reason? }.
  mock2ReleaseCapabilityChecks: (id, body = {}) =>
    request(`/mock2/projects/${id}/capability-checks/release`, { method: 'POST', body: JSON.stringify(body) }),
  // Self-heal a malformed state/integrations.json: archive the broken text,
  // salvage valid entries, write a valid scaffold, resume any blocked cycle.
  mock2RepairIntegrationManifest: (id) =>
    request(`/mock2/projects/${id}/integrations/repair-manifest`, { method: 'POST' }),
  // PATCH — blocked-deviation resolution: the class-matched options for a blocked
  // cycle, the manifest-backfill (declare an undeclared capability, editor), and
  // the analysis-limitation waiver (admin, provenance-not-established only).
  mock2GetCycleResolutions: (id, cycleId) => request(`/mock2/projects/${id}/cycles/${cycleId}/resolutions`),
  mock2BackfillManifest: (id, cycleId, entry, reason) =>
    request(`/mock2/projects/${id}/cycles/${cycleId}/backfill-manifest`, { method: 'POST', body: JSON.stringify(reason ? { entry, reason } : { entry }) }),
  mock2WaiveProvenance: (id, cycleId, body) =>
    request(`/mock2/projects/${id}/cycles/${cycleId}/waive-provenance`, { method: 'POST', body: JSON.stringify(body) }),

  // ---- Mock2 M8: audit, rule questions, admin queue ----
  mock2ListQuestions: (id) => request(`/mock2/projects/${id}/questions`),
  mock2AnswerQuestion: (id, qid, answer) =>
    request(`/mock2/projects/${id}/questions/${qid}/answer`, { method: 'POST', body: JSON.stringify({ answer }) }),
  mock2ListQueue: ({ project_id, kind, status } = {}) => {
    const qs = new URLSearchParams();
    if (project_id != null && project_id !== '') qs.set('project_id', project_id);
    if (kind) qs.set('kind', kind);
    if (status) qs.set('status', status);
    const q = qs.toString();
    return request(`/mock2/queue${q ? `?${q}` : ''}`);
  },
  mock2QueueCounts: () => request('/mock2/queue/counts'),
  // resolution is the short note; editedText/conditions drive "approve as edited"
  // (the edited deviation text becomes the authoritative APPROVED record).
  mock2SetQueueItemStatus: (itemId, status, resolution, extra = {}) =>
    request(`/mock2/queue/${itemId}/status`, { method: 'POST', body: JSON.stringify({ status, resolution, ...extra }) }),

  listCves: () => request('/cves'),
  getCve: (cveId) => request(`/cves/${encodeURIComponent(cveId)}`),
  markCveSeen: (cveId) =>
    request(`/cves/${encodeURIComponent(cveId)}/seen`, { method: 'POST' }),
  dismissCve: (cveId, reason) =>
    request(`/cves/${encodeURIComponent(cveId)}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  runCve: (cveId, body = {}) =>
    request(`/cves/${encodeURIComponent(cveId)}/run`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Probe-only check — admin-only, NOT sudo-gated. Returns the
  // verdict ("affected" / "not_affected" / "no_probe") plus the
  // probe's stdout/stderr.
  checkCve: (cveId) =>
    request(`/cves/${encodeURIComponent(cveId)}/check`, { method: 'POST' }),
  // Pins — per-user UI state. PUT pins (and updates the note);
  // DELETE unpins.
  pinCve: (cveId, note) =>
    request(`/cves/${encodeURIComponent(cveId)}/pin`, {
      method: 'PUT',
      body: JSON.stringify(note ? { note } : {}),
    }),
  unpinCve: (cveId) =>
    request(`/cves/${encodeURIComponent(cveId)}/pin`, { method: 'DELETE' }),

  // Operator-managed inbox writes. The backend extracts the cve id
  // from the YAML body, so the paste flow never needs to think about
  // filenames; saveCveEdit pins the URL id to catch typos. Both go
  // through the engine's `validate` subcommand server-side.
  pasteCve: (content) =>
    request('/cves', { method: 'POST', body: JSON.stringify({ content }) }),
  saveCveEdit: (cveId, content) =>
    request(`/cves/${encodeURIComponent(cveId)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  deleteCve: (cveId) =>
    request(`/cves/${encodeURIComponent(cveId)}`, { method: 'DELETE' }),

  // AI research routine — native replacement for a manual external
  // research session. GET never returns the plaintext key, only
  // has_api_key. api_key is optional on the PUT: omit/blank to keep
  // whatever's already stored.
  getCveResearchConfig: () => request('/cves/research/config'),
  // { mock2_enabled, connectors: [{id, name, provider, base_url}] } —
  // connectors already configured under Projects that could be reused
  // here instead of pasting a key twice. Empty when Projects is off.
  getCveResearchConnectors: () => request('/cves/research/connectors'),
  updateCveResearchConfig: (body) =>
    request('/cves/research/config', { method: 'PUT', body: JSON.stringify(body) }),
  testCveResearchConnector: () =>
    request('/cves/research/test', { method: 'POST' }),
  runCveResearchNow: () =>
    request('/cves/research/run-now', { method: 'POST' }),
  // Recent research run reports, newest first: { runs: [{at, trigger, ok,
  // error, created, updated, tool_errors, fetches, tokens, turns,
  // duration_s, summary}] }.
  getCveResearchRuns: () => request('/cves/research/runs'),
  // Live run state { busy, started_at, trigger } — run-now returns 202
  // immediately, so the page polls this until the pass finishes.
  getCveResearchStatus: () => request('/cves/research/status'),

  // Housekeeping — disk-usage view (docker df + backup dir) plus
  // opt-in prune actions for stale artifacts. Pruning is sudo-gated
  // and per-category — empty body = no-op.
  housekeepingUsage: () => request('/housekeeping/usage'),
  housekeepingPrune: (body) =>
    request('/housekeeping/prune', { method: 'POST', body: JSON.stringify(body) }),

  // Backups → Storage tab. CRUD on S3-compatible destinations + a
  // 'test connection' verb that HEADs the configured bucket.
  // secret_key is write-only — the GET path never returns it.
  // Server enforces 'at most one default'; clients can mark a
  // different row default and the previous one flips off.
  backupsListStorage: () => request('/backups/storage'),
  backupsCreateStorage: (body) =>
    request('/backups/storage', { method: 'POST', body: JSON.stringify(body) }),
  backupsUpdateStorage: (id, body) =>
    request(`/backups/storage/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(body),
    }),
  backupsDeleteStorage: (id) =>
    request(`/backups/storage/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  backupsTestStorage: (id) =>
    request(`/backups/storage/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  // Run the daily-S3 probe against every destination now.  Same
  // code path as the cron task; failures post notifications.
  backupsRunS3Healthcheck: () =>
    request('/backups/storage/healthcheck', { method: 'POST' }),
  // Bucket browser: list every object under the destination's
  // path_prefix, with linked-to-backup annotations.
  backupsListStorageObjects: (id) =>
    request(`/backups/storage/${encodeURIComponent(id)}/objects`),
  backupsDeleteStorageObject: (id, key) =>
    request(`/backups/storage/${encodeURIComponent(id)}/objects`, {
      method: 'DELETE',
      body: JSON.stringify({ key }),
    }),
  backupsSetDefaultStorage: (id) =>
    request(`/backups/storage/${encodeURIComponent(id)}/default`, { method: 'POST' }),

  // Backups → Backups tab. PR 1 ships create / list / show /
  // download / delete on the config tier; PR 2 adds tiers,
  // schedules, and restore.
  backupsList: () => request('/backups'),
  backupsGet: (id) => request(`/backups/${encodeURIComponent(id)}`),
  backupsCreate: (body) =>
    request('/backups', { method: 'POST', body: JSON.stringify(body) }),
  // backupsDelete — body is optional for back-compat with PR-1
  // call sites that just want both copies gone (the server-side
  // default).  Local-first UI passes { delete_local, delete_s3 }
  // booleans so the operator can keep one copy.
  backupsDelete: (id, body) =>
    request(`/backups/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify(body || {}),
    }),
  // Rehydrate the local copy from S3.  Used when retention
  // pruned the on-disk file but the operator wants fast
  // download / restore again.  4xx if the row has no S3 copy.
  backupsPullLocal: (id) =>
    request(`/backups/${encodeURIComponent(id)}/pull-local`, { method: 'POST' }),
  // Download is a plain anchor href — the backend streams an
  // application/octet-stream with Content-Disposition. Resolved as
  // a path so callers can drop it into <a href={...}> directly.
  backupsDownloadHref: (id) => `${API_BASE}/backups/${encodeURIComponent(id)}/download`,

  // PR 2: schedules + restore + usage + health classes.
  backupsUsage: () => request('/backups/usage'),
  backupsListSchedules: () => request('/backups/schedules'),
  backupsCreateSchedule: (body) =>
    request('/backups/schedules', { method: 'POST', body: JSON.stringify(body) }),
  backupsUpdateSchedule: (id, body) =>
    request(`/backups/schedules/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(body),
    }),
  backupsDeleteSchedule: (id) =>
    request(`/backups/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  backupsRunScheduleNow: (id) =>
    request(`/backups/schedules/${encodeURIComponent(id)}/run-now`, { method: 'POST' }),
  backupsRestore: (id, body) =>
    request(`/backups/${encodeURIComponent(id)}/restore`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  backupsListRestores: () => request('/backups/restores'),
  backupsGetRestore: (id) => request(`/backups/restores/${encodeURIComponent(id)}`),
  backupsHealthClasses: () => request('/backups/health-classes'),
  // Scope options for the per-service backup scope picker.
  // Returns one row per registered service with kind / runtime
  // metadata so the picker can render a meaningful multi-select.
  backupsScopeOptions: () => request('/backups/scope-options'),

  // Notifications — durable bell-dropdown entries posted by
  // backend code (cron failures, S3 health-check, ...).  In-
  // session toasts still flow through use-toast.js; the bell
  // surfaces both layers.
  notificationsList: ({ includeDismissed = false } = {}) =>
    request(`/notifications${includeDismissed ? '?include_dismissed=1' : ''}`),
  notificationsUnreadCount: () => request('/notifications/unread-count'),
  notificationsMarkRead: (id) =>
    request(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  notificationsMarkAllRead: () =>
    request('/notifications/mark-all-read', { method: 'POST' }),
  notificationsDismiss: (id) =>
    request(`/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Out-of-band notification channels (SMTP + SMS) — admin "standard
  // connections" that fan alerts beyond the in-app bell. Secrets are write-only:
  // the list never echoes them, so a save omits `secret` to keep the stored one.
  notificationChannelsList: () => request('/notifications/channels'),
  notificationChannelSave: (kind, { enabled, config, secret }) =>
    request(`/notifications/channels/${encodeURIComponent(kind)}`, {
      method: 'PUT', body: JSON.stringify({ enabled, config, secret }),
    }),
  notificationChannelDelete: (kind) =>
    request(`/notifications/channels/${encodeURIComponent(kind)}`, { method: 'DELETE' }),
  notificationChannelTest: (kind) =>
    request(`/notifications/channels/${encodeURIComponent(kind)}/test`, { method: 'POST' }),

  uploadFileToContainer: async (name, destPath, file) => {
    const csrf = readCookie('pp_csrf');
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(`${API_BASE}/lxc/containers/${name}/files/upload?path=${encodeURIComponent(destPath)}`, {
      method: 'POST',
      credentials: 'include',
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.error || 'Upload failed', response.status, data);
    return data;
  },
};

export { ApiError };
