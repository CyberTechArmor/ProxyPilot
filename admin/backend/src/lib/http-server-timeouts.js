// The HTTP server's request-body clock, and why it is off.
//
// Node's http.Server has had `requestTimeout` since 18: the whole request,
// headers AND body, must arrive within it or the socket is destroyed with
// an 'aborted' error on the request. The default is 300 000 ms, checked on
// a 30 s interval. That is a sound default for an API that takes JSON, and
// exactly wrong for the routes that take a BODY measured in gigabytes: the
// migration agent PUTs a whole rootfs as one stream, a guest export restore
// PUTs a tarball, and an upload ticket takes a zip. Migrations #12 and #14
// (a 249 GiB rootfs at ~85 MiB/s) both died 5 min 17 s and 5 min 24 s into
// the upload — the 300 s clock plus one check interval — and the failure
// line said "the agent died or lost its connection", which it had not.
//
// `requestTimeout` is per server, not per route, so the body clock is
// switched off here. What still guards the server: `headersTimeout` (60 s
// by default — a client that never finishes its headers is dropped),
// Caddy in front of it, and the fact that a body that stops arriving
// stalls on a socket Caddy will eventually close. A slow-body slowloris
// against the API's own port is not a threat this deployment exposes.

export const HEADERS_TIMEOUT_MS = 60_000;

/**
 * applyStreamingTimeouts(server) — a long request body is never a reason to
 * kill a request. Returns what it set, for the log line and the test.
 */
export function applyStreamingTimeouts(server) {
  server.requestTimeout = 0;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return { requestTimeout: server.requestTimeout, headersTimeout: server.headersTimeout };
}
