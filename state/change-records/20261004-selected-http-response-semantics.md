# Selected gateway conditional responses — 2026-10-04

The selected/general-site gateway treated every 300–399 response as a redirect
requiring one Location. This rejected valid 304 cache revalidation and 300 choice
responses without a preferred destination. RFC 9110 sections 15.4.1 and 15.4.5
describe these distinct responses: https://www.rfc-editor.org/rfc/rfc9110.html.

The gateway now permits Location absence for 300 and 304 only. It still screens
every supplied Location, rejects ambiguous duplicate headers and requires one
Location for every other admitted 3xx response. Redirected requests still need
their own one-use ticket, DNS/address/route/actual peer screening and finite
accounting. No retry, destination grant, cache persistence or acceptance is added.
The legacy demo remains unchanged.

Validation: 20 public capability/protection tests pass, including cache/choices,
strict redirect admission, protected optional Location and single-use accounting.
The selected gateway suite runs 48 checks: 47 pass including actual local TLS
conditional readback; the existing Unix control socket check fails with cloud
PermissionError at socket creation. Both runtime Python and system Python show
the same environmental refusal; no test was weakened or skipped. 41 selected
supervisor lifecycle tests pass. Local transport proves source behavior only,
not installed Incus/nft/TURN or real website compatibility.

Release: exact-tree independent review, published CI, merge/application delivery,
dedicated fixed runtime Install and actual installed navigation remain pending.
Prior Python downloads frame500/429 and continuous video failure remain unresolved.
The successful 09:09 fixed Install predates this source correction and must not
be represented as having installed it.
