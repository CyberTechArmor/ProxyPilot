import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createAgentRunService } from './operational-agent-runs.js';
import { createRunCoordinator } from './operational-run-coordinator.js';
import { createWorkerLauncher } from './operational-worker-boundary.js';
import { createSupervisorClient, createTeardownVerifier } from './operational-worker-supervisor.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A6: agent runs behind the UI are off unless Operations, its agent metadata and
// OPERATIONS_AGENT_RUNS_ENABLED are all on. Even then nothing executes until the
// supervisor backend socket, its receipt public key and the proof VM UUID are
// configured (the container mount is an A8 item); until then Start, Stop,
// Approve and the view answer EXECUTION_UNAVAILABLE.
export function agentRunsConfiguration(env = process.env) {
  if (env.OPERATIONS_ENABLED !== 'true' || env.OPERATIONS_AGENTS_METADATA_ENABLED !== 'true' ||
      env.OPERATIONS_AGENT_RUNS_ENABLED !== 'true') return { enabled: false, execution: null, reason: 'flag_off' };
  const socket = env.OPERATIONS_AGENT_SUPERVISOR_SOCKET || '';
  const publicKeyPath = env.OPERATIONS_AGENT_SUPERVISOR_PUBLIC_KEY || '';
  const vmUuid = env.OPERATIONS_AGENT_VM_UUID || '';
  if (!socket && !publicKeyPath && !vmUuid) return { enabled: true, execution: null, reason: 'not_configured' };
  if (!path.isAbsolute(socket) || !path.isAbsolute(publicKeyPath) || !UUID.test(vmUuid))
    return { enabled: true, execution: null, reason: 'invalid_configuration' };
  return { enabled: true, execution: { socket, publicKeyPath, vmUuid }, reason: null };
}

// Returns null when the flag is off (the routes then answer 404 as before).
export function createAgentRunRuntime(config, { db, readFile = readFileSync, log = () => {} } = {}) {
  if (!config?.enabled) return null;
  let coordinator = null, launcher = null, reason = config.reason;
  if (config.execution) {
    try {
      const verifyTeardown = createTeardownVerifier({ publicKeyPem: readFile(config.execution.publicKeyPath, 'utf8'),
        vmUuid: config.execution.vmUuid });
      launcher = createWorkerLauncher({ client: createSupervisorClient(config.execution.socket),
        vmUuid: config.execution.vmUuid });
      coordinator = createRunCoordinator({ db, launcher, verifyTeardown, log });
    } catch {
      coordinator = launcher = null;
      reason = 'invalid_configuration';
    }
  }
  return createAgentRunService({ db, coordinator, launcher, unavailableReason: reason, log });
}
