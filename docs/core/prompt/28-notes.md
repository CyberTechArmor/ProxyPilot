<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 1454-1461) -->
<!-- Index: docs/core/prompt/README.md -->

## Notes

- `proxypilot` Postgres database reserved but empty. Ready for SQLite migration if needed.
- `--skip-infisical` prints warning on every command.
- Bridge gateway `10.0.100.1` is stable. Changing requires full reconfig.
- Instance UUID in `instance_meta` for future federation.
- Compliance templates: Markdown with `{{placeholders}}`, operator-customizable.
- HIPAA requires 6-year policy retention. Audit log rotation is 365 days on disk; offsite archival handles longer retention.
