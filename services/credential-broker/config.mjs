import {
  readFileSync,
  lstatSync,
  realpathSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { resolve, isAbsolute, dirname, join } from "node:path";
import net from "node:net";
import { exact, uuid, fail, parseJson } from "./schema.mjs";
export function privateFile(path, { secret = true } = {}) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    realpathSync(path) !== resolve(path)
  )
    fail("INVALID_CONFIG");
  const st = lstatSync(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid() ||
    st.mode & 0o022 ||
    (secret && st.mode & 0o077) ||
    st.size > 1048576
  )
    fail("INVALID_CONFIG");
  return readFileSync(path);
}
export function readConfig(path) {
  return parseJson(privateFile(path));
}
const origin = (value) => {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("INVALID_CONFIG");
  }
  if (u.protocol !== "https:" || u.origin !== value || u.username || u.password)
    fail("INVALID_CONFIG");
  return u;
};
export function validateConfig(config, { testOnly = false } = {}) {
  exact(config, [
    "schema_version",
    "mode",
    "state_dir",
    "listeners",
    "clients",
    "identity",
    "authority",
    "vault",
    "upstream",
  ]);
  if (
    config.schema_version !== 1 ||
    config.mode !== "configured" ||
    typeof config.state_dir !== "string" ||
    !isAbsolute(config.state_dir)
  )
    fail("INVALID_CONFIG");
  const state = lstatSync(config.state_dir);
  if (
    !state.isDirectory() ||
    state.uid !== process.getuid() ||
    state.mode & 0o077 ||
    realpathSync(config.state_dir) !== resolve(config.state_dir)
  )
    fail("INVALID_CONFIG");
  exact(config.listeners, ["human", "management", "agent"]);
  const origins = new Set();
  for (const [role, l] of Object.entries(config.listeners)) {
    exact(l, ["origin", "host", "port", "tls"]);
    origin(l.origin);
    if (origins.has(l.origin)) fail("INVALID_CONFIG");
    origins.add(l.origin);
    if (
      !net.isIP(l.host) ||
      !Number.isInteger(l.port) ||
      l.port < (testOnly ? 0 : 1) ||
      l.port > 65535
    )
      fail("INVALID_CONFIG");
    if (l.port && Number(new URL(l.origin).port || 443) !== l.port)
      fail("INVALID_CONFIG");
    exact(
      l.tls,
      ["key_file", "cert_file", "ca_file"],
      role === "human"
        ? ["key_file", "cert_file"]
        : ["key_file", "cert_file", "ca_file"],
    );
  }
  if (
    !Array.isArray(config.clients) ||
    !config.clients.length ||
    config.clients.length > 100
  )
    fail("INVALID_CONFIG");
  const fingerprints = new Set();
  for (const c of config.clients) {
    exact(c, ["fingerprint", "role", "id"]);
    if (
      typeof c.fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(c.fingerprint) ||
      fingerprints.has(c.fingerprint) ||
      !["dashboard", "publisher", "worker"].includes(c.role)
    )
      fail("INVALID_CONFIG");
    fingerprints.add(c.fingerprint);
    if (typeof c.id !== "string" || !c.id.length || c.id.length > 200)
      fail("INVALID_CONFIG");
  }
  exact(config.authority, ["sources"]);
  if (!Array.isArray(config.authority.sources)) fail("INVALID_CONFIG");
  exact(
    config.vault,
    [
      "origin",
      "ca_file",
      "approved_address",
      "mount",
      "reader",
      "enroller",
      "slots",
    ],
    ["origin", "mount", "reader", "enroller", "slots"],
  );
  for (const part of [config.vault, config.upstream]) {
    origin(part.origin);
    if (
      part.approved_address !== undefined &&
      net.isIP(part.approved_address) !== 4
    )
      fail("INVALID_CONFIG");
  }
  exact(config.upstream, ["origin", "ca_file", "approved_address"], ["origin"]);
  for (const role of ["reader", "enroller"])
    exact(config.vault[role], ["role_id_file", "secret_id_file"]);
  if (
    !Array.isArray(config.vault.slots) ||
    !config.vault.slots.length ||
    config.vault.slots.length > 1000
  )
    fail("INVALID_CONFIG");
  const slots = new Set();
  for (const s of config.vault.slots) {
    exact(s, ["owner_id", "credential_id"]);
    uuid(s.owner_id);
    uuid(s.credential_id);
    if (slots.has(s.credential_id)) fail("INVALID_CONFIG");
    slots.add(s.credential_id);
  }
  if (config.identity.broker_origin !== config.listeners.human.origin)
    fail("INVALID_CONFIG");
  return structuredClone(config);
}
export function createAllocator(path, slots) {
  let used;
  try {
    used = parseJson(privateFile(path));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    used = [];
  }
  if (
    !Array.isArray(used) ||
    used.some(
      (x) => typeof x !== "string" || !slots.some((s) => s.credential_id === x),
    )
  )
    fail("INVALID_CONFIG");
  const save = () => {
    const tmp = path + ".tmp";
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(used));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  };
  if (!used.length) save();
  return (owner) => {
    uuid(owner);
    const slot = slots.find(
      (s) => s.owner_id === owner && !used.includes(s.credential_id),
    );
    if (!slot) fail("CREDENTIAL_SLOT_UNAVAILABLE", 503);
    used.push(slot.credential_id);
    save();
    return slot.credential_id;
  };
}
