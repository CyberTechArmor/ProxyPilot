"""Hourly host inventory.

Produces /var/lib/proxypilot/inventory.json, the authoritative shape
that Claude reads when authoring CVE specs. Output is best-effort:
each section is independent, and a failure in one (e.g. the host has
no Incus) returns an empty list / null rather than aborting the run.

Sections:
  - kernel:    running, installed, cmdline, modules, relevant CONFIG_*
  - packages:  dpkg -W
  - services:  systemctl running units
  - sockets:   ss -tulnpH with reachability tag
                 INTERNET if bound to a public IP OR fronted by a
                 Cloudflare Tunnel / public reverse proxy; else
                 LAN | LOCAL.
  - docker:    image digests + running container summary
  - runc:      binary path + version, queried directly — runc ships
               bundled inside containerd.io on this fleet, not as its
               own dpkg package, so its version can't be inferred from
               containerd.io's package version alone
  - caddy:     binary path + version, queried directly — Caddy ships as
               a standalone binary from Caddy's own releases, not a
               Debian package, so `dpkg -W caddy` never finds it
  - incus:     instance list with kind=container|virtual-machine
  - vm_guests: only VMs the agent can reach; same shape, with
               parent_host set
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import INVENTORY_PATH
from .inbox import now_iso, this_hostname

# Subset of kernel CONFIG_* options that show up in the security
# tracker advisories often enough to be worth surfacing without
# pulling the entire 6k-line config every hour. Claude reads these
# to decide whether a CVE spec applies to the host's kernel build.
RELEVANT_KCONFIG = (
    "CONFIG_BPF",
    "CONFIG_BPF_SYSCALL",
    "CONFIG_USER_NS",
    "CONFIG_CRYPTO_USER_API",
    "CONFIG_CRYPTO_USER_API_AEAD",
    "CONFIG_IP_NF_IPTABLES",
    "CONFIG_NF_TABLES",
    "CONFIG_IO_URING",
    "CONFIG_KEXEC",
    "CONFIG_MODULES",
)

# Hosts behind a Cloudflare Tunnel are reachable from the Internet
# even when they bind only to a private/loopback address. Detected by
# the cloudflared service or process name.
CLOUDFLARED_UNIT_HINTS = ("cloudflared", "cloudflare-tunnel")


def _run(argv: List[str], timeout: int = 15) -> str:
    """Run a command, return stdout. Empty string on any failure —
    inventory is best-effort and one missing tool shouldn't poison
    the whole snapshot."""
    if not argv:
        return ""
    bin_ = shutil.which(argv[0]) or argv[0]
    try:
        out = subprocess.run(
            [bin_, *argv[1:]],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        return out.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return ""


def collect_kernel() -> Dict[str, Any]:
    running = _run(["uname", "-r"]).strip()
    cmdline = ""
    try:
        cmdline = Path("/proc/cmdline").read_text().strip()
    except OSError:
        pass

    modules: List[str] = []
    try:
        for line in Path("/proc/modules").read_text().splitlines():
            name = line.split(" ", 1)[0].strip()
            if name:
                modules.append(name)
    except OSError:
        pass

    installed = ""
    out = _run(["dpkg-query", "-W", "-f=${Package}\t${Version}\t${Status}\n", "linux-image-*"])
    versions: List[str] = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and "installed" in parts[2] and parts[1]:
            versions.append(parts[1])
    if versions:
        installed = sorted(versions)[-1]

    kconfig: Dict[str, str] = {}
    cfg_path = Path(f"/boot/config-{running}") if running else None
    if cfg_path and cfg_path.is_file():
        try:
            for line in cfg_path.read_text().splitlines():
                if "=" in line and line.startswith("CONFIG_"):
                    k, _, v = line.partition("=")
                    if k in RELEVANT_KCONFIG:
                        kconfig[k] = v
        except OSError:
            pass

    return {
        "running": running,
        "installed": installed,
        "cmdline": cmdline,
        "modules": modules,
        "config": kconfig,
    }


def collect_packages() -> Dict[str, str]:
    out = _run(["dpkg-query", "-W", "-f=${Package}\t${Version}\t${Status}\n"])
    pkgs: Dict[str, str] = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and "installed" in parts[2]:
            pkgs[parts[0]] = parts[1]
    return pkgs


def collect_services() -> List[Dict[str, str]]:
    out = _run(["systemctl", "list-units", "--type=service", "--state=running",
                "--no-pager", "--no-legend", "--plain"])
    services: List[Dict[str, str]] = []
    for line in out.splitlines():
        # `unit  load  active  sub  description`
        fields = re.split(r"\s+", line.strip(), maxsplit=4)
        if len(fields) >= 4 and fields[0].endswith(".service"):
            services.append({
                "unit": fields[0],
                "load": fields[1],
                "active": fields[2],
                "sub": fields[3],
                "description": fields[4] if len(fields) >= 5 else "",
            })
    return services


def _is_public_ip(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return not (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_unspecified or ip.is_reserved)


def _is_loopback(addr: str) -> bool:
    try:
        return ipaddress.ip_address(addr).is_loopback
    except ValueError:
        return addr.startswith("127.") or addr == "::1"


def _is_unspecified(addr: str) -> bool:
    return addr in ("0.0.0.0", "::", "*")


def _cloudflared_running(services: List[Dict[str, str]]) -> bool:
    for s in services:
        unit = s.get("unit", "").lower()
        if any(h in unit for h in CLOUDFLARED_UNIT_HINTS):
            return True
    return False


# ss -tulnpH output: state, recv-q, send-q, local addr:port, peer addr:port, [users]
_SS_LINE = re.compile(r"^(?P<proto>\S+)\s+\S+\s+\S+\s+\S+\s+(?P<local>\S+)\s+(?P<peer>\S+)(?:\s+(?P<users>.*))?$")


def collect_sockets(*, cloudflared: bool) -> List[Dict[str, Any]]:
    out = _run(["ss", "-tulnpH"])
    sockets: List[Dict[str, Any]] = []
    for line in out.splitlines():
        m = _SS_LINE.match(line.strip())
        if not m:
            continue
        proto = m.group("proto")
        local = m.group("local")
        users = (m.group("users") or "").strip()
        # Strip IPv6 brackets and split addr:port from the right so
        # IPv6 addresses with embedded colons parse correctly.
        addr, _, port = local.rpartition(":")
        addr = addr.strip("[]") or "0.0.0.0"
        try:
            port_int = int(port)
        except ValueError:
            continue

        if _is_public_ip(addr):
            reachability = "INTERNET"
        elif cloudflared and _is_loopback(addr):
            # Cloudflare tunnels typically forward loopback-only
            # services to the public internet; a loopback bind on a
            # cloudflared host is conservatively INTERNET. 0.0.0.0
            # binds aren't promoted because they're already broadly
            # reachable on every interface — Claude refines per-service
            # in the YAML if a tunnel rule exists.
            reachability = "INTERNET"
        elif _is_loopback(addr):
            reachability = "LOCAL"
        elif _is_unspecified(addr):
            reachability = "LAN"
        else:
            reachability = "LAN"

        sockets.append({
            "proto": proto,
            "addr": addr,
            "port": port_int,
            "users": users,
            "reachability": reachability,
        })
    return sockets


def collect_docker() -> Dict[str, Any]:
    if not shutil.which("docker"):
        return {"present": False, "images": [], "containers": []}
    images_raw = _run(["docker", "image", "ls", "--digests",
                       "--format", "{{.Repository}}:{{.Tag}}\t{{.Digest}}\t{{.ID}}"])
    images = []
    for line in images_raw.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3:
            images.append({"ref": parts[0], "digest": parts[1], "id": parts[2]})
    containers_raw = _run(["docker", "ps", "--format",
                           "{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}"])
    containers = []
    for line in containers_raw.splitlines():
        parts = line.split("\t")
        if len(parts) >= 4:
            containers.append({
                "id": parts[0], "image": parts[1],
                "name": parts[2], "status": parts[3],
            })
    return {"present": True, "images": images, "containers": containers}


def collect_runc() -> Dict[str, Any]:
    """runc has no standalone Debian package on this fleet — it ships
    bundled inside containerd.io (Docker's official apt repo), and
    containerd.io point releases don't track runc point releases 1:1.
    Query the actual binary rather than inferring from containerd's
    package version, so CVE specs can stop treating it as unknown."""
    path = shutil.which("runc")
    if not path:
        for candidate in ("/usr/bin/runc", "/usr/sbin/runc", "/usr/local/bin/runc"):
            if Path(candidate).is_file():
                path = candidate
                break
    if not path:
        return {"present": False, "path": None, "version": None}
    out = _run([path, "--version"])
    version = out.splitlines()[0].strip() if out.strip() else None
    return {"present": True, "path": path, "version": version}


def collect_caddy() -> Dict[str, Any]:
    """Caddy ships as a standalone binary from Caddy's own releases,
    not a Debian package — `dpkg-query -W caddy` never finds it even
    when installed. Query the binary directly."""
    path = shutil.which("caddy")
    if not path and Path("/usr/bin/caddy").is_file():
        path = "/usr/bin/caddy"
    if not path:
        return {"present": False, "path": None, "version": None}
    out = _run([path, "version"])
    version = out.strip() if out.strip() else None
    return {"present": True, "path": path, "version": version}


def collect_incus() -> Dict[str, Any]:
    if not shutil.which("incus"):
        return {"present": False, "instances": []}
    raw = _run(["incus", "list", "--format=json"])
    if not raw:
        return {"present": True, "instances": []}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {"present": True, "instances": []}
    instances = []
    for inst in data:
        if not isinstance(inst, dict):
            continue
        # Incus reports `type` as "container" or "virtual-machine".
        kind = inst.get("type") or "container"
        instances.append({
            "name": inst.get("name"),
            "kind": kind,
            "status": inst.get("status"),
            "architecture": inst.get("architecture"),
            "image": (inst.get("config") or {}).get("image.description"),
        })
    return {"present": True, "instances": instances}


def collect_vm_guests(parent: str) -> List[Dict[str, Any]]:
    """Reachable VM guests' inventory. Today this only enumerates Incus
    VMs; a future iteration can SSH into reachable guests and pull the
    same inventory shape with parent_host set.

    The agent doesn't have a hostname-keyed agent registry yet, so for
    now we just emit a stub per VM so Claude knows the surface exists."""
    incus = collect_incus()
    out: List[Dict[str, Any]] = []
    if not incus.get("present"):
        return out
    for inst in incus.get("instances", []):
        if inst.get("kind") == "virtual-machine":
            out.append({
                "hostname": inst.get("name"),
                "parent_host": parent,
                "kind": "virtual-machine",
                "status": inst.get("status"),
                # Detailed inventory is gathered when the agent gets a
                # foothold inside the guest. Until then this is a
                # placeholder so the absence of detail is explicit.
                "inventory": None,
            })
    return out


def build() -> Dict[str, Any]:
    services = collect_services()
    cf = _cloudflared_running(services)
    inv: Dict[str, Any] = {
        "generated_at": now_iso(),
        "generator": "proxypilot-engine",
        "hostname": this_hostname(),
        "kernel": collect_kernel(),
        "packages": collect_packages(),
        "services": services,
        "sockets": collect_sockets(cloudflared=cf),
        "docker": collect_docker(),
        "runc": collect_runc(),
        "caddy": collect_caddy(),
        "incus": collect_incus(),
    }
    inv["vm_guests"] = collect_vm_guests(inv["hostname"])
    return inv


def write(path: str | os.PathLike[str] = INVENTORY_PATH) -> Path:
    """Write the inventory atomically. Returns the destination path."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(build(), indent=2, sort_keys=False)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(body, encoding="utf-8")
    os.replace(tmp, p)
    return p
