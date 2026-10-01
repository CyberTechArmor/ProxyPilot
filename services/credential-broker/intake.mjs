import {isConfiguredIdentity} from './identity.mjs';
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  fsyncSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  fail,
  exact,
  uuid,
  string,
  list,
  operation,
  limits,
  parseJson,
  BrokerError,
} from "./schema.mjs";

function privateStatePath(statePath) {
  const parent = dirname(statePath),
    dir = lstatSync(parent);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    realpathSync(parent) !== resolve(parent) ||
    (dir.mode & 0o077) !== 0 ||
    dir.uid !== process.getuid()
  )
    fail("BROKER_UNAVAILABLE", 503);
  for (const path of [statePath, statePath + ".lock"])
    try {
      const f = lstatSync(path);
      if (
        !f.isFile() ||
        f.isSymbolicLink() ||
        (f.mode & 0o077) !== 0 ||
        f.uid !== process.getuid()
      )
        fail("BROKER_UNAVAILABLE", 503);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
}

/** Explicit recovery only after a confirmed dead local process; never delete a live lock.
 * Call from the operator-controlled synthetic harness, never an HTTP endpoint. */
export function recoverIntakeLock(statePath) {
  privateStatePath(statePath);
  const guard = openSync(statePath + ".recovery", "wx", 0o600);
  try {
    const lock = JSON.parse(readFileSync(statePath + ".lock", "utf8"));
    if (!Number.isSafeInteger(lock.pid) || lock.pid < 1)
      fail("BROKER_UNAVAILABLE", 503);
    try {
      process.kill(lock.pid, 0);
      fail("BROKER_UNAVAILABLE", 503);
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
    unlinkSync(statePath + ".lock");
  } finally {
    closeSync(guard);
    unlinkSync(statePath + ".recovery");
  }
}

/** Disposable synthetic harness only. Authentication belongs to the broker's independent
 * human authority. Never inject dashboard identity assertions as authenticateProof. */
export function createIntakeHandler({
  mode,
  identity,
  broker,
  origin,
  statePath,
  authenticateRequest,
  authenticateProof,
  clock = Date.now,
}) {
  if (
    (mode !== "synthetic" && (mode !== "configured" || !isConfiguredIdentity(identity))) ||
    !broker ||
    typeof authenticateRequest !== "function" ||
    typeof authenticateProof !== "function" ||
    !statePath
  )
    fail("BROKER_NOT_ACTIVATED", 503);
  const parsed = new URL(origin);
  if (parsed.origin !== origin || parsed.protocol !== "https:")
    fail("TLS_REQUIRED");
  privateStatePath(statePath);
  const lockPath = statePath + ".lock";
  const lock = openSync(lockPath, "wx", 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  fsyncSync(lock);
  let rows;
  try {
    try {
      rows = JSON.parse(readFileSync(statePath, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      rows = [];
    }
    if (!Array.isArray(rows)) throw Error();
    for (const row of rows)
      if (row.state === "submitting") {
        row.state = "reconcile_required";
        row.code = "ENROLLMENT_RECONCILE_REQUIRED";
      }
  } catch {
    closeSync(lock);
    unlinkSync(lockPath);
    fail("BROKER_UNAVAILABLE", 503);
  }
  const save = () => {
    const tmp = statePath + "." + randomUUID() + ".tmp";
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(rows));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, statePath);
    const parent = openSync(dirname(statePath), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  };
  save();
  const human = async (proof) => {
    let p;
    try {
      p = await authenticateProof(proof);
    } catch {
      fail("AUTH_REQUIRED", 401);
    }
    if (
      !p ||
      p.disabled ||
      !Number.isFinite(p.fresh_until) ||
      p.fresh_until <= clock()
    )
      fail("FRESH_PROOF_REQUIRED", 401);
    uuid(p.user_id);
    if (mode === "configured" && !["human", "delegation"].includes(p.proof_type)) fail("AUTH_REQUIRED",401);
    return p;
  };
  const projection = (r) => ({
    id: r.id,
    state: r.state,
    intake_url: origin + "/intake/" + r.id,
    expires_at: r.expires_at,
    ...(r.connection_id ? { connection_id: r.connection_id } : {}),
    ...(r.revision ? { revision: r.revision } : {}),
    ...(r.credential_version
      ? { credential_version: r.credential_version }
      : {}),
    ...(r.code ? { code: r.code } : {}),
  });
  const owned = (p, id) => {
    uuid(id);
    const r = rows.find((x) => x.id === id && x.user_id === p.user_id);
    if (!r) fail("NOT_FOUND", 404);
    return r;
  };
  const reserve = async (proof, request) => {
    const p = await human(proof);
    if (mode === "configured" && p.proof_type === "delegation" && !p.actions?.includes(request?.kind)) fail("NOT_PERMITTED",403);
    if (rows.length >= 1000) fail("LIMIT_EXCEEDED", 429);
    let summary;
    if (request?.kind === "enroll") {
      exact(request, ["kind", "connection"]);
      const c = request.connection;
      exact(c, [
        "name",
        "project_id",
        "adapter_id",
        "operations",
        "resources",
        "limits",
      ]);
      string(c.name);
      if (c.project_id !== null) uuid(c.project_id);
      if (c.adapter_id !== "synthetic-ledger-v1") fail("INVALID_REQUEST");
      list(c.operations, operation);
      list(c.resources, uuid);
      limits(c.limits);
      summary = { ...c, owner_id: p.user_id };
    } else {
      exact(request, ["kind", "connection_id", "revision"]);
      if (
        request.kind !== "rotate" ||
        !Number.isSafeInteger(request.revision) ||
        request.revision < 1
      )
        fail("INVALID_REQUEST");
      uuid(request.connection_id);
      const c = await broker.detail(proof, request.connection_id);
      if (!c.rights.includes("manage")) fail("NOT_PERMITTED", 403);
      if (c.revision !== request.revision) fail("REVISION_MISMATCH", 409);
      summary = {
        name: c.name,
        owner_id: c.owner_id,
        project_id: c.project_id,
        adapter_id: c.adapter_id,
        operations: c.operations,
        resources: c.resources,
        limits: c.limits,
      };
    }
    const r = {
      id: randomUUID(),
      user_id: p.user_id,
      request: structuredClone(request),
      summary: structuredClone(summary),
      state: "reserved",
      expires_at: Math.min(p.fresh_until, clock() + 300000),
    };
    rows.push(r);
    save();
    return projection(r);
  };
  const status = async (proof, id) => {
    const p = await human(proof);
    if (mode === "configured" && p.proof_type === "delegation" && !p.actions?.includes("intent")) fail("NOT_PERMITTED",403);
    const r = owned(p, id);
    if (
      r.state === "reconcile_required" &&
      r.request.kind === "enroll" &&
      broker.enrollmentStatus
    ) {
      let found;
      try {
        found = await broker.enrollmentStatus(proof, r.id);
      } catch {
        /* Status remains uncertain; no write retry. */
      }
      if (found) {
        uuid(found.connection_id);
        r.connection_id = found.connection_id;
        r.revision = found.revision;
        if (
          found.status === "committed" &&
          Number.isSafeInteger(found.credential_version) &&
          found.credential_version > 0
        ) {
          r.credential_version = found.credential_version;
          r.state = "committed";
          delete r.code;
        }
        save();
      }
    }
    return projection(r);
  };
  const submit = async (proof, id, credential) => {
    const p = await human(proof),
      r = owned(p, id);
    if (mode === "configured" && p.proof_type !== "human") fail("NOT_PERMITTED",403);
    if (r.state !== "reserved") fail("INTAKE_ALREADY_SUBMITTED", 409);
    if (r.expires_at <= clock()) fail("INTAKE_EXPIRED", 409);
    string(credential, 4096);
    r.state = "submitting";
    save(); // Persist BEFORE vault work. A crash never enables replay.
    try {
      const c =
        r.request.kind === "enroll"
          ? await broker.enroll(proof, r.request.connection, credential, r.id)
          : await broker.rotate(
              proof,
              r.request.connection_id,
              r.request.revision,
              credential,
            );
      uuid(c.id);
      r.connection_id = c.id;
      r.revision = c.revision;
      r.credential_version = c.credential_version;
      r.state = "committed";
    } catch {
      r.state = "reconcile_required";
      r.code = "ENROLLMENT_RECONCILE_REQUIRED";
    } finally {
      credential = null;
    }
    save();
    return projection(r);
  };
  const equal = (a, b) =>
    typeof a === "string" &&
    typeof b === "string" &&
    a.length > 15 &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const body = async (req) => {
    if (
      req.headers["content-type"] !== "application/json" ||
      req.headers["content-encoding"]
    )
      fail("INVALID_REQUEST");
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => req.destroy(), 5000);
    try {
      for await (const b of req) {
        size += b.length;
        if (size > 8192) fail("LIMIT_EXCEEDED", 413);
        chunks.push(b);
      }
      return parseJson(Buffer.concat(chunks));
    } finally {
      clearTimeout(timer);
    }
  };
  const handler = async (req, res) => {
    const nonce = randomBytes(24).toString("base64url");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    );
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      const names = req.rawHeaders
        .filter((_, i) => i % 2 === 0)
        .map((x) => x.toLowerCase());
      if (new Set(names).size !== names.length) fail("INVALID_REQUEST");
      if (mode === "configured" && !req.socket.encrypted) fail("AUTH_REQUIRED",401);
      if (req.headers.host !== parsed.host) fail("NOT_PERMITTED", 403);
      let auth;
      try {
        auth = await authenticateRequest(req);
      } catch {
        fail("AUTH_REQUIRED", 401);
      }
      if (!auth?.proof) fail("AUTH_REQUIRED", 401);
      const p = await human(auth.proof);
      if (mode === "configured" && p.proof_type !== "human") fail("NOT_PERMITTED",403);
      if (
        req.method === "POST" &&
        (req.headers.origin !== origin ||
          !equal(req.headers["x-csrf-token"], auth.csrf_token))
      )
        fail("NOT_PERMITTED", 403);
      if (req.method === "POST" && req.url === "/v1/intake/intents")
        return send(201, await reserve(auth.proof, await body(req)));
      const m =
        /^\/(v1\/intake\/intents|intake)\/([0-9a-f-]+)(\/submit)?$/.exec(
          req.url || "",
        );
      if (!m) fail("NOT_FOUND", 404);
      const r = owned(p, m[2]);
      if (req.method === "GET" && m[1] === "v1/intake/intents" && !m[3])
        return send(200, await status(auth.proof, r.id));
      if (req.method === "POST" && m[1] === "v1/intake/intents" && m[3]) {
        const b = await body(req);
        exact(b, ["credential"]);
        return send(200, await submit(auth.proof, r.id, b.credential));
      }
      if (req.method !== "GET" || m[1] !== "intake" || m[3])
        fail("NOT_FOUND", 404);
      if (typeof auth.csrf_token !== "string" || auth.csrf_token.length < 16)
        fail("AUTH_REQUIRED", 401);
      const escape = (value) =>
        String(value).replace(
          /[&<>\"]/g,
          (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" })[c],
        );
      const c = r.summary;
      const summary = `${r.request.kind === "rotate" ? `Rotate connection ${escape(r.request.connection_id)} at revision ${r.request.revision}. ` : ""}Owner: ${escape(c.owner_id)}. Project: ${escape(c.project_id || "Private, no project")}. Service: ${escape(c.adapter_id)}. Connection: ${escape(c.name)}. Allowed operations: ${escape(c.operations.join(", "))}. Resources: ${escape(c.resources.join(", "))}. Limits: ${c.limits.max_actions} actions, ${c.limits.max_seconds} seconds.`;
      const config = JSON.stringify({
        csrf: auth.csrf_token,
        url: "/v1/intake/intents/" + r.id,
      }).replace(/</g, "\\u003c");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${mode === "synthetic" ? "Synthetic credential intake" : "Credential intake"}</title><style nonce="${nonce}">body{font:16px system-ui;color:#172b4d;background:#f4f7fb;margin:0;padding:16px}main{max-width:600px;margin:32px auto;background:white;padding:24px;border:1px solid #dce4ef;border-radius:12px}input,button{box-sizing:border-box;min-height:44px;width:100%;margin:8px 0}p{overflow-wrap:anywhere}</style><main><h1>${mode === "synthetic" ? "Synthetic credential intake" : "Credential intake"}</h1><p>${mode === "synthetic" ? "Disposable test credentials only. " : ""}This broker-owned page receives the value. Saving does not assign access or start a run.</p><p>${summary}</p><form><label for="credential">API credential</label><input id="credential" type="password" autocomplete="off" required maxlength="4096"><button>Save once</button></form><button id="status">Check saved status</button><p role="status" id="result"></p></main><script nonce="${nonce}">const cfg=${config};const form=document.querySelector('form'),field=document.querySelector('input'),result=document.querySelector('#result');let sent=${r.state !== "reserved"};form.querySelector('button').disabled=sent;async function status(){try{const r=await fetch(cfg.url,{cache:'no-store'});const b=await r.json();result.textContent=r.ok?'Status: '+b.state:'Sign in again, then check status. Do not submit again.';}catch{result.textContent='Status unavailable. Check again without resubmitting.';}}document.querySelector('#status').onclick=status;form.onsubmit=async e=>{e.preventDefault();if(sent)return;sent=true;form.querySelector('button').disabled=true;let credential=field.value;field.value='';try{const pending=fetch(cfg.url+'/submit',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':cfg.csrf},body:JSON.stringify({credential})});credential=null;await pending;}catch{}finally{credential=null;await status();}};</script></html>`,
      );
    } catch (e) {
      const allowed = [
        "AUTH_REQUIRED",
        "FRESH_PROOF_REQUIRED",
        "NOT_FOUND",
        "NOT_PERMITTED",
        "INVALID_REQUEST",
        "LIMIT_EXCEEDED",
        "REVISION_MISMATCH",
        "INTAKE_ALREADY_SUBMITTED",
        "INTAKE_EXPIRED",
      ];
      const code =
        e instanceof BrokerError && allowed.includes(e.code)
          ? e.code
          : "BROKER_UNAVAILABLE";
      send(e instanceof BrokerError ? e.status : 503, {
        error: { code, retryable: false },
      });
    }
  };
  return Object.assign(handler, {
    reserve,
    status,
    close: () => {
      closeSync(lock);
      unlinkSync(lockPath);
    },
  });
}
