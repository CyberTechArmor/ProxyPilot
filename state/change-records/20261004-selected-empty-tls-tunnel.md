# Selected browser empty TLS tunnel cancellation

Status: In progress; source and cloud fixture evidence only.

The UI-only PR745 CI backend job111408271331 reported an actual Chromium149
delayed continuation failure after an approved temporary destination. Its
gateway recorded HTTP_REQUEST_INVALID with no request reference, followed by
GATEWAY_PAUSED. This code comes from request-line parsing before admission,
not from the previously fixed304 response handling. The retained CI log does
not prove whether that request line was empty or malformed.

A deterministic real CONNECT/TLS test reproduces one legitimate cause: a
successful tunnel whose client sends TLS close_notify before any HTTP request
bytes. Chromium may cancel a speculative tunnel this way. Previously that
empty stream was indistinguishable from a malformed request and froze the
whole attempt.

Request parsing now distinguishes zero bytes as HTTP_REQUEST_EMPTY only at
the post-CONNECT TLS request boundary. The handler audits a bounded
client_closed_without_request event and closes the local tunnel without
changing gateway state. No ticket is consumed, request/effect counter advanced,
DNS/upstream contact made or blocked request replayed. The original exact
single-use ticket remains valid for its original request. Partial or malformed
nonempty lines, incomplete headers, unauthorised CONNECT destinations and
transport errors retain existing strict refusal and freeze behavior.

The new actual socket/TLS regressions prove empty cancellation, untouched
authority/accounting, a subsequent real upstream read, nonempty partial-line
refusal and explicit revoke/drain cleanup. The full gateway suite has50 tests:
49 pass and one existing AF_UNIX socket-creation EPERM remains in this cloud
environment. Actual cross-language Chromium133 tests cover immediate and22s
delayed continuation separately; CI Chromium149 and live installed acceptance
remain required. This record does not reclassify the historical CI failure or
the production downloads/video failures as accepted behavior.
