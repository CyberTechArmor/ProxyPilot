# Incus version and Debian 13 image

As checked on 2026-09-26, upstream Incus stable is **7.5.1** (the 7.5.0
artifacts were re-released as 7.5.1). The Incus API remains under `/1.0` and
advertises additions through `api_extensions`. ProxyPilot continues to use
the documented CLI operations; `incus launch --device root,size=<size>` now
applies a requested root size at creation. A failed override fails creation
and the lifecycle runner removes any half-created instance.

New ProxyPilot installs use Zabbly's `stable` APT channel on its supported
Debian 12/13 and Ubuntu 22.04/24.04/26.04 releases. The installer verifies
the repository key fingerprint before installing the current channel package.
The Create dialog and `create_lxc_container` MCP tool default to
`images:debian/13`; Debian 12 remains selectable. Incus downloads a separate
VM image when `--vm` is requested, even if the container variant is cached.

## Existing hosts

`update.sh` now checks the signed Zabbly stable channel even when the
ProxyPilot checkout is current. If a newer Incus package is available, its
single-host upgrade step requires Linux 6.12 or later, an apt simulation with
no non-Incus package removals, a readable instance and storage inventory,
adequate backup space, a verified archive of `/var/lib/incus`, SQL dumps and
recursive ZFS snapshots of external Incus storage. Unknown storage drivers,
external directory pools and clustered servers fail closed. The updater
records the checkpoint path and verifies daemon response and instance count
after the package change. It does not automatically downgrade a daemon whose
database may have migrated; the checkpoint is retained for operator recovery.
The Incus package step can interrupt Incus management and guests during the
service/package restart. A full update can take longer than a dashboard-only
rebuild.

The installer and updater explicitly set `images.auto_update_cached=true`
and `images.auto_update_interval=6` and read them back. These settings apply
to future alias downloads. Incus does not auto-update fingerprint-pinned
images or previously copied images that were not marked `--auto-update`, and
image refresh does not update an already-created guest's OS packages.

Before this updater revision, the observed pilot host reported Incus
`6.0.4-2+deb13u6`, with only `6.0.4-2+deb13u10` available from its configured
Debian repositories. Its A3 worker
isolation acceptance remains blocked until a disposable target proves the
specified network and resource controls; a newer version alone is not proof.

Sources: [Incus 7.5 release](https://linuxcontainers.org/incus/news/),
[launch reference](https://linuxcontainers.org/incus/docs/main/reference/manpages/incus/launch/),
[REST API](https://linuxcontainers.org/incus/docs/main/rest-api/),
[Zabbly packages](https://github.com/zabbly/incus),
[Incus backup](https://linuxcontainers.org/incus/docs/main/backup/),
[image handling](https://linuxcontainers.org/incus/docs/main/image-handling/),
[current requirements](https://linuxcontainers.org/incus/docs/main/requirements/).
