// Host runner — the guest probes. The implementation lives in the backend's
// pure setup-engine layer so the runner and the backend's in-process executor
// run the identical scripts and parsers; this module re-exports it from the
// checkout the runner ships in.
export * from '../../../admin/backend/src/lib/setup-engine/guest-probes.js';
