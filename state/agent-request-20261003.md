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
