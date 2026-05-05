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

  const data = await response.json();

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

  deleteUser: (id, totpOrPayload) => {
    const body = typeof totpOrPayload === 'string'
      ? { totpCode: totpOrPayload }
      : (totpOrPayload || {});
    return request(`/user/users/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    });
  },

  getUserAccess: (id) => request(`/user/users/${id}/access`),

  updateUserAccess: (id, access) => request(`/user/users/${id}/access`, {
    method: 'PUT',
    body: JSON.stringify({ access }),
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

  createLxcSnapshot: (name, snapshotName, note) => request(`/lxc/containers/${name}/snapshot`, {
    method: 'POST',
    body: JSON.stringify({ snapshotName, note }),
  }),

  // Poll an in-flight snapshot job kicked off by createLxcSnapshot.
  // Returns { status, elapsedMs, estimateMs, error? }.
  getLxcSnapshotJob: (name, jobId) => request(`/lxc/containers/${name}/snapshot-jobs/${jobId}`),

  restoreLxcSnapshot: (name, snapshotName) => request(`/lxc/containers/${name}/snapshot/${snapshotName}/restore`, {
    method: 'POST',
  }),

  deleteLxcSnapshot: (name, snapshotName) => request(`/lxc/containers/${name}/snapshot/${snapshotName}`, {
    method: 'DELETE',
  }),

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
  pollCves: () => request('/cves/poll', { method: 'POST' }),

  // Read-only git source. Operators set a repo URL via PUT; the
  // engine pulls + imports new specs on POST /git-sync. Sync is
  // additive — existing entries (paste OR git from a different URL)
  // are never overwritten.
  getCveGitConfig: () => request('/cves/git-config'),
  setCveGitConfig: (url) =>
    request('/cves/git-config', {
      method: 'PUT',
      body: JSON.stringify({ url: (url || '').trim() }),
    }),
  syncCveGit: () => request('/cves/git-sync', { method: 'POST' }),

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
