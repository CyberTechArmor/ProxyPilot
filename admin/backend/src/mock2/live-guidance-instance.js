// The process's live-guidance instance, wired to the real boundaries: the data
// dir (MOCK2_DATA_DIR/guidance), the live_guidance setting (mock2.db), the pinned
// standards source (mcp.standards_source_url in app settings, else the seed's
// manifest), and the framework seed-upgrade path as the publisher. Loaded only on
// an enabled host (index.js boot, the mock2 router, the MCP standards tools).

import { join } from 'node:path';
import { getSetting } from '../db.js';
import { readStandardsSeedVersion } from '../lib/self-update.js';
import { STANDARDS_MANIFEST_URL } from '../lib/self-update-logic.js';
import { getLiveGuidanceSetting } from './settings.js';
import { upgradeFrameworkFromSeed } from './framework.js';
import { createLiveGuidance, LIVE_GUIDANCE_INTERVAL_MS } from './live-guidance.js';

export const STANDARDS_SOURCE_KEY = 'mcp.standards_source_url';
// Same default as provision.js / chat-images.js (not imported: provision.js pulls in the whole provisioner).
export const LIVE_GUIDANCE_DIR = join(process.env.MOCK2_DATA_DIR || '/var/lib/proxypilot/mock2', 'guidance');

/** The pinned standards manifest URL: the operator's setting, else the seed default. */
export function standardsSourceUrl() {
  let pinned = null;
  try { pinned = getSetting(STANDARDS_SOURCE_KEY) || null; } catch { pinned = null; }
  return pinned || readStandardsSeedVersion().manifest || STANDARDS_MANIFEST_URL;
}

export const liveGuidance = createLiveGuidance({
  dataDir: LIVE_GUIDANCE_DIR,
  isEnabled: getLiveGuidanceSetting,
  sourceUrl: standardsSourceUrl,
  publish: (active) => upgradeFrameworkFromSeed(null, active),
});

export { LIVE_GUIDANCE_INTERVAL_MS };
