import { getConfig } from '../config.js';
import { createNetwork, getNetwork } from '../incus/client.js';

// ---------------------------------------------------------------------------
// IP address arithmetic helpers
// ---------------------------------------------------------------------------

/**
 * Convert a dotted-quad IPv4 string to a 32-bit unsigned integer.
 * @param {string} ip - e.g. "10.0.100.1"
 * @returns {number}
 */
function ipToInt(ip) {
  return (
    ip
      .split('.')
      .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
  );
}

/**
 * Convert a 32-bit unsigned integer to a dotted-quad IPv4 string.
 * @param {number} int
 * @returns {string}
 */
function intToIp(int) {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255,
  ].join('.');
}

// ---------------------------------------------------------------------------
// Bridge setup
// ---------------------------------------------------------------------------

/**
 * Create the ProxyPilot managed bridge network in Incus.
 *
 * Called during `proxypilot init`.  Creates a bridge with NAT enabled and
 * DHCP disabled (ProxyPilot allocates static IPs itself).
 *
 * @returns {Promise<object>} Incus API response
 */
export async function setupBridge() {
  const config = getConfig();
  const bridgeName = config.network.bridge_name;
  const gateway = config.network.gateway;
  const cidr = config.network.cidr;

  // Derive the prefix length from the CIDR (e.g. "10.0.100.0/24" -> "24")
  const prefixLen = cidr.split('/')[1] || '24';

  return createNetwork(bridgeName, {
    type: 'bridge',
    config: {
      'ipv4.address': `${gateway}/${prefixLen}`,
      'ipv4.nat': 'true',
      'ipv4.dhcp': 'false',
      'ipv6.address': 'none',
    },
  });
}

// ---------------------------------------------------------------------------
// IP allocation
// ---------------------------------------------------------------------------

/**
 * Allocate the next available IP address from the configured range.
 *
 * Reads all `bridge_ip` values currently stored in the `containers` table,
 * then iterates from `dhcp_range_start` to `dhcp_range_end` and returns the
 * first address that is not already in use.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string} The allocated IP address (e.g. "10.0.100.10")
 * @throws {Error} If the IP pool is exhausted
 */
export function allocateIP(db) {
  const config = getConfig();
  const rangeStart = config.network.dhcp_range_start;
  const rangeEnd = config.network.dhcp_range_end;

  // Gather all IPs currently assigned to containers
  const rows = db
    .prepare('SELECT bridge_ip FROM containers WHERE bridge_ip IS NOT NULL')
    .all();
  const usedIPs = new Set(rows.map((r) => r.bridge_ip));

  const startInt = ipToInt(rangeStart);
  const endInt = ipToInt(rangeEnd);

  for (let current = startInt; current <= endInt; current++) {
    const candidate = intToIp(current);
    if (!usedIPs.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `IP pool exhausted. No available addresses between ${rangeStart} and ${rangeEnd}.`,
  );
}

/**
 * Release an IP address.
 *
 * This is effectively a no-op because IPs are tracked in the `containers`
 * table and freed when the container row is removed.  The function validates
 * that the given IP falls within the managed range.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} ip
 * @returns {boolean} true if the IP was within the managed range
 */
export function releaseIP(db, ip) {
  const config = getConfig();
  const ipInt = ipToInt(ip);
  const startInt = ipToInt(config.network.dhcp_range_start);
  const endInt = ipToInt(config.network.dhcp_range_end);

  if (ipInt < startInt || ipInt > endInt) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Bridge existence check
// ---------------------------------------------------------------------------

/**
 * Check whether the ProxyPilot bridge network already exists in Incus.
 * @returns {Promise<boolean>}
 */
export async function bridgeExists() {
  const config = getConfig();
  const bridgeName = config.network.bridge_name;

  try {
    await getNetwork(bridgeName);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Device config helper
// ---------------------------------------------------------------------------

/**
 * Build the Incus devices configuration to attach an instance to the
 * ProxyPilot bridge with a static IPv4 address.
 *
 * @param {string} bridgeIP - The static IP to assign (e.g. "10.0.100.10")
 * @returns {object} Devices configuration object for Incus instance creation
 */
export function getBridgeDeviceConfig(bridgeIP) {
  const config = getConfig();
  const bridgeName = config.network.bridge_name;

  return {
    eth0: {
      type: 'nic',
      network: bridgeName,
      'ipv4.address': bridgeIP,
      name: 'eth0',
    },
  };
}
