import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, recoverStoppedStore } from "../store.mjs";
test("SIGKILL leaves conservative lock; explicit stopped-process recovery marks send uncertain and enrollment reconcilable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-crash-")),
    path = join(dir, "state.db");
  const module = new URL("../store.mjs", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {openStore} from ${JSON.stringify(module)};const s=openStore(${JSON.stringify(path)});s.put('operation',{id:'op',state:'sending'});s.put('connection',{id:'c',enrollment:{state:'reserved'}});s.put('session',{id:'s',revoked:false});s.put('approval',{id:'a',consumed:false});process.stdout.write('ready');setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(Error("fixture stopped")));
    });
    assert.throws(() => recoverStoppedStore(path), /STORE_LOCKED/);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    assert.throws(() => openStore(path), /STORE_LOCKED/);
    recoverStoppedStore(path);
    const db = openStore(path);
    assert.equal(db.get("operation", "op").state, "uncertain");
    assert.equal(
      db.get("connection", "c").enrollment.state,
      "reconcile_required",
    );
    assert.equal(db.get("session", "s").revoked, true);
    assert.equal(db.get("approval", "a").consumed, true);
    db.close();
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
