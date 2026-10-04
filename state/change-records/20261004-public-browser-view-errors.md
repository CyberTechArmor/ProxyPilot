# Public browser viewing and wording follow-up

The owner authorized selected-runner public browsing through independent review,
CI, deployment and real verification. This is a focused follow-up to PR740.

The deployed Python homepage visibly rendered using transient frames, then
stopped with signed closure of all four boundaries. The subsequent downloads
launch returned frame500 and then429 during the fixed cooldown; pixels were not
proven. Its Stop also proved closure. The cause is not yet established.

Improve public-mode instructions and separate execution from video status.
Preserve safe fixed runtime refusal codes through the public frame API instead
of reducing all capture failures to generic500. Never return error messages,
page text, URLs, diagnostics or arbitrary runtime error codes. Wait30s after a
capture failure or rate limit; retain sequential requests and cancellation.
Disable idle readiness during active runs, and refuse the server-side probe
before contacting the runner when active execution or unverified cleanup exists.

Runtime helper bytes, host protections, private/agent flows and historical runs
remain unchanged. No idle boundary checks during active runs. Post-update fixed
Install and Recover are blocked by fresh authentication; no bypass is authorized.

Acceptance requires live verification after deployment; source checks alone
cannot resolve the retained viewing failure.
