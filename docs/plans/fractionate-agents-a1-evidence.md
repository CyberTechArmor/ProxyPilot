# A1 review evidence — repository handoff

Date: 2026-09-25. Branch baseline before this review:
`d5f6483baa4637c3e10f90374aea9ba79c3a2e9c` (tree
`f984051d3ec37dc2f81ee48c9d2cfd9466312cf7`). The checkout already had
uncommitted demo source and A1 documents; they were preserved. The detailed
local baseline, source hashes, adjacent trackers, patch and verification are
under `../../../agents-a1-evidence/` in the working workspace. This page
keeps the decisive facts accessible after a repository merge.

## Live demo site

Read-only ProxyPilot checks found HTTPS `demo.fractionate.ai` routed by Caddy
to Incus guest `pp-fractionate-demo` (`fractionate-demo`) at
`10.185.17.210:4179`. Its ACME certificate covered the name and was valid
`2026-09-25T16:56:54Z` through `2026-12-24T16:56:53Z`. The guest and
`fractionate-demo.service` were running; systemd executed
`/usr/bin/node /opt/app/demo/server.mjs` as `www-data` from `/opt/app`.
Edge-pinned and direct-upstream probes returned 200 for `/` and
`/api/session`, 401 for an unsigned CSV download. The public browser loaded
the HTTPS landing page, signed in with the public fixture, displayed
`demo@fractionate.ai` at `/workspace` and `sample-metrics.csv`, received a
browser download event, and signed out. The download event does not establish
an independent checksum of the browser's downloaded bytes.

| Deployed path under `/opt/app` | SHA-256 matched to local file |
|---|---|
| `startup.sh` | `66651a700a7e1039c225af5745ccc3306a2097268d60e71d5140df445254732a` |
| `demo/server.mjs` | `f83d81891973c2727175f8864c557ebedaa62a27e5a3f47406bb7e2a95bfdf6a` |
| `demo/files/sample-metrics.csv` | `74149e5dbeb3fe9e49794a308534b1b4cabc6b44ebad1d7d0ce4793ecaa08033` |
| `dist-demo/index.html` | `d606edc1cbc52f145a968f995585dc5025bc8868b20ad5368a00a22997c33596` |
| `dist-demo/assets/index-nBpnGfVM.css` | `1729e874a5fc51af919aeaac0c868c45eb4f657410ba73e2203ae80c5713e994` |
| `dist-demo/assets/index-BGbweaME.js` | `b5a7cf7a486923dd71928ca55160eb4d93957610a245291427f8f7046e0c3adf` |

The deployment archive had no attested manifest or commit reference when
installed from uncommitted source. These hashes establish file identity, not
that the original deployment was made from a commit. The website is an
application target, not an agent worker, credential-isolation proof or A8
agent deployment acceptance.

## Review and verification

The [architecture](fractionate-agents-a1-architecture.md),
[pilot contract](fractionate-agents-a1-pilot-contract.md),
[acceptance matrix](fractionate-agents-a1-acceptance.md),
[source/dependency register](fractionate-agents-a1-sources.md),
[project/credential backlog](fractionate-project-credentials-backlog.md) and
[A2 prompt](fractionate-agents-a2-prompt.md) are the review handoff.
Current local checks: the bundled Node.js demo smoke test passed 1/1;
Vite 6.4.3 built 1,410 modules and reproduced all three deployed frontend
hashes above; `git diff --check` passed; the A1 documentation verifier checked
local links, preserved source hashes and migration status. The verifier's
exact count and patch hash remain in the adjacent evidence directory.

The user will create the first Operations project and specify its final site.
The exact project ID, current independently approved guide version/hash,
human authority and pilot limits are not yet approved. A1 therefore remains
**in review**; A2 has not started. S6, SEC-01–05, INF-01–04 and A8 target
proof remain open.
