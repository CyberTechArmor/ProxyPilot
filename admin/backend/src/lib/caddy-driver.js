// Dual-track driver for Caddy operations. Phase B exposes
// caddyAdapt() and caddyReload() as the single seam between the
// backend and the host's Caddy binary; the path through the seam
// is selected at call time by the PROXYPILOT_USE_AGENT_FOR_CADDY
// env var:
//
//   flag === 'true'   → call into the host-side proxypilot-agent
//                       via lib/agent.js (caddy.adapt / caddy.reload).
//   anything else     → existing nsenter-based execOnHost path,
//                       byte-identical to what services.js used to
//                       inline at every call site.
//
// Both paths throw on failure with an .stderr-bearing error so
// every existing `try { await execOnHost('caddy …') } catch (e)
// { e.stderr || e.message }` block in routes/services.js works
// untouched.
//
// Phase B keeps the flag default-OFF. Phase F is what flips defaults
// to ON after burn-in — NOT this commit.

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { agentCall, AgentError } from './agent.js';

const execAsync = promisify(exec);

const CADDY_CONFIG_FILE = process.env.CADDY_CONFIG_FILE || '/etc/caddy/Caddyfile';
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

function useAgent() {
  return process.env.PROXYPILOT_USE_AGENT_FOR_CADDY === 'true';
}

// Local execOnHost — same shape as the copies in routes/services.js
// and the five other route files. Phase B is not consolidating those
// (separate, broader refactor); keeping this driver self-contained
// avoids depending on a router module from a lib module.
async function execOnHost(command, { timeout = 30000 } = {}) {
  if (isInDocker) {
    const hostCommand = `nsenter -t 1 -m -u -n -i sh -c ${JSON.stringify(command)}`;
    return execAsync(hostCommand, { timeout });
  }
  return execAsync(command, { timeout });
}

// Convert a structured agent failure into an Error shape that
// matches execAsync's failure contract. Callers in services.js read
// `.stderr` and `.message` off the caught error — preserving that
// surface keeps the migration a pure relocation rather than a
// rewrite.
function asExecLikeError(prefix, stderr) {
  const detail = (stderr || '').trim();
  const err = new Error(detail ? `${prefix}: ${detail}` : prefix);
  err.stderr = detail;
  err.stdout = '';
  return err;
}

/**
 * Validate a Caddyfile via `caddy adapt`. Throws on failure with
 * an exec-like error (.stderr, .stdout, .message).
 *
 * On the agent path the backend reads the Caddyfile from disk (via
 * the existing /etc/caddy bind-mount) and forwards its body as
 * `config_text`. That keeps the agent's adapt method narrow — no
 * path arg, no traversal surface — while preserving the
 * "validate the merged on-disk config" semantics callers want.
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath]  Caddyfile path (default: CADDY_CONFIG_FILE).
 * @param {number} [opts.timeoutMs]   End-to-end timeout in ms (default 30s).
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function caddyAdapt({ configPath = CADDY_CONFIG_FILE, timeoutMs = 30000 } = {}) {
  if (useAgent()) {
    let configText;
    try {
      configText = await readFile(configPath, 'utf-8');
    } catch (err) {
      throw asExecLikeError(`caddy adapt: read ${configPath}`, err.message);
    }
    let result;
    try {
      result = await agentCall('caddy.adapt', { config_text: configText }, { timeoutMs });
    } catch (err) {
      const detail = err instanceof AgentError ? `${err.code}: ${err.message}` : err.message;
      throw asExecLikeError('caddy adapt', detail);
    }
    if (!result || !result.ok) {
      throw asExecLikeError('caddy adapt', result && result.error);
    }
    return { stdout: result.adapted_json || '', stderr: '' };
  }
  return execOnHost(`caddy adapt --config ${configPath} > /dev/null 2>&1`, { timeout: timeoutMs });
}

/**
 * Reload Caddy via `caddy reload --config <path> [--force]`. Throws
 * on failure with an exec-like error.
 *
 * @param {object} [opts]
 * @param {string}  [opts.configPath]  Caddyfile path (default: CADDY_CONFIG_FILE).
 * @param {boolean} [opts.force]       Pass --force on the nsenter path (default true).
 * @param {number}  [opts.timeoutMs]   End-to-end timeout in ms (default 30s).
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function caddyReload({ configPath = CADDY_CONFIG_FILE, force = true, timeoutMs = 30000 } = {}) {
  if (useAgent()) {
    let result;
    try {
      result = await agentCall('caddy.reload', { config_path: configPath }, { timeoutMs });
    } catch (err) {
      const detail = err instanceof AgentError ? `${err.code}: ${err.message}` : err.message;
      throw asExecLikeError('caddy reload', detail);
    }
    if (!result || !result.ok) {
      throw asExecLikeError('caddy reload', result && result.error);
    }
    return { stdout: '', stderr: '' };
  }
  const flag = force ? ' --force' : '';
  return execOnHost(`caddy reload --config ${configPath}${flag} 2>&1`, { timeout: timeoutMs });
}
