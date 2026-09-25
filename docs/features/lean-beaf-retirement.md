# Lean BEAF retirement

The Lean BEAF UI, `/lean-beaf` routes, `/api/lbp` router, AI assistant,
SharePoint import script, PWA shortcut and Flightdeck/MCP card-linking hooks
have been removed. Dev Studio at `/projects` remains available under its
existing gate and permissions. The separate Operations workflow is implemented
at `/operational-projects`, controlled by its own default-off feature gate.

## Permanent database deletion

Migration **706, `lean_beaf_retirement`**, runs through the normal main-DB
migration runner on a future authorized startup/deployment. It permanently
drops the 20 feature tables and deletes four exact feature setting keys,
including the encrypted feature API-key setting without decrypting it.
It does not revoke an external provider key, change integrations, delete
users, touch Flightdeck data or remove global audit history. Historical
migrations 700–705 and their registry entries remain unchanged so fresh and
upgraded databases follow the same recorded sequence.

This migration has no down migration. Code rollback alone cannot recover
removed records. Before authorized deployment, preserve the usual verified
backup and agree its retention; restoration is an operator recovery operation,
not part of this patch. SQL deletion is not secure erasure of old SQLite pages,
WAL files or backups. Existing copies follow their separately agreed retention.

## Uploaded files

SQL does not delete files. The retired route used `LBP_FILES_DIR` when set;
otherwise `lbp-files` beside the parent of the database directory (for example
`data/lbp-files` with `data/db/proxypilot.db`). Before a future cleanup, resolve
the actual absolute upload directory from deployed configuration, verify it
is dedicated to Lean BEAF and contains no shared data, and include it in the
backup/retention decision. Remove that verified directory only during an
explicitly authorized cleanup. Do not infer a path from an API request or
erase an entire data directory. No uploaded files or live databases were
accessed during preparation of this patch.

Browsers may retain an inert `lbp-assistant-open` preference; no current code
reads it. It contains no guide, credential or operational data.

## Validation

`node --test src/__tests__/lean-beaf-retirement.test.js` uses Node's built-in
SQLite with an in-memory fixture, real historical schema functions and foreign
keys enabled. It checks deletion scope, unrelated data/history preservation,
repeatability and rollback on failure. It never imports the production DB or
starts the backend. The production runner uses better-sqlite3; deployment and
actual-host migration/restore validation remain separate release checks.
