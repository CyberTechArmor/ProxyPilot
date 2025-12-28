const API_BASE = '/api';

class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    // Pass through any additional fields from the response
    Object.assign(this, data);
  }
}

async function request(endpoint, options = {}) {
  const token = localStorage.getItem('token');

  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  const data = await response.json();

  if (response.status === 401) {
    // Don't redirect if this is a login attempt requiring TOTP or TOTP setup
    if (data.totpRequired || data.totpSetupRequired) {
      throw new ApiError(data.error || 'TOTP required', 401, data);
    }
    localStorage.removeItem('token');
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

  verify: () => request('/auth/verify'),

  logout: () => request('/auth/logout', { method: 'POST' }),

  // Services
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

  deleteService: (id, totpCode) => request(`/services/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ totpCode }),
  }),

  toggleFavorite: (id) => request(`/services/${id}/favorite`, {
    method: 'POST',
  }),

  getDockerContainers: () => request('/services/docker/containers'),

  // NGINX
  reloadNginx: () => request('/services/nginx/reload', {
    method: 'POST',
  }),

  regenerateAllConfigs: () => request('/services/nginx/regenerate-all', {
    method: 'POST',
  }),

  checkSslStatus: (domain) => request(`/services/ssl-status/${domain}`),

  regenerateConfig: (serviceId) => request(`/services/${serviceId}/regenerate-config`, {
    method: 'POST',
  }),

  obtainCertificate: (serviceId) => request(`/services/${serviceId}/obtain-certificate`, {
    method: 'POST',
  }),

  removeCertificate: (serviceId, totpCode) => request(`/services/${serviceId}/certificate`, {
    method: 'DELETE',
    body: JSON.stringify({ totpCode }),
  }),

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

  dockerComposeDestroy: (path, totpCode, options = {}) => request('/services/docker/compose/destroy', {
    method: 'POST',
    body: JSON.stringify({ path, totpCode, options }),
  }),

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

  // System Security
  secureSystem: (totpCode) => request('/services/system/secure', {
    method: 'POST',
    body: JSON.stringify({ totpCode }),
  }),

  // Discover existing sites
  discoverNginxSites: () => request('/services/discover/nginx-sites'),

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

  deleteUser: (id, totpCode) => request(`/user/users/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ totpCode }),
  }),

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

  // Version and Update
  getVersion: () => request('/user/version'),

  checkForUpdates: () => request('/user/version/check'),

  updateGithubRepo: (githubRepo) => request('/user/settings/github-repo', {
    method: 'PUT',
    body: JSON.stringify({ githubRepo }),
  }),

  dismissUpdate: (version) => request('/user/version/dismiss', {
    method: 'POST',
    body: JSON.stringify({ version }),
  }),

  resetDismissUpdate: () => request('/user/version/reset-dismiss', {
    method: 'POST',
  }),

  performUpdate: () => request('/user/version/update', {
    method: 'POST',
  }),

  getUpdateProgress: () => request('/user/version/update/progress'),

  resetUpdateStatus: () => request('/user/version/update/reset', {
    method: 'POST',
  }),
};

export { ApiError };
