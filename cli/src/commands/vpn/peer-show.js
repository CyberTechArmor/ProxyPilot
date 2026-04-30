import { showPeer, rotatePeer } from '../../core/vpn/index.js';
import { printPeerArtifact } from './peer-add.js';
import * as output from '../../output.js';

/**
 * `peer show` deliberately refuses by default. The peer's private key
 * was only displayed once at `add` time — there is no recover-the-key
 * path because the server never persisted it. --rotate-first is the
 * only way to get a new printable artifact, and it (correctly) bumps
 * the peer to a new key, invalidating the old config.
 */
export async function peerShowCommand(name, opts, globalOpts) {
  try {
    if (opts.rotateFirst) {
      const result = rotatePeer({ name });
      if (globalOpts.json) {
        output.json({
          ok: true,
          rotated: true,
          name: result.name,
          ip: result.ip,
          scope: result.scope,
          services: result.services,
          public_key: result.publicKey,
          private_key: result.privateKey,
          config: result.configBody,
          config_path: result.configPath,
        });
        return;
      }
      output.warn('rotated: old client config can no longer connect.');
      printPeerArtifact(result);
      return;
    }
    const info = showPeer(name);
    if (globalOpts.json) {
      output.json({ ok: true, peer: info });
      return;
    }
    output.info(`peer "${info.name}"`);
    output.info(`  ip:             ${info.ip}`);
    output.info(`  scope:          ${info.scope}${info.services ? ' [' + info.services.join(', ') + ']' : ''}`);
    output.info(`  status:         ${info.status}`);
    output.info(`  public key:     ${info.publicKey}`);
    output.info(`  online:         ${info.online ? 'yes' : 'no'}`);
    output.info(`  last handshake: ${info.lastHandshakeAt ?? 'never'}`);
    output.info(`  endpoint:       ${info.endpoint ?? '-'}`);
    output.info(`  rx / tx bytes:  ${info.rxBytes} / ${info.txBytes}`);
    output.info(`  created at:     ${info.createdAt}`);
    if (info.rotatedAt) output.info(`  rotated at:     ${info.rotatedAt}`);
    if (info.disabledAt) output.info(`  disabled at:    ${info.disabledAt}`);
    console.log('');
    output.warn(
      'Refusing to reprint the client config: the private key was only displayed once ' +
      'at `peer add` time and the server never persisted it. ' +
      'Pass --rotate-first to issue a new keypair (the old config will stop working).',
    );
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn peer show failed: ${e.message}`);
    process.exitCode = 1;
  }
}
