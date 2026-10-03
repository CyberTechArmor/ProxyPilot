# Current browser delivery authorization and checkpoint

The owner's updated 2026-10-03 instruction supersedes the historical terminal-only
and all-capability gates below. Implementation, review, CI, merge, deployment and
necessary fixed runtime installation are authorized for ProxyPilot/browser only.
No Incus upgrade, other hosted application update, local/Duo work or temporary
SSH key. Use the existing new selected runner; do not generalize the legacy demo.

Deliver public navigation and live view first; then actual model-driven tasks;
then private sign-in, action authorization, files and explicit internal access.
Optional features must remain honestly unavailable without disabling working
public navigation. Retain process isolation, host/credential protection, stop,
cleanup and recovery. Acceptance comes from actual checks, never a toggled flag.

Current deployment: PR732 merged as `829944a8ec4bdaa9e6bdd4663f276cae77a6e439`.
The first update `116d5a68-4e5d-4225-8bae-0cd4e7ac9e93` exited 75 at the
existing service-lifetime transition check. Rebuild
`62fbe678-8f9a-4c8b-87f3-70cda056492d` succeeded at 18:16:36Z. Dashboard and
host agent both identify `829944a8ec`; recovery unit is loaded; existing A3/A4/A7
services remain active. These facts do not prove package installation.

The fixed install/recover/rollback operation is exposed in Profile → Application
settings → Browser runtime, POST `/api/user/version/browser-runtime`, and MCP
`manage_browser_runtime`. It uses the root host runner and private operation
journal without depending on a terminal connection. The current conversation's
MCP catalog lacks that newly deployed tool and its cloud browser remains signed
out. Actual installation has not been invoked. Last measured selected runtime:
`selected_browser_available=false`, `separate_runtime_package_required`.

PR733 then merged as `cad71e96f61b9640ba3c69fc4754ec1c1f2fffec` and deployed
successfully through `233d0b85-916b-442c-9881-d951a879044d` at 18:26:22Z.
It allows ordinary application delivery to preserve a committed runtime generation
while newer package source awaits the explicit installer. No package is installed
by that update. The running build and agent identify `cad71e96f6`.

The continuation tracker is `state/browser-delivery-20261003.md`.

---

## Historical checkpoint (superseded where inconsistent above)

# ProxyPilot agent request continuation — 2026-10-03

Scope: ProxyPilot and its browser agent only. All consumer-app standards upgrades are deferred by the owner. No Incus upgrade requested.

## Deployed checkpoint

PR729 was reviewed, all ten CI jobs passed, and merged as 2ae311c8fd54df7db3f6fa908479cdc62ed1df56. Update a31923aa-513c-446e-9666-2ff24d0ba1b7 succeeded at 15:44:37Z with an empty flag list. The live updater defaults UPGRADE_INCUS=false; its runner disallows --upgrade-incus. Running image and host agent identify 2ae311c8fd; Mock2 guidance source is 1.14.0 and current. Correct stale MCP descriptions that incorrectly claimed ordinary updates upgrade Incus.

## Request editor change

Website and plain-language source appear before the structured fields. Additional task rules can be set or skipped; skipped text is excluded from the conversion source. Selected rules are instructions for interpretation, not a newly enforced policy language. The original composed request is retained through conversion, validation and immutable save. The existing provider converts it into editable settings. Device keyboard dictation can enter text; this change adds no audio recording/transcription service.

Advanced JSON is collapsed when conversion controls are available. Draft-only installations explicitly explain that automatic interpretation is unavailable. Demo profiles remain usable but are collapsed when the selected-browser workflow is present. No demo boundary is widened and no acceptance marker is fabricated.

## Verification

Production frontend build passed. Real Agents page/HTTP/SQLite browser proof passed with a scripted conversion response; skipped/selected rule inclusion, stale suggestion refusal, explicit save, source retention, and five viewports (360/375/768/1280/1920) were checked. All five had zero overflow and axe violations. Mobile Lighthouse accessibility scored 96/100 on the real Agents page. Independent review approved after correcting the draft-only fallback wording. Existing six C0 HTTP/SQLite journeys passed, with no model calls or external contacts. Browser-agent and authentication unit test files passed. This is UI and persistence evidence, not a real-provider or installed-browser acceptance claim.

## Remaining execution blocker

The live update reports selected_browser_available=false, reason=separate_runtime_package_required. The proof VM and existing supervisor/proxy/fence services are running. Selected-site execution requires the separately reviewed 25-file package, private input/decoder storage and actual host acceptance. Installed expanded-package ordinary-update compatibility remains unresolved in the package contract. These gates must not be removed to simulate readiness.

The current connector exposes no host-root shell or selected-package operation. The next read-only operator step on the ProxyPilot host is:

```sh
sudo python3 /opt/proxypilot/scripts/selected-runtime-package.py plan --operation install
```

This measures the real target and produces the plan digest; it does not install or activate. Review its result before the separately approved root TTY review/apply sequence and installed acceptance testing. No claim of arbitrary-site execution, synthetic-login restriction removal, or successful real-provider conversion is made by this editor change.
