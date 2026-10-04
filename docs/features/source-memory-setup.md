# Private Source Memory setup

An administrator can open **Projects & SOPs → Operations settings → Private
Source Memory**, review the local storage boundary, and choose **Review and
enable local Source Memory**. Fresh sudo confirmation happens before the one
setup POST. The request accepts an empty object only; there are no caller paths,
credentials, parser choices, model consent or run inputs.

This is an explicit review of the stock unconfigured storage boundary. It never
rewrites `.env`, turns on Operations toggles, restarts the dashboard, enables a
parser or grants disclosure/execution authority. Any existing artifact directory,
quota or independently reviewed environment configuration is preserved and the
local setup action is refused. `OPERATIONS_BROWSER_LOCAL_STORAGE_DISABLED=true`
is an explicit operator veto of this local review; independently configured
storage remains governed by its existing settings.

The service creates only `/var/lib/proxypilot/browser-private`, outside the
checkout, under a preexisting safe ancestor chain. It requires the current
service UID and exact mode 0700, rejects links, unsafe or replaced ancestors,
unknown occupied roots and raced directory creation, and never chmods/chowns
or moves existing private bytes. Creation uses the reviewed parent descriptor.
The existing private adapter verifies a real UUID object's write, read, length,
SHA256 and deletion before the administrator review and linked audit are committed
atomically. The probed directory's original device/inode remains pinned through
that commit. Failed verification cannot persist activation; cleanup cannot delete
unknown replacement bytes and always closes the adapter and clears buffers.

A successful setup reports **Verified · owner backend restart required**. The
installation owner must restart the dashboard backend, or perform the ordinary
app update that restarts it. Browser refresh alone does not activate storage.
On the next backend start, the receipt, linked audit, exact directory identity,
permissions, service UID and existing out-of-checkout validator are rechecked.
The existing runtime adapter must still initialize successfully; otherwise Source
Memory remains unavailable. The ordinary installed Docker layout already mounts
`/var/lib/proxypilot`; setup neither adds mounts nor falls back to another root.
Native/custom deployments must make that fixed boundary available deliberately.
The storage validator excludes the whole source checkout in a repository layout,
or the whole `/app` application tree in the packaged Docker layout. It excludes
ancestors too; the Docker image's shorter path must not make `/` the application
boundary and prevent setup of the dedicated `/var/lib/proxypilot` storage.

Installation quota is 256 MiB; existing account/project caps remain 128 MiB,
individual objects remain at most 16 MiB, and reservation, retention, deletion,
lease, source review, exact approvals and cumulative run budgets are unchanged.
Basic bounded page-text memory and supported text sources require no decoder.
Image normalization/redaction and PDF interpretation stay unavailable without
their separate reviewed process boundaries.

The review and audit live in the installation database. Copying a setting alone,
restoring onto a different directory/inode or removing its linked audit refuses
activation. A full same-host database/audit restore with the same physical
private root can retain that installation review. The storage review itself grants no source lease, disclosure consent or run
authority; existing authorization, current-attempt and expiry checks still apply
after restore.
Host administrators can alter both database and local files; this is not an
independent custody/audit or encrypted backup system. Missing or replaced storage
requires owner inspection; there is no automatic migration or fallback.
