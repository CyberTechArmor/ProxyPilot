# Native browser CI startup isolation

At exact commit `cbd0c9e141a2ccf7ff5f7ce913f08f83c2490161`, broker workflow
37123538738 failed only its native browser case: 461 of 462 tests passed.
The bounded failed-Start assertion proves the fixture launch RPC reached its
unchanged 20-second deadline after 20002ms. Actual Chromium 154.0.8037.0 was
still waiting for worker readiness, with zero gateway requests, effects,
in-flight requests or outstanding requests. No website or browser-service
request reached the gateway. The stream was then permanently refused.

Security workflow 37123538735 passed on the same commit. Its native case took
14.375 seconds, including a 9126ms launch. Both complete Python suites passed
474 tests with 33 existing skips on actual Chromium 154. Concurrent resource
contention is a plausible inference; these logs contain no CPU-pressure
measurements. The original 307a85 failure's launch cause remains unproven.

Scheduling commit `21e2d51be879441fd84e7323ca728e6b36233b14` moves the exact
native lifecycle test into its own next step in both workflows. Expanded
selection checks retain every original file exactly once: broker 47 files
become 46 unit files plus one native file; Security 34 become 33 plus one.
All other workflow structure is unchanged. YAML, shell syntax and diff checks
passed. The isolated cloud proof with `CI=true` passed one case with no skips
in 3.048 seconds, including a 750ms launch on Chromium 151.0.7922.173.

The 20-second RPC, 60-second test and 5-second close bounds, assertions and
CI browser requirement remain unchanged. No retry, skip, startup setting,
destination rule, production contract or execution authority changed.
The local proof's final uncertain state preserves the existing honest
website-effect result; it does not invalidate the passing continuation proof.
Fresh exact-head CI is still required before claiming this startup failure
resolved. No live site, real provider or installed host acceptance was used.

`ci-start-failure.json` retains the bounded actual Start diagnostics.
`ci-comparison.json` retains same-commit test totals, phase timings and browser
versions. `selection-validation.json` records expanded file coverage.
`isolated-actual-proof.txt` preserves the local proof unchanged.
`log-provenance.json` records complete decoded CI job-log SHA256 values and
derivation boundaries; raw logs are not copied into this bundle.
`verification.json` pins the scheduling commit, source/workflow bytes and
validation limits. `manifest.json` hashes every retained evidence file.
