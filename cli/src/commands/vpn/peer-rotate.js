import { rotatePeer } from '../../core/vpn/index.js';
import { printPeerArtifact } from './peer-add.js';
import { surfacePeerMutationResult } from './_firewall-feedback.js';
import * as output from '../../output.js';

export async function peerRotateCommand(name, opts, globalOpts) {
  try {
    const result = await rotatePeer({ name });
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
        private_key: result.privateKey,
        rotated: true,
        firewall: result.firewall ?? null,
        caddy: result.caddy ?? null,
      });
      return;
    }
    output.warn('old key invalidated — the previous client config can no longer connect.');
    printPeerArtifact(result);
    surfacePeerMutationResult(result);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn peer rotate failed: ${e.message}`);
    process.exitCode = 1;
  }
}
