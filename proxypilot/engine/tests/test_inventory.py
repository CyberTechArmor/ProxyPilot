"""Inventory tests focus on the bits with non-obvious logic:
reachability tagging, JSON shape, atomic write."""

from __future__ import annotations

import json
from pathlib import Path

from proxypilot.engine import inventory as inv


def test_public_ip_classification():
    assert inv._is_public_ip("8.8.8.8")
    assert not inv._is_public_ip("10.0.0.1")
    assert not inv._is_public_ip("192.168.1.1")
    assert not inv._is_public_ip("127.0.0.1")
    assert not inv._is_public_ip("::1")
    assert not inv._is_public_ip("fe80::1")
    assert not inv._is_public_ip("not-an-ip")


def test_loopback_and_unspecified():
    assert inv._is_loopback("127.0.0.1")
    assert inv._is_loopback("::1")
    assert inv._is_unspecified("0.0.0.0")
    assert inv._is_unspecified("::")
    assert inv._is_unspecified("*")


def test_cloudflared_detection_promotes_loopback_to_internet(monkeypatch):
    """A loopback bind on a host running cloudflared is conservatively
    treated as INTERNET because the tunnel can front it."""
    fake_ss = (
        "tcp   LISTEN 0  4096   127.0.0.1:8080  0.0.0.0:*  users:((\"app\",pid=1,fd=3))\n"
        "tcp   LISTEN 0  4096   0.0.0.0:22      0.0.0.0:*  users:((\"sshd\",pid=2,fd=4))\n"
        "tcp   LISTEN 0  4096   8.8.8.8:443     0.0.0.0:*  users:((\"caddy\",pid=3,fd=5))\n"
    )
    monkeypatch.setattr(inv, "_run", lambda argv, timeout=15: fake_ss if argv[0] == "ss" else "")
    sockets = inv.collect_sockets(cloudflared=True)
    by_port = {s["port"]: s for s in sockets}
    assert by_port[8080]["reachability"] == "INTERNET"
    assert by_port[22]["reachability"] == "LAN"
    assert by_port[443]["reachability"] == "INTERNET"


def test_no_cloudflared_keeps_loopback_local(monkeypatch):
    fake_ss = "tcp   LISTEN 0  4096   127.0.0.1:8080  0.0.0.0:*  users:((\"app\",pid=1,fd=3))\n"
    monkeypatch.setattr(inv, "_run", lambda argv, timeout=15: fake_ss if argv[0] == "ss" else "")
    sockets = inv.collect_sockets(cloudflared=False)
    assert sockets[0]["reachability"] == "LOCAL"


def test_build_returns_expected_top_level_shape(monkeypatch):
    monkeypatch.setattr(inv, "collect_kernel", lambda: {"running": "x", "installed": "x", "cmdline": "", "modules": [], "config": {}})
    monkeypatch.setattr(inv, "collect_packages", lambda: {})
    monkeypatch.setattr(inv, "collect_services", lambda: [])
    monkeypatch.setattr(inv, "collect_sockets", lambda *, cloudflared: [])
    monkeypatch.setattr(inv, "collect_docker", lambda: {"present": False, "images": [], "containers": []})
    monkeypatch.setattr(inv, "collect_runc", lambda: {"present": False, "path": None, "version": None})
    monkeypatch.setattr(inv, "collect_caddy", lambda: {"present": False, "path": None, "version": None})
    monkeypatch.setattr(inv, "collect_incus", lambda: {"present": False, "instances": []})
    monkeypatch.setattr(inv, "collect_vm_guests", lambda parent: [])
    out = inv.build()
    for key in ("generated_at", "generator", "hostname", "kernel", "packages",
                "services", "sockets", "docker", "runc", "caddy", "incus", "vm_guests"):
        assert key in out


def test_collect_runc_finds_binary_on_path(monkeypatch):
    monkeypatch.setattr(inv.shutil, "which", lambda name: "/usr/bin/runc" if name == "runc" else None)
    monkeypatch.setattr(inv, "_run", lambda argv, timeout=15: "runc version 1.2.8\ncommit: abc123\n" if argv[0] == "/usr/bin/runc" else "")
    out = inv.collect_runc()
    assert out == {"present": True, "path": "/usr/bin/runc", "version": "runc version 1.2.8"}


def test_collect_runc_falls_back_to_known_paths(monkeypatch):
    monkeypatch.setattr(inv.shutil, "which", lambda name: None)
    monkeypatch.setattr(inv.Path, "is_file", lambda self: str(self) == "/usr/bin/runc")
    monkeypatch.setattr(inv, "_run", lambda argv, timeout=15: "runc version 1.1.0\n")
    out = inv.collect_runc()
    assert out == {"present": True, "path": "/usr/bin/runc", "version": "runc version 1.1.0"}


def test_collect_runc_absent(monkeypatch):
    monkeypatch.setattr(inv.shutil, "which", lambda name: None)
    monkeypatch.setattr(inv.Path, "is_file", lambda self: False)
    out = inv.collect_runc()
    assert out == {"present": False, "path": None, "version": None}


def test_collect_caddy_finds_binary_and_reports_version(monkeypatch):
    monkeypatch.setattr(inv.shutil, "which", lambda name: "/usr/bin/caddy" if name == "caddy" else None)
    monkeypatch.setattr(inv, "_run", lambda argv, timeout=15: "v2.11.5 h1:abc\n" if argv[0] == "/usr/bin/caddy" else "")
    out = inv.collect_caddy()
    assert out == {"present": True, "path": "/usr/bin/caddy", "version": "v2.11.5 h1:abc"}


def test_collect_caddy_absent(monkeypatch):
    monkeypatch.setattr(inv.shutil, "which", lambda name: None)
    monkeypatch.setattr(inv.Path, "is_file", lambda self: False)
    out = inv.collect_caddy()
    assert out == {"present": False, "path": None, "version": None}


def test_write_is_atomic_and_emits_valid_json(monkeypatch, tmp_path):
    monkeypatch.setattr(inv, "build", lambda: {"hostname": "test", "x": [1, 2]})
    out = tmp_path / "inventory.json"
    inv.write(out)
    data = json.loads(out.read_text())
    assert data["hostname"] == "test"
    # No leftover .tmp file from the atomic rename.
    assert not (tmp_path / "inventory.json.tmp").exists()
