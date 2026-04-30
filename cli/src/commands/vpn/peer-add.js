import path from 'node:path';
import { addPeer, renderQrAnsi, renderQrPng, VPN_PEERS_DIR } from '../../core/vpn/index.js';
import * as output from '../../output.js';
import { surfacePeerMutationResult } from './_firewall-feedback.js';

/**
 * Print the post-add artifact bundle: client config text, ANSI QR for
 * terminal scanning, and the path to the file on disk + its PNG QR.
 * Used by both `peer add` and `peer rotate` since the artifact shape
 * is identical.
 */
export function printPeerArtifact({ name, ip, scope, services, publicKey, configBody, configPath }) {
  const pngPath = path.join(VPN_PEERS_DIR, `${name}.png`);
  let pngOk = true;
  try { renderQrPng(configBody, pngPath); } catch (e) {
    pngOk = false;
    output.warn(`PNG QR render failed: ${e.message}`);
  }

  output.success(`peer "${name}" ready  ip=${ip}  scope=${scope}${services ? ' services=' + services.join(',') : ''}`);
  output.info(`public key: ${publicKey}`);
  output.info(`config file: ${configPath}  (mode 0600 — deliver and delete)`);
  if (pngOk) output.info(`QR PNG: ${pngPath}`);
  console.log('');
  console.log('───── client config (save this — the server cannot reprint the private key) ─────');
  process.stdout.write(configBody);
  console.log('────────────────────────────────────────────────────────────────────────────────');
  console.log('');
  try {
    const ansi = renderQrAnsi(configBody);
    process.stdout.write(ansi);
  } catch (e) {
    output.warn(`ANSI QR render failed: ${e.message}`);
  }
}

export async function peerAddCommand(name, opts, globalOpts) {
  try {
    const services = opts.services
      ? String(opts.services).split(',').map(s => s.trim()).filter(Boolean)
      : null;
    const result = await addPeer({ name, scope: opts.scope ?? 'admin', services });
    if (globalOpts.json) {
      output.json({
        ok: true,
        name: result.name,
        ip: result.ip,
        scope: result.scope,
        services: result.services,
        public_key: result.publicKey,
        config_path: result.configPath,
        config: result.configBody,
        // private_key intentionally returned in --json output: this is
        // the one-shot delivery channel and the JSON consumer is the
        // operator's own tooling. Never goes through audit log / SQLite.
        private_key: result.privateKey,
        firewall: result.firewall ?? null,
        caddy: result.caddy ?? null,
      });
      return;
    }
    printPeerArtifact(result);
    surfacePeerMutationResult(result);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn peer add failed: ${e.message}`);
    process.exitCode = 1;
  }
}
