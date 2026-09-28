import net from 'node:net';
import { createHash, createPublicKey, verify } from 'node:crypto';

// Client and receipt verifier for the host-owned A3 worker supervisor
// (scripts/a3-worker-supervisor.py). The backend reaches only its narrow
// backend socket: status, launch, renew, one typed browser action, stop. It
// never holds the receipt signing key; it verifies each teardown receipt with
// the host public key and the proof VM identity it was configured with.
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const METHODS = new Set(['status', 'launch', 'renew', 'action', 'stop']);
const MAX_REPLY = 4 * 1024 * 1024;
const coded = (code) => { const error = new Error(code); error.code = code; return error; };

export function createSupervisorClient(socketPath, { timeoutMs = 120_000 } = {}) {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/')) throw coded('BOUNDARY_UNVERIFIED');
  return {
    request(method, params) {
      if (!METHODS.has(method)) return Promise.reject(coded('METHOD_NOT_ALLOWED'));
      return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let buffer = '';
        let settled = false;
        const done = (error, value) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (error) reject(error); else resolve(value);
        };
        socket.setEncoding('utf8');
        socket.setTimeout(timeoutMs, () => done(coded('SUPERVISOR_TIMEOUT')));
        socket.on('error', () => done(coded('SUPERVISOR_UNREACHABLE')));
        socket.on('connect', () => socket.write(`${JSON.stringify({ method, params })}\n`));
        socket.on('end', () => done(coded('SUPERVISOR_PROTOCOL')));
        socket.on('data', (chunk) => {
          buffer += chunk;
          if (buffer.length > MAX_REPLY) return done(coded('SUPERVISOR_PROTOCOL'));
          const end = buffer.indexOf('\n');
          if (end < 0) return undefined;
          let reply;
          try { reply = JSON.parse(buffer.slice(0, end)); } catch { return done(coded('SUPERVISOR_PROTOCOL')); }
          if (reply?.ok === true) return done(null, reply.result);
          return done(coded(typeof reply?.error === 'string' && CODE.test(reply.error) ? reply.error : 'SUPERVISOR_PROTOCOL'));
        });
      });
    },
  };
}

// verifyTeardown(receipt, expected) for createOperationalWorkerStore. A receipt
// is accepted only when the host signature is valid and its signed payload
// names this run, attempt, fence, workspace, proof VM and bound guest boot.
export function createTeardownVerifier({ publicKeyPem, vmUuid }) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519' || !UUID.test(vmUuid || '')) throw coded('BOUNDARY_UNVERIFIED');
  const keyId = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  return (receipt, expected) => {
    try {
      const parts = String(receipt?.attestation).split('.');
      if (parts.length !== 3 || parts[0] !== 'a3r1') return false;
      const body = Buffer.from(parts[1], 'base64url');
      const signature = Buffer.from(parts[2], 'base64url');
      if (signature.length !== 64 || !verify(null, body, key, signature)) return false;
      const p = JSON.parse(body.toString('utf8'));
      const neverLaunched = p.reason === 'launch_refused' && p.evidence?.launched === false;
      return p.v === 1 && p.kind === 'a3-teardown' && p.key_id === keyId && p.vm_uuid === vmUuid &&
        p.run_id === expected.run_id && p.attempt_id === expected.attempt_id && p.fence === expected.fence &&
        p.run_id === receipt.run_id && p.attempt_id === receipt.attempt_id && p.fence === receipt.fence &&
        p.descendants_gone === true && p.workspace_removed === true &&
        receipt.descendants_gone === true && receipt.workspace_removed === true &&
        (p.workspace_id === expected.workspace_id || (p.workspace_id === null && neverLaunched)) &&
        (expected.vm_uuid == null || p.vm_uuid === expected.vm_uuid) &&
        (expected.boot_id == null || p.bound_boot_id === expected.boot_id);
    } catch {
      return false;
    }
  };
}
