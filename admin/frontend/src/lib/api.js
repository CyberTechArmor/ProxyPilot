const API_BASE = '/api';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
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

  if (response.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
    throw new ApiError('Session expired', 401);
  }

  const data = await response.json();

  if (!response.ok) {
    throw new ApiError(data.error || 'Request failed', response.status);
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

  checkSslStatus: (domain) => request(`/services/ssl-status/${domain}`),

  regenerateConfig: (serviceId) => request(`/services/${serviceId}/regenerate-config`, {
    method: 'POST',
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
};

export { ApiError };
