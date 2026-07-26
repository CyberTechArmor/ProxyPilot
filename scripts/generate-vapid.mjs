#!/usr/bin/env node
// Generate a VAPID key pair for Web Push.
//
// WHAT VAPID KEYS ARE FOR (RFC 8292, "Voluntary Application Server
// Identification"). They are ProxyPilot's identity to the browser vendors' push
// services — Google's FCM for Chrome/Edge/Android, Mozilla's autopush for
// Firefox, Apple's APNs for Safari/iOS. Three distinct jobs, and it is worth
// being precise because they are easy to confuse with encryption keys:
//
//   1. IDENTIFY the sender. Every push request carries a JWT signed with the
//      PRIVATE key. The push service verifies it against the PUBLIC key that
//      the browser handed it at subscribe time. That is the whole handshake —
//      it is how the service knows a push for this subscription came from this
//      server and not from someone who scraped an endpoint URL.
//
//   2. BIND a subscription to this server. The browser passes the public key
//      as `applicationServerKey` when it subscribes, and the resulting endpoint
//      only accepts pushes signed by the matching private key. This is why the
//      pair must be STABLE: rotate it and every existing subscription stops
//      working and every browser must re-subscribe.
//
//   3. Give the push service a contact (the `sub` claim — a mailto: or https:
//      URL). If this server floods or misbehaves, that is who they contact
//      before they start rejecting traffic.
//
// WHAT THEY ARE NOT: they are not the payload encryption. Push payloads are
// encrypted separately (RFC 8291) with keys the BROWSER generates per
// subscription — p256dh and auth — which is why the server can never read a
// notification it has already sent, and why a stolen VAPID key still does not
// decrypt anything.
//
// No dependency: Node's own crypto generates a P-256 key pair, and the JWK
// export gives the raw coordinates already base64url-encoded, which is exactly
// the form the Push API wants.
//
// Usage:
//   node scripts/generate-vapid.mjs            # KEY=VALUE lines for .env
//   node scripts/generate-vapid.mjs --public   # just the public key
//   node scripts/generate-vapid.mjs --private  # just the private key

import { generateKeyPairSync } from 'node:crypto';

export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  // The Push API wants the uncompressed EC point: 0x04 || X || Y, base64url.
  const pub = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  // The private scalar d, already base64url in the JWK.
  return { publicKey: pub, privateKey: jwk.d };
}

// Run directly (not when imported by a test).
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const keys = generateVapidKeys();
  const arg = process.argv[2];
  if (arg === '--public') process.stdout.write(`${keys.publicKey}\n`);
  else if (arg === '--private') process.stdout.write(`${keys.privateKey}\n`);
  else {
    process.stdout.write(`VAPID_PUBLIC_KEY=${keys.publicKey}\n`);
    process.stdout.write(`VAPID_PRIVATE_KEY=${keys.privateKey}\n`);
  }
}
