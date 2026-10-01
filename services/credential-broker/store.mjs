import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  lstatSync,
  openSync,
  closeSync,
  unlinkSync,
  writeSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fail } from "./schema.mjs";
export function openStore(path) {
  if (!path || path === ":memory:") fail("PERSISTENT_STORE_REQUIRED");
  path = resolve(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  if (
    parent.isSymbolicLink() ||
    parent.mode & 0o077 ||
    parent.uid !== process.getuid()
  )
    fail("UNSAFE_STORE");
  const lock = path + ".lock";
  let fd;
  try {
    fd = openSync(lock, "wx", 0o600);
    writeSync(fd, JSON.stringify({ pid: process.pid }));
  } catch {
    fail("STORE_LOCKED", 503);
  }
  let db;
  try {
    try {
      if (lstatSync(path).isSymbolicLink()) fail("UNSAFE_STORE");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const st = lstatSync(path);
    if (st.uid !== process.getuid() || st.mode & 0o077) fail("UNSAFE_STORE");
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));",
    );
  } catch (e) {
    closeSync(fd);
    unlinkSync(lock);
    throw e;
  }
  const get = (kind, id) => {
    const r = db
      .prepare("SELECT body FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return r ? JSON.parse(r.body) : null;
  };
  const all = (kind) =>
    db
      .prepare("SELECT body FROM records WHERE kind=?")
      .all(kind)
      .map((r) => JSON.parse(r.body));
  const put = (kind, r) => {
    db.prepare(
      "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
    ).run(kind, r.id, JSON.stringify(r));
    return r;
  };
  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  // Restart and restored DB invalidate all existing capabilities. Sending is never retried.
  tx(() => {
    for (const c of all("connection"))
      put("connection", {
        ...c,
        policy_revalidation_required: true,
        enrollment:
          c.enrollment?.state === "reserved"
            ? { ...c.enrollment, state: "reconcile_required" }
            : c.enrollment,
      });
    for (const s of all("session")) put("session", { ...s, revoked: true });
    for (const a of all("approval")) put("approval", { ...a, consumed: true });
    for (const o of all("operation"))
      if (o.state === "sending")
        put("operation", {
          ...o,
          state: "uncertain",
          code: "OPERATION_UNCERTAIN",
        });
  });
  let closed = false;
  return {
    get,
    all,
    put,
    tx,
    close() {
      if (!closed) {
        closed = true;
        db.close();
        closeSync(fd);
        unlinkSync(lock);
      }
    },
  };
}

/** Explicit operator recovery after an unclean stop; never automatically steal a lock. */
export function recoverStoppedStore(path) {
  const lock = resolve(path) + ".lock";
  const st = lstatSync(lock);
  if (st.isSymbolicLink() || st.uid !== process.getuid() || st.mode & 0o077)
    fail("UNSAFE_STORE");
  const { pid } = JSON.parse(readFileSync(lock, "utf8"));
  if (!Number.isSafeInteger(pid) || pid < 1) fail("UNSAFE_STORE");
  try {
    process.kill(pid, 0);
    fail("STORE_LOCKED", 503);
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  unlinkSync(lock);
  return { recovered: true };
}
