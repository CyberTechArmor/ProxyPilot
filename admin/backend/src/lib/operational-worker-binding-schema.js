// A3 supervisor binding. Additive: an attempt records the exact VM and guest
// boot the host supervisor launched it on, so a teardown receipt naming another
// VM or boot is refused. Existing rows stay NULL (never bound to a supervisor).
export function operationalWorkerBindingMigration1109(d) {
  d.exec(`
    ALTER TABLE ops_agent_worker_attempts ADD COLUMN vm_uuid TEXT;
    ALTER TABLE ops_agent_worker_attempts ADD COLUMN boot_id TEXT;
  `);
}
