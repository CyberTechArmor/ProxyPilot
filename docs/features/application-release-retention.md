# Nodus release cleanup

The target policy in `admin/backend/src/lib/mcp-policy/application-release-retention.json`
opts Nodus into cleanup under the application's existing guest lease. Other
applications are unchanged.

Each validation removes abandoned generated staging attempts after checking
that prior writers stopped. The current attempt is preserved during its
build; its workspace and transferred source archive are removed after failure
or successful sealing. Interrupted cleanup is retried on the next validation.

After validation, retain the live release and the incoming validated release,
or the live release and one recent fallback. Roots backing preserved shared
models/data are always protected. Only recognized sealed release directories
are eligible; unknown files and staging symlinks are left alone. The live
pointer is rechecked before each obsolete-release deletion.

New artifacts discard generated `.cache` content after validation and before
their artifact digest is computed. Tracked `.cache` files refuse this step.
Existing sealed live releases are not modified, preserving their integrity
evidence. No database, environment file, shared model, or live dependency is
removed.
