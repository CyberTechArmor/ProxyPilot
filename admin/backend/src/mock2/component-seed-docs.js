// The component documents the platform bundles — PURE (paths + one flag, no
// native module), so tests and the seed can share the list without importing
// the DB. `wires` marks the document whose stored version must be able to wire
// the auth bootstrap (component-seed.js's liveness test); the others are judged
// on content alone.
//
// The CPR Host component (Continuous Production Readiness v1.1 §5–§7: host
// contract, host SDK, feature-manifest schema, reference host adapter) ships
// here so a build can adopt it with materialize_component instead of
// re-implementing the host seam.

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

export const AUTH_SEED_DOC = resolve(__dir, 'framework-seed', 'proxypilot-auth.component.json');
export const CPR_HOST_SEED_DOC = resolve(__dir, 'framework-seed', 'cpr-host.component.json');

export const SEED_DOCS = Object.freeze([
  { file: AUTH_SEED_DOC, wires: true },
  { file: CPR_HOST_SEED_DOC, wires: false },
]);
