# Running build identity and pinned guidance

## Scope and result

First implementation tranche of the cloud continuation. The prior PR 726 release
is already merged and deployed at 91472e9e34; it was not rebuilt here.

The Docker image now records build SHA, UTC build time and dirty-source state.
The runtime reads that immutable file separately from the host checkout, package
version and release tag. Missing metadata remains unknown. The package version
comes from the running artifact rather than a persisted installed_version value.
The update API reports running/checkout disagreement and compares Mock2 source
versions within the Mock2 family; the UI labels the distinctions explicitly.

Thirty canonical Mock2 1.14.0 guidance files are pinned with SHA256 identities and
emitted in new project seeds. The current constitution is included in framework
content alongside preserved platform security/execution contracts. Existing
project files are not overwritten; runtime Relay integration and consumer rollout
remain subsequent work. No application dependency versions, schemas, credentials,
network rules, browser activation or existing integrations are changed.

## Validation

- Focused backend: 53 passed, zero skipped (Node 24.19.0; build identity, update
  logic/driver, framework validation, standard seed and source hash parity).
- Updater Python regression selection: 33 passed. Restricted process visibility
  initially failed two terminal-origin cases; running with the required process
  visibility passed all 33 without changing those tests.
- Frontend production build passed; existing chunk-size/dynamic-import warnings.
- Actual SelfUpdatePanel rendered using a mocked API in headless Chromium 133:
  360, 375, 768, 1280 and 1920 px, expected identity/adoption text and no horizontal
  overflow with the CSS overflow guard disabled. This is a local substitute
  browser, not acceptance on the user's phone or a live deployment.
- Shell syntax, JavaScript syntax and git diff whitespace checks passed.
- New tests are included in Security regression CI. Remote CI and live deployment
  are not yet verified by this record.

## Review and remaining work

Implementation-context review checked the metadata path, Docker build arguments,
unknown/dirty handling, separate version families, preserved platform contracts,
source-byte hashes and lack of existing-app mutation. This is not an independent
review. The updated driver test generates a newer source version relative to the
seed instead of assuming the obsolete 0.4.0 fixture is newer forever.

Next: review/CI for the exact published candidate; deploy and verify actual running
identity; implement Relay deployment capture; inventory and hash-plan consumers,
then per-app rollout and health verification. Selected-browser activation and
storage/search remain later work under the original handoff.
