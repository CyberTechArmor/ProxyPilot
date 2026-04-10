<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 134-225) -->
<!-- Index: docs/core/prompt/README.md -->

## SSH Access Management

### Safe Transition Sequence

On a remote machine, getting locked out of SSH means losing the machine. ProxyPilot verifies the new access path works before closing the old one.

```
1. Create per-person admin accounts
   - useradd with sudo group, install SSH keys
   - chmod 700 .ssh, chmod 600 authorized_keys

2. TEST: Verify new access works BEFORE changing anything
   - Programmatic: SSH key installed, home dir exists, user in sudo group
   - Interactive: "Verify you can SSH as <username> from another terminal NOW."
   - Operator confirmation: "Can all administrators log in? [y/N]"
   - If no: STOP. Do not proceed. Old access remains active.

3. Only after confirmation: Harden sshd_config
   - PermitRootLogin no
   - PasswordAuthentication no
   - PubkeyAuthentication yes
   - MaxAuthTries 3
   - X11Forwarding no
   - AllowTcpForwarding no (unless needed — ask operator)
   - ClientAliveInterval 300
   - ClientAliveCountMax 2
   - AllowUsers <created usernames>

4. Reload sshd (NOT restart — preserves existing sessions)

5. TEST AGAIN: Verify access after lockdown
   - "Verify you can still SSH from another terminal."
   - If operator says no: revert sshd_config, reload, print error.

6. Install CrowdSec SSH bouncer (Hardened/Compliant)
```

Non-interactive mode uses programmatic verification only.

### Admin Specification

```
proxypilot init --admin "thomas:ssh-ed25519 AAAA..." --admin "jane:ssh-ed25519 AAAA..."
```

Or via config YAML:

```yaml
admins:
  - username: thomas
    ssh_public_key: "ssh-ed25519 AAAA..."
    email: thomas@example.com
```

### Ongoing Access Management

```
proxypilot access add <username> --ssh-key "<key>" [--email <email>]
```
- Creates system user with sudo, installs SSH key
- Adds to sshd AllowUsers, reloads sshd
- Records in SQLite + audit log

```
proxypilot access remove <username> [--force]
```
- Removes from AllowUsers, reloads sshd
- Locks system account (does not delete home dir — audit preservation)
- Audit log entry

```
proxypilot access list
```
- Table: username, email, SSH key fingerprint, last login, status

```
proxypilot access history [username] [--since <datetime>] [--failed]
```
- SSH session history parsed from journal
- Flags: unusual IPs, off-hours logins, brute force patterns

```
proxypilot access review
```
- Compliant only. Presents each account for confirm/revoke.
- Records review date and reviewer.
- `proxypilot compliance check` flags overdue reviews (quarterly).

### Actor Identity in Audit Logs

All commands read `$SUDO_USER` (or `$USER`) for the `actor` field: `cli:<username>`.
