import { createHash, randomUUID } from "node:crypto";
export const VERSION = "broker.v1";
export class BrokerError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function fail(code, status) {
  throw new BrokerError(code, status);
}
export function exact(v, keys, required = keys) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Object.keys(v).some((k) => !keys.includes(k)) ||
    required.some((k) => !(k in v))
  )
    fail("INVALID_REQUEST");
  return v;
}
export function uuid(v) {
  if (
    typeof v !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v,
    )
  )
    fail("INVALID_REQUEST");
  return v;
}
export function string(v, max = 200) {
  if (
    typeof v !== "string" ||
    !v.length ||
    v.length > max ||
    /[\x00-\x1f\x7f]/.test(v)
  )
    fail("INVALID_REQUEST");
  return v;
}
export function list(v, validate) {
  if (
    !Array.isArray(v) ||
    !v.length ||
    v.length > 32 ||
    new Set(v).size !== v.length
  )
    fail("INVALID_REQUEST");
  v.forEach(validate);
  return v;
}
export function operation(v) {
  if (!["item.read", "item.set_state"].includes(v)) fail("INVALID_REQUEST");
  return v;
}
export function limits(v) {
  exact(v, ["max_actions", "max_seconds"]);
  if (
    !Number.isSafeInteger(v.max_actions) ||
    v.max_actions < 1 ||
    v.max_actions > 20 ||
    !Number.isSafeInteger(v.max_seconds) ||
    v.max_seconds < 1 ||
    v.max_seconds > 300
  )
    fail("INVALID_REQUEST");
  return v;
}
export function subset(a, b) {
  if (!a.every((x) => b.includes(x))) fail("SCOPE_EXCEEDED", 403);
}
export function narrow(a, b) {
  limits(a);
  if (a.max_actions > b.max_actions || a.max_seconds > b.max_seconds)
    fail("SCOPE_EXCEEDED", 403);
}
export function input(op, v) {
  operation(op);
  exact(v, op === "item.read" ? ["resource_id"] : ["resource_id", "state"]);
  uuid(v.resource_id);
  if (op !== "item.read" && !["open", "closed"].includes(v.state))
    fail("INVALID_REQUEST");
  return v;
}
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export const digest = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : canonical(v))
    .digest("hex");
export const id = randomUUID;
export function safeError(e) {
  return {
    error: {
      code: e instanceof BrokerError ? e.code : "BROKER_UNAVAILABLE",
      message: e instanceof BrokerError ? e.code : "BROKER_UNAVAILABLE",
      request_id: id(),
      retryable: false,
      next_action: null,
    },
    contract_version: VERSION,
  };
}
// Parse JSON with a grammar walk so duplicate (including escaped) keys never collapse.
export function parseJson(bytes) {
  let s;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_REQUEST");
  }
  let p = 0;
  const ws = () => {
    while (/[\t\n\r ]/.test(s[p] || "~")) p++;
  };
  const str = () => {
    const start = p++;
    while (p < s.length) {
      if (s[p] === "\\") {
        p += 2;
        continue;
      }
      if (s[p++] === '"') {
        try {
          return JSON.parse(s.slice(start, p));
        } catch {
          fail("INVALID_REQUEST");
        }
      }
    }
    fail("INVALID_REQUEST");
  };
  const val = () => {
    ws();
    if (s[p] === "{") {
      p++;
      ws();
      const seen = new Set();
      if (s[p] === "}") {
        p++;
        return;
      }
      while (true) {
        ws();
        if (s[p] !== '"') fail("INVALID_REQUEST");
        const k = str();
        if (seen.has(k)) fail("INVALID_REQUEST");
        seen.add(k);
        ws();
        if (s[p++] !== ":") fail("INVALID_REQUEST");
        val();
        ws();
        if (s[p] === "}") {
          p++;
          return;
        }
        if (s[p++] !== ",") fail("INVALID_REQUEST");
      }
    } else if (s[p] === "[") {
      p++;
      ws();
      if (s[p] === "]") {
        p++;
        return;
      }
      while (true) {
        val();
        ws();
        if (s[p] === "]") {
          p++;
          return;
        }
        if (s[p++] !== ",") fail("INVALID_REQUEST");
      }
    } else if (s[p] === '"') str();
    else {
      const m =
        /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
          s.slice(p),
        );
      if (!m) fail("INVALID_REQUEST");
      p += m[0].length;
    }
  };
  try {
    val();
    ws();
    if (p !== s.length) fail("INVALID_REQUEST");
    const result = JSON.parse(s);
    const finite = (x) => {
      if (typeof x === "number" && !Number.isFinite(x)) fail("INVALID_REQUEST");
      if (x && typeof x === "object") Object.values(x).forEach(finite);
    };
    finite(result);
    return result;
  } catch {
    fail("INVALID_REQUEST");
  }
}
