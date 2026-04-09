import http from 'node:http';
import { getConfig } from '../config.js';

/**
 * Low-level Incus REST API request over Unix domain socket.
 * Parses the JSON response and rejects on Incus error responses.
 *
 * @param {string} method - HTTP method (GET, POST, PUT, PATCH, DELETE)
 * @param {string} path - API path (e.g. /1.0/instances)
 * @param {object} [body] - Optional request body (will be JSON-serialized)
 * @returns {Promise<object>} Parsed Incus API response
 */
export function incusRequest(method, path, body) {
  const config = getConfig();
  const socketPath = config.incus.socket;

  return new Promise((resolve, reject) => {
    const options = {
      socketPath,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'error') {
            reject(
              new Error(
                `Incus API error ${parsed.error_code}: ${parsed.error}`,
              ),
            );
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(
            new Error(
              `Failed to parse Incus response: ${data.substring(0, 200)}`,
            ),
          );
        }
      });
    });

    req.on('error', (e) => {
      if (e.code === 'ENOENT') {
        reject(
          new Error(
            `Incus socket not found at ${socketPath}. Is Incus installed and running?`,
          ),
        );
      } else if (e.code === 'EACCES') {
        reject(
          new Error(
            `Permission denied accessing Incus socket. Try running with sudo or add user to incus-admin group.`,
          ),
        );
      } else {
        reject(new Error(`Incus connection error: ${e.message}`));
      }
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Make an Incus API request and, if the response is async, wait for the
 * background operation to complete before returning.
 *
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {object} [body] - Optional request body
 * @returns {Promise<object>} Final operation result
 */
export async function incusRequestAndWait(method, path, body) {
  const response = await incusRequest(method, path, body);

  if (response.type === 'async') {
    const opId = response.metadata.id;
    const result = await incusRequest('GET', `/1.0/operations/${opId}/wait`);
    if (result.metadata && result.metadata.status === 'Failure') {
      throw new Error(
        `Incus operation failed: ${result.metadata.err || 'unknown error'}`,
      );
    }
    return result;
  }

  return response;
}

// ---------------------------------------------------------------------------
// Instance operations
// ---------------------------------------------------------------------------

/**
 * List all instances with full details (recursion=1).
 * @returns {Promise<object[]>} Array of instance objects
 */
export async function listInstances() {
  const res = await incusRequest('GET', '/1.0/instances?recursion=1');
  return res.metadata;
}

/**
 * Get a single instance by name.
 * @param {string} name
 * @returns {Promise<object>} Instance metadata
 */
export async function getInstance(name) {
  const res = await incusRequest('GET', `/1.0/instances/${encodeURIComponent(name)}`);
  return res.metadata;
}

/**
 * Get the live state (CPU, memory, network, disk) of an instance.
 * @param {string} name
 * @returns {Promise<object>} Instance state
 */
export async function getInstanceState(name) {
  const res = await incusRequest('GET', `/1.0/instances/${encodeURIComponent(name)}/state`);
  return res.metadata;
}

/**
 * Create a new instance and wait for the operation to complete.
 * @param {object} config - Instance creation config (name, source, etc.)
 * @returns {Promise<object>} Operation result
 */
export async function createInstance(config) {
  return incusRequestAndWait('POST', '/1.0/instances', config);
}

/**
 * Partially update an instance configuration (PATCH merge).
 * @param {string} name
 * @param {object} config - Fields to merge
 * @returns {Promise<object>}
 */
export async function updateInstance(name, config) {
  return incusRequest('PATCH', `/1.0/instances/${encodeURIComponent(name)}`, config);
}

/**
 * Delete an instance and wait for the operation to complete.
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function deleteInstance(name) {
  return incusRequestAndWait('DELETE', `/1.0/instances/${encodeURIComponent(name)}`);
}

/**
 * Change the running state of an instance (start, stop, restart, freeze, unfreeze).
 * @param {string} name
 * @param {string} action - One of: start, stop, restart, freeze, unfreeze
 * @param {boolean} [force=false]
 * @param {number} [timeout=30] - Seconds to wait
 * @returns {Promise<object>}
 */
export async function setInstanceState(name, action, force = false, timeout = 30) {
  return incusRequestAndWait(
    'PUT',
    `/1.0/instances/${encodeURIComponent(name)}/state`,
    { action, force, timeout },
  );
}

// ---------------------------------------------------------------------------
// Snapshot operations
// ---------------------------------------------------------------------------

/**
 * Create a snapshot of an instance.
 * @param {string} instanceName
 * @param {string} snapshotName
 * @returns {Promise<object>}
 */
export async function createSnapshot(instanceName, snapshotName) {
  return incusRequestAndWait(
    'POST',
    `/1.0/instances/${encodeURIComponent(instanceName)}/snapshots`,
    { name: snapshotName },
  );
}

/**
 * List all snapshots for an instance.
 * @param {string} instanceName
 * @returns {Promise<object[]>}
 */
export async function listSnapshots(instanceName) {
  const res = await incusRequest(
    'GET',
    `/1.0/instances/${encodeURIComponent(instanceName)}/snapshots?recursion=1`,
  );
  return res.metadata;
}

/**
 * Delete a specific snapshot.
 * @param {string} instanceName
 * @param {string} snapshotName
 * @returns {Promise<object>}
 */
export async function deleteSnapshot(instanceName, snapshotName) {
  return incusRequestAndWait(
    'DELETE',
    `/1.0/instances/${encodeURIComponent(instanceName)}/snapshots/${encodeURIComponent(snapshotName)}`,
  );
}

/**
 * Restore an instance to a previous snapshot.
 * @param {string} instanceName
 * @param {string} snapshotName
 * @returns {Promise<object>}
 */
export async function restoreSnapshot(instanceName, snapshotName) {
  return incusRequestAndWait(
    'PUT',
    `/1.0/instances/${encodeURIComponent(instanceName)}`,
    { restore: snapshotName },
  );
}

// ---------------------------------------------------------------------------
// Image / template operations
// ---------------------------------------------------------------------------

/**
 * Publish a container as an image with optional aliases.
 * @param {string} instanceName
 * @param {string[]} aliases - Array of alias strings
 * @returns {Promise<object>}
 */
export async function publishImage(instanceName, aliases) {
  const aliasObjects = (aliases || []).map((a) => ({ name: a }));
  return incusRequestAndWait('POST', '/1.0/images', {
    source: {
      type: 'instance',
      name: instanceName,
    },
    aliases: aliasObjects,
  });
}

/**
 * List all images.
 * @returns {Promise<object[]>}
 */
export async function listImages() {
  const res = await incusRequest('GET', '/1.0/images?recursion=1');
  return res.metadata;
}

/**
 * Delete an image by fingerprint.
 * @param {string} fingerprint
 * @returns {Promise<object>}
 */
export async function deleteImage(fingerprint) {
  return incusRequestAndWait('DELETE', `/1.0/images/${encodeURIComponent(fingerprint)}`);
}

/**
 * Resolve an image alias to its target image metadata.
 * @param {string} alias
 * @returns {Promise<object>}
 */
export async function getImageByAlias(alias) {
  const res = await incusRequest('GET', `/1.0/images/aliases/${encodeURIComponent(alias)}`);
  return res.metadata;
}

// ---------------------------------------------------------------------------
// Network operations
// ---------------------------------------------------------------------------

/**
 * List all networks.
 * @returns {Promise<object[]>}
 */
export async function listNetworks() {
  const res = await incusRequest('GET', '/1.0/networks');
  return res.metadata;
}

/**
 * Get details of a specific network.
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function getNetwork(name) {
  const res = await incusRequest('GET', `/1.0/networks/${encodeURIComponent(name)}`);
  return res.metadata;
}

/**
 * Create a new network.
 * @param {string} name
 * @param {object} config - Network configuration
 * @returns {Promise<object>}
 */
export async function createNetwork(name, config) {
  return incusRequest('POST', '/1.0/networks', { name, ...config });
}

/**
 * Delete a network.
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function deleteNetwork(name) {
  return incusRequest('DELETE', `/1.0/networks/${encodeURIComponent(name)}`);
}

// ---------------------------------------------------------------------------
// Storage pool operations
// ---------------------------------------------------------------------------

/**
 * List all storage pools.
 * @returns {Promise<object[]>}
 */
export async function listStoragePools() {
  const res = await incusRequest('GET', '/1.0/storage-pools');
  return res.metadata;
}

/**
 * Get details of a specific storage pool.
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function getStoragePool(name) {
  const res = await incusRequest('GET', `/1.0/storage-pools/${encodeURIComponent(name)}`);
  return res.metadata;
}

/**
 * Create a new storage pool.
 * @param {string} name
 * @param {string} driver - Storage driver (dir, btrfs, zfs, lvm, ceph)
 * @param {object} config - Pool configuration
 * @returns {Promise<object>}
 */
export async function createStoragePool(name, driver, config) {
  return incusRequest('POST', '/1.0/storage-pools', {
    name,
    driver,
    config: config || {},
  });
}

// ---------------------------------------------------------------------------
// Profile operations (Incus profiles, not ProxyPilot resource profiles)
// ---------------------------------------------------------------------------

/**
 * List all Incus profiles.
 * @returns {Promise<object[]>}
 */
export async function listProfiles() {
  const res = await incusRequest('GET', '/1.0/profiles');
  return res.metadata;
}

/**
 * Get a specific Incus profile.
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function getProfile(name) {
  const res = await incusRequest('GET', `/1.0/profiles/${encodeURIComponent(name)}`);
  return res.metadata;
}

/**
 * Create a new Incus profile.
 * @param {string} name
 * @param {object} config - Profile configuration
 * @returns {Promise<object>}
 */
export async function createProfile(name, config) {
  return incusRequest('POST', '/1.0/profiles', { name, ...config });
}

/**
 * Replace an Incus profile configuration.
 * @param {string} name
 * @param {object} config - Full profile configuration
 * @returns {Promise<object>}
 */
export async function updateProfile(name, config) {
  return incusRequest('PUT', `/1.0/profiles/${encodeURIComponent(name)}`, config);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Check whether the Incus daemon is reachable.
 * @returns {Promise<boolean>}
 */
export async function checkConnection() {
  try {
    await incusRequest('GET', '/1.0');
    return true;
  } catch {
    return false;
  }
}
