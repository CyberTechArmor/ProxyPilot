#!/usr/bin/env node
import { readConfig, validateConfig } from "./config.mjs";
import { createConfiguredService } from "./configured-service.mjs";
import { digest } from "./schema.mjs";
let service;
try {
  const [action, path, ...extra] = process.argv.slice(2);
  if (!["--config", "--check-config"].includes(action) || !path || extra.length)
    throw Error("INVALID_ARGUMENTS");
  const config = validateConfig(readConfig(path));
  if (action === "--check-config") {
    process.stdout.write(JSON.stringify({valid:true,schema_version:config.schema_version,config_digest:digest(config)})+"\n");
  } else {
    service = await createConfiguredService({ config });
    await service.start();
    let stopping = false;
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, async () => {
        if (stopping) return;
        stopping = true;
        try { await service.close(); process.exitCode = 0; }
        catch { process.stderr.write("BROKER_STOP_FAILED\n"); process.exitCode = 1; }
      });
    process.stdout.write(JSON.stringify({started:true,build:"credential-broker-configured.v1",production_activation:"operator_configuration",health:service.health()})+"\n");
  }
} catch {
  await service?.close();
  process.stderr.write("BROKER_START_FAILED: configuration or dependency validation failed; no secret diagnostics emitted.\n");
  process.exitCode = 1;
}
