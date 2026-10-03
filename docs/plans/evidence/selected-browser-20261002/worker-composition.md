# Selected browser composition evidence

This is local cloud evidence for the reviewed repository sources, not an
installed supervisor acceptance claim. No production execution, deployment,
external website task, network allowance, or managed policy change was made.

## Request and action findings

The actual Chromium + bundled guest + host request pump + TLS gateway fixture
first exposed browser-owned traffic hidden by the older local CONNECT relay:
network-time queries, AI search eligibility, Gaia ListAccounts, and GCM check-in.
The gateway rejected that traffic before target DNS/upstream contact. This
produced a usability failure and was not treated as successful browser readiness.

Fixed selected-only service settings suppress those requests without admitting
them: `NetworkTimeServiceQuerying` and `AimEnabled` are disabled;
`--allow-browser-signin=false` disables browser account signin; fixed
`--gcm-checkin-url=about:blank` and fixed
`--gaia-config-contents={"urls":{"list_accounts_url":{"url":"about:blank"}}}`
give only browser-owned service fetchers non-network endpoints. Neither flag
accepts caller input. Explicit page URLs, including a synthetic
`https://accounts.google.com` website, still use CDP Fetch and the independent
gateway. `--gaia-url=about:blank` was tested and removed: the newer origin
override accepts HTTP(S) origins only and ignored the non-network value.

Incognito/Guest, no-startup-window, system-profile, and a separate DevTools
off-the-record context did not solve browser-owned startup traffic. Those
experiments were removed. The existing private attempt profile, ordinary browser
startup, headful kiosk arguments, managed policy and demo path remain in use.

The composed fixture also exposed redundant main-page attachment: browser-level
auto-attach offered the page already attached by the base runner. Two Fetch
agents minted two tickets for one network request; one authority remained
outstanding. The selected adapter now retains the original gated main session
and detaches the redundant session before enabling a second Fetch agent. A
targeted fixture covers primary attach event before/after its command reply.

Native `requestSubmit()` returns before its POST Fetch event. The adapter now
keeps the same action refs through network review and native page load, and
refuses a submission with no observed network trigger within a bounded three
seconds. Request approval itself remains bounded by the attempt deadline.
Primitive DOM completion is never a business-write readback.

The real host/Chromium fixture also performs two sequential local click
primitives that change page text without any Fetch. Both return
`BROWSER_LOCAL_OPERATION_COMPLETED`, retain the private unverified-effect marker,
and leave the gateway request count unchanged. A subsequent form
`requestSubmit()` whose handler calls `preventDefault()` without a Fetch returns
guest `SUBMISSION_NETWORK_NOT_OBSERVED` and host uncertain
`SITE_EFFECT_READBACK_REQUIRED`. The durable action stays uncertain; replay and
a new ordinal are refused. Decision, draft-input, and report admission are all
refused before the provider bridge. The fixture checks the origin receives only
the initial GET, with zero sent/uncertain wire effects and zero outstanding
requests. This proves useful local form preparation without a business-save
claim or an automatic continuation after explicit submit intent.

## Off-list and denial semantics

An off-list Fetch request is failed permanently. A destination grant does not
continue that original request. The host settles its action only after the
guest reply and gateway counters prove no effect was sent/uncertain and no
request remains in flight/outstanding. The blocked record is signed, the base
allowlist remains unchanged, and only a fresh observation/candidate/ordinal can
offer a new operation. A destination grant supplies no payload-effect approval.

The real TLS proxy keeps a request held for more than ten seconds, then sends
its exact reviewed payload once. A real POST followed by an off-list resource
prevents blocked settlement/grant with `BROWSER_ACTION_UNCERTAIN` and never
replays the POST. Agent Deny returns a signed before-contact result and requires
fresh observation. Manual-mode Deny discards the real held request and keeps
auth capture paused. The guest returns all discarded opaque refs so the host
tombstones events still queued at pause.

Session-cookie fixtures prove that explicit website cookies persist through
manual-auth pause/release and that a new attempt workspace imports no cookie.
Cookie values do not appear in model observations. The manual test uses a
typed headless CDP input transport fixture and explicitly does not attest Neko
media or controller custody.

## Primary Chromium implementation

Local browser: `Chromium 151.0.7922.173`, Debian 13 build. Reviewed immutable
primary source tag: `151.0.7922.173`.

- [GaiaConfig](https://github.com/chromium/chromium/blob/151.0.7922.173/google_apis/gaia/gaia_config.cc): fixed `gaia-config-contents` parsing and valid per-service GURL override.
- [GaiaUrls](https://github.com/chromium/chromium/blob/151.0.7922.173/google_apis/gaia/gaia_urls.cc): configured `list_accounts_url` is read separately; `gaia_url` requires an HTTP(S) origin.
- [GCM service settings](https://github.com/chromium/chromium/blob/151.0.7922.173/google_apis/gcm/engine/gservices_settings.cc): `GetCheckinURL()` returns the exact `gcm-checkin-url` GURL override.
- [AI eligibility service](https://github.com/chromium/chromium/blob/151.0.7922.173/components/omnibox/browser/aim_eligibility_service.cc): `AimEnabled` guards browser eligibility requests.

SHA256 pins for the fetched source bytes, in the same order:

```
gaia_config.cc             f5115c9db0e3dbb5614f0dab314050db42fa77508255d83bdb30146dfdc6ec63
gaia_urls.cc               f7ebb3b9faf5bbccbc0f26faebdaf7bd9783731f6eadad02475f0b1cd62f2a9c
gservices_settings.cc      b2849fb776c571240b1b1d205ed5355ec2de5f7460c7b80a0a74af6086a30cd0
aim_eligibility_service.cc e64a1600799f40ebf4a4f42f98fc701d6f6e736d9995c510a01331764e031405
```

No URL bypass, Google destination grant, disabled gateway enforcement, startup
grace period, retry, or enlarged legacy startup timeout was used.

## CI startup diagnostic limitation

PR726 head `dc8080c` broker workflow `37076010012`, job `111065963504`, reported
one first-test `Target.setDiscoverTargets` startup timeout; other Chromium tests
ran. Its log omitted Chromium stderr/process state. No matching failure has
been reproduced locally, and its CI cause remains unproven. The test constructor
now captures bounded synthetic-only Chromium version, process state, exit/CDP
closure state and filtered stderr before shutdown. Product selected-site
diagnostics stay withheld. No retry, skip or blanket timeout increase was added.

Final selected-worker suite: **26/26 passed**, 34.189 seconds,
`/tmp/pp-worker-final.log` (22 Chromium tests and 4 closed-shape/order fixtures).
Earlier composed host/gateway checkpoint: **6/6 passed**, 20.764 seconds,
`/tmp/pp-sbc-final.log`. Python compilation and `git diff --check` passed.
Additional local-preparation/uncertain-submit composition regression:
**1/1 passed**, 4.519 seconds, `/tmp/pp-sbc-local-preparation.log`.
Historical seven-case composed host/gateway checkpoint, run by the host/gateway agent
against its frozen sources: **7/7 passed**, 24.760 seconds, exit 0, zero skips,
`/tmp/pp-sbc-final-gateway.log`.

SHA256 pins for that seven-case checkpoint:

```
test_selected_browser_composition.py 51ba632e60824953fb8e726f35152e3ac69eb0ae601e6a8b9119ff3a93f62633
selected_browser_supervisor.py        10cb3df87db76d0b7f90ef21accb64f21a6a98bd3e54e3cb4fdbe62e17c87077
selected_browser_gateway.py           2a27c3a875ce2267905d7748d03884b8ca88a556a38faa1c1c54abba9be961ec
a3-worker-supervisor.py               a74c497081e59e1b19d11e0bb94ebfc0e2543b17399349e12407bbe6300673bb
```

## Fixture process cleanup follow-up

The fixture wrapper starts Chromium in a separate process group/session. Its
former fake-host stop killed only the guest's group; a forced guest exit could
leave a browser running. The fixture now atomically records the browser PID and
Linux process start time after `setsid()` and before exec. Both fake-host stop
and unconditional teardown verify that identity and kill only the recorded
session. Every case asserts that no live process in its browser group survives;
already exited zombie entries are not counted as running browsers.

The forced guest-death regression deliberately stops the owned browser before
killing the guest. This keeps a healthy Chromium's voluntary CDP-EOF exit from
masking the cleanup gap. The already-dead guest case still cleans the browser
group, and an independent process in another session remains alive.

Six historical experiment groups were removed only after confirming each
leader's PID, start time, parent 1, group/session identity, and exact fixture
profile path. Their leaders were `109671`, `110093`, `115256`, `119833`,
`121981`, and `122593`; subsequent scans found zero live members of those exact
groups. No broad process-name signal was used.

Focused forced-death regression: **1/1 passed**, 1.938 seconds,
`/tmp/pp-sbc-forced-cleanup.log`. Final composed suite with the original seven
semantics and added cleanup case: **8/8 passed**, 29.366 seconds, exit 0, zero
skips, `/tmp/pp-sbc-owned-cleanup-final.log`. Final composition source SHA256:
`4fe9b212596f04744396236a84dd1992cb1ad7c400fed499a85bed3fef0f3fcf`.
All product source pins and browser arguments remain unchanged.

Frozen source SHA256:

```
a3-worker-guest.py         a03e0dd6d2fa67b82c2a87fa71432763fe6a6b3437da3d7c7a13213358707f8c
selected_browser_worker.py f03179afc7c97309789f3c32d56125092a2bc16ec63968c4307a7fff8901b536
```

Installed Incus/nft ownership, actual managed-policy kiosk
behavior, Neko custody, provider integration and cleanup acceptance remain
separate release requirements.
