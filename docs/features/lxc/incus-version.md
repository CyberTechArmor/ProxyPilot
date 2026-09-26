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

`install.sh` and `update.sh` intentionally **do not upgrade an existing Incus
daemon** as part of an application deploy. Incus may migrate its database on
upgrade, and downgrading packages alone may then be impossible. Before a
separate host upgrade, inventory the host version, kernel, storage drivers,
instances and available space; take and verify a full backup of
`/var/lib/incus` and any external storage pool; confirm an outage window and
a restore procedure. The current ProxyPilot MCP exposes the host package
inventory but no host Incus package upgrade action. A UI/MCP application
update does not change the installed daemon.

On the observed pilot host, ProxyPilot MCP reported Incus
`6.0.4-2+deb13u6`, with only `6.0.4-2+deb13u10` available from its configured
Debian repositories. That host has not been upgraded to 7.5.1. Its A3 worker
isolation acceptance remains blocked until a disposable target proves the
specified network and resource controls; a newer version alone is not proof.

Sources: [Incus 7.5 release](https://linuxcontainers.org/incus/news/),
[launch reference](https://linuxcontainers.org/incus/docs/main/reference/manpages/incus/launch/),
[REST API](https://linuxcontainers.org/incus/docs/main/rest-api/),
[Zabbly packages](https://github.com/zabbly/incus),
[Incus backup](https://linuxcontainers.org/incus/docs/main/backup/).
