// Fresh process: deliberately imports no fixture that sets TOTP_ENCRYPTION_KEY.
// Production command, executor, credential store and OpenBao access adapters;
// only external probes/transport and the database consumer are scripted.
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
let sequence = 0;
const pending = new Map();
globalThis.__g6RunnerSend = (origin, path, options) => new Promise((resolve) => {
  const id = ++sequence;
  pending.set(id, resolve);
  process.send({ id, origin, path, options });
});
process.on('message', ({ id, result }) => {
  pending.get(id)?.(result);
  pending.delete(id);
});
const actualApi = new URL('../../lib/setup-engine/openbao-api.js?actual', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  let source;
  if (specifier.endsWith('/openbao-api.js') && !context.parentURL?.includes('?actual')) {
    source = `import {createClient as base} from ${JSON.stringify(actualApi)};export * from ${JSON.stringify(actualApi)};export const createClient=(origin,opts={})=>base(origin,{...opts,send:globalThis.__g6RunnerSend});`;
  } else if (specifier.endsWith('/openbao-identity.js')) {
    source = 'export const verifyClient=async()=>({scripted:true});';
  } else if (specifier.endsWith('/keycloak-discovery.js')) {
    source = 'export const verifyKeycloak=async()=>({scripted:true});export const allowedAddress=()=>true;';
  } else if (specifier.endsWith('/openbao-postgres.js')) {
    source = 'export const credentialFlow=async()=>({scripted:true});';
  }
  return source ? { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true } : next(specifier, context);
} });
const { setupRunnerCommand } = await import('../../../../../cli/src/commands/setup-runner.js');
let ticks = 0;
const code = await setupRunnerCommand(process.argv[3], {
  installDir: process.argv[2], max: 1, ...(process.argv[4] ? { env: process.argv[4] } : {}),
}, { json: true }, {
  openDb: async path => { process.send({ opened: true }); return new DatabaseSync(path); },
  getuid: () => 0,
  hostname: () => 'g6-fresh-process',
  shouldStop: () => ticks > 0,
  sleep: async () => { ticks++; },
  exec: { host: async () => { throw Error('Unexpected host mutation'); }, guest: async () => { throw Error('Unexpected guest mutation'); } },
});
process.exitCode = code;
process.disconnect();
