// Troubleshooting — categorised operator runbook for the most common
// "something is jammed, what do I run" moments. Each entry surfaces:
//
//   - The symptom (so the operator finds it by searching for what
//     they actually saw).
//   - A short explanation of WHY the system is in that state, not
//     just the fix — if the operator only learns "run this command"
//     they'll mis-apply it the next time the symptoms differ.
//   - Copy-to-clipboard for the exact command. We never auto-execute
//     anything from this page; some of these are destructive and the
//     pause-to-paste step is the safety bar.
//
// Static content. No API calls. Admin-only because the recipes lean
// on root-level state (known_hosts, /etc/wireguard, /opt/proxypilot,
// systemd, docker-compose).

import { Navigate } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import {
  Cable, Copy, GitBranch, KeyRound, LifeBuoy, Server, ShieldAlert, Trash2,
} from 'lucide-react';

// One troubleshooting entry. `commands` is an array of {label, code,
// runOn} so we can group "run this on your laptop" vs "run this on
// the host" without forcing the operator to re-read context.
function Entry({ title, symptom, why, commands, warning }) {
  const { toast } = useToast();
  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${label} copied`, description: 'Pasted to clipboard.' });
    } catch (err) {
      toast({
        title: 'Copy failed',
        description: err?.message || 'clipboard unavailable',
        variant: 'destructive',
      });
    }
  };
  return (
    <div className="border border-border rounded p-3 space-y-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {symptom && (
          <p className="text-xs text-muted-foreground mt-0.5">
            <span className="font-medium">Symptom: </span>
            <span className="font-mono">{symptom}</span>
          </p>
        )}
      </div>
      {why && <p className="text-xs text-muted-foreground">{why}</p>}
      {warning && (
        <div className="text-xs border border-amber-500/30 bg-amber-500/10 text-amber-500 rounded px-2 py-1.5">
          <span className="font-medium">Warning: </span>{warning}
        </div>
      )}
      {commands.map((c, i) => (
        <div key={i} className="space-y-1">
          {c.label && (
            <div className="text-[11px] text-muted-foreground flex items-center gap-2">
              <span>{c.label}</span>
              {c.runOn && (
                <span className="font-mono text-[10px] border border-border rounded px-1.5 py-0.5">
                  run on: {c.runOn}
                </span>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <pre className="flex-1 text-xs font-mono bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
              {c.code}
            </pre>
            <Button
              variant="outline" size="sm"
              onClick={() => copy(c.code, c.label || 'Command')}
              title="Copy command"
              className="self-start shrink-0"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

// ── content ─────────────────────────────────────────────────────────────────

const SSH_ENTRIES = [
  {
    title: 'Host key changed — "REMOTE HOST IDENTIFICATION HAS CHANGED!"',
    symptom: 'Host key verification failed.  /  Offending ED25519 key in known_hosts:<line>',
    why: 'SSH cached the old server\'s host key the first time you connected. The server now answering at that address has a different host key — usually because it was reprovisioned, the VM was rebuilt, or the IP got reassigned. SSH refuses to connect because, in principle, this is also what an MITM attack looks like.',
    warning: 'Before accepting the new key, verify it matches what the server actually has. From a console / serial / `incus exec` session on the server: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`. The SHA256 should match the fingerprint in the SSH warning.',
    commands: [
      { label: 'Remove the stale entry from your known_hosts',
        runOn: 'your laptop',
        code: 'ssh-keygen -R 10.100.0.1' },
      { label: 'Optionally pre-load the new key (skips the y/n prompt on next connect)',
        runOn: 'your laptop',
        code: 'ssh-keyscan -t ed25519 10.100.0.1 >> ~/.ssh/known_hosts' },
      { label: 'Verify the server\'s actual fingerprint (compare with the SSH warning)',
        runOn: 'the server (console / incus exec)',
        code: 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' },
    ],
  },
  {
    title: 'Permission denied (publickey)',
    symptom: 'Permission denied (publickey).',
    why: 'The server didn\'t accept any of the keys your client offered. Either the right key isn\'t loaded, the key isn\'t in `~/.ssh/authorized_keys` for the target user, or sshd is configured to refuse password / pubkey auth for that user.',
    commands: [
      { label: 'Show which keys your client actually offered',
        runOn: 'your laptop',
        code: 'ssh -v -i ~/.ssh/proxypilot_ed25519 root@10.100.0.1 2>&1 | grep -E "Offering|Authentications|publickey|denied"' },
      { label: 'Verify the key is authorised on the server',
        runOn: 'the server',
        code: 'grep -F "$(ssh-keygen -lf ~/.ssh/proxypilot_ed25519.pub | awk \'{print $2}\')" ~/.ssh/authorized_keys || echo "key not present in authorized_keys"' },
      { label: 'Re-add the key (run from your laptop)',
        runOn: 'your laptop',
        code: 'ssh-copy-id -i ~/.ssh/proxypilot_ed25519.pub root@10.100.0.1' },
    ],
  },
  {
    title: 'Connection refused / timeout',
    symptom: 'ssh: connect to host ... port 22: Connection refused  /  Connection timed out',
    why: 'sshd isn\'t listening on the port you tried, the host is unreachable on the network you\'re using, or a firewall (host-side or upstream) is dropping the SYN. "Refused" = host is up and rejecting; "timed out" = no host or no route.',
    commands: [
      { label: 'Check the route to the server',
        runOn: 'your laptop',
        code: 'ping -c 3 10.100.0.1' },
      { label: 'Check sshd status',
        runOn: 'the server',
        code: 'systemctl status ssh; ss -tlnp | grep -w 22' },
      { label: 'Check the host firewall',
        runOn: 'the server',
        code: 'nft list ruleset 2>/dev/null | grep -A2 "tcp dport 22"; iptables -nL INPUT 2>/dev/null | grep -E "22|ssh"' },
    ],
  },
];

const HOST_CLEANUP_ENTRIES = [
  {
    title: 'Force-remove a WireGuard peer that the dashboard refuses ("RECENTLY_ACTIVE")',
    symptom: 'Force refused by CLI: This gate requires an interactive CLI session. Use `proxypilot vpn …` on the host.',
    why: 'The dashboard refuses to remove a peer that handshake\'d in the last few minutes — accidental clicks would lock you out of a working tunnel. ProxyPilot routes that override through the CLI on purpose, so the action requires shell access (= you\'re actually on the host, not a stolen browser session).',
    commands: [
      { label: 'List peers + their last handshake',
        runOn: 'the ProxyPilot host',
        code: 'proxypilot vpn peers' },
      { label: 'Force-remove the peer (replace <name>)',
        runOn: 'the ProxyPilot host',
        code: 'proxypilot vpn peer remove <name> --force' },
    ],
  },
  {
    title: 'Remove an old WireGuard interface entirely',
    symptom: 'Stale wg0 / lxc-duo / vpn-* interface lingers after operator deleted the peer.',
    why: 'wg-quick keeps interface state in /etc/wireguard/<iface>.conf and the kernel keeps the device up until you take it down. Deleting the conf file alone doesn\'t stop the live interface.',
    warning: 'Confirms by IP address — if you\'re SSH\'d in over the WG you\'re about to take down, you will get disconnected. Run from console or another route.',
    commands: [
      { label: 'Take the interface down',
        runOn: 'the host',
        code: 'wg-quick down /etc/wireguard/lxc-duo.conf' },
      { label: 'Remove the configuration file',
        runOn: 'the host',
        code: 'rm /etc/wireguard/lxc-duo.conf' },
      { label: 'Disable the systemd unit if one was installed',
        runOn: 'the host',
        code: 'systemctl disable --now wg-quick@lxc-duo.service' },
    ],
  },
  {
    title: 'Remove a previous ProxyPilot install (start fresh)',
    symptom: 'Re-running install.sh fails because old state lingers.',
    why: 'install.sh creates state across several locations: /opt/proxypilot (the install root), /var/lib/proxypilot (engine state + CVE inbox), the docker-compose stack, the proxypilot-agent systemd unit, and engine timers. The bundled cleanup.sh removes all of that idempotently.',
    warning: 'Destroys the database (users, sessions, audit log), the CVE inbox, and any Caddy config the dashboard manages. Take a backup of /opt/proxypilot/data/db/proxypilot.db first if you care about audit history.',
    commands: [
      { label: 'Run the bundled cleanup script',
        runOn: 'the host',
        code: 'sudo bash /opt/proxypilot/cleanup.sh' },
      { label: 'Manual fallback if cleanup.sh is missing',
        runOn: 'the host',
        code: 'cd /opt/proxypilot && docker compose down -v\nsystemctl disable --now proxypilot-agent proxypilot-engine-inventory.timer proxypilot-engine-poll.timer\nrm -rf /opt/proxypilot /var/lib/proxypilot\nrm -f /etc/systemd/system/proxypilot-*.service /etc/systemd/system/proxypilot-*.timer\nsystemctl daemon-reload' },
    ],
  },
  {
    title: 'Reset the dashboard database (lose users + audit, keep services)',
    symptom: 'Forgot the admin password / TOTP / locked out and recovery codes are gone.',
    why: 'The auth state lives entirely in proxypilot.db. Deleting it triggers the first-time-setup wizard on the next dashboard load. Your service / route / firewall configs live in the SQLite DB too — this is a heavy hammer, prefer the CLI password-reset path if it\'s available.',
    warning: 'Deletes ALL configured services, firewall rules, VPN peers, audit log. Operators with sudo on the host can also reset just the admin password via CLI without losing the rest — try that first.',
    commands: [
      { label: 'Backup, then nuke',
        runOn: 'the host',
        code: 'cp /opt/proxypilot/data/db/proxypilot.db /opt/proxypilot/data/db/proxypilot.db.bak.$(date +%s)\nrm /opt/proxypilot/data/db/proxypilot.db*\ndocker compose -f /opt/proxypilot/docker-compose.yml restart' },
    ],
  },
  {
    title: 'Clean up stale CVE inbox entries',
    symptom: 'Inbox has orphans from a deleted host or a defunct git source.',
    why: 'Each `<CVE-ID>.yaml` is just a file. Deleting one removes the engine\'s record of that CVE\'s state on this host; the next git sync will re-import it if it\'s still in the source repo.',
    commands: [
      { label: 'List entries by origin',
        runOn: 'the host',
        code: 'grep -l "origin: git" /var/lib/proxypilot/cve-inbox/*.yaml | xargs -r ls -lt' },
      { label: 'Remove all DISMISSED entries',
        runOn: 'the host',
        code: 'grep -lE "^\\s+status:\\s+DISMISSED" /var/lib/proxypilot/cve-inbox/*.yaml | xargs -r rm -v' },
      { label: 'Remove a specific entry',
        runOn: 'the host',
        code: 'rm /var/lib/proxypilot/cve-inbox/CVE-XXXX-NNNNN.yaml' },
    ],
  },
];

const SERVICE_ENTRIES = [
  {
    title: 'Dashboard not loading / 502 / connection reset',
    symptom: 'Browser shows ERR_CONNECTION_REFUSED or Caddy 502.',
    why: 'Either the proxypilot-admin container isn\'t healthy, the host port isn\'t exposed, or Caddy can\'t reach the container.',
    commands: [
      { label: 'Container status + last 100 log lines',
        runOn: 'the host',
        code: 'docker compose -f /opt/proxypilot/docker-compose.yml ps\ndocker compose -f /opt/proxypilot/docker-compose.yml logs --tail 100 proxypilot' },
      { label: 'Direct health check (bypass Caddy)',
        runOn: 'the host',
        code: 'curl -sSf http://localhost:3001/api/health' },
      { label: 'Caddy reachability + recent errors',
        runOn: 'the host',
        code: 'systemctl status caddy --no-pager\njournalctl -u caddy -n 50 --no-pager' },
    ],
  },
  {
    title: 'Container restart loop',
    symptom: 'docker ps shows proxypilot-admin "Restarting" repeatedly.',
    why: 'Common causes: bad .env (missing JWT_SECRET / TOTP_ENCRYPTION_KEY in production), corrupted DB, port conflict, Node OOM.',
    commands: [
      { label: 'Stream logs until you see the crash',
        runOn: 'the host',
        code: 'docker compose -f /opt/proxypilot/docker-compose.yml logs -f proxypilot' },
      { label: 'Inspect the .env (don\'t paste the output anywhere)',
        runOn: 'the host',
        code: 'sudo grep -E "^(JWT_SECRET|TOTP_ENCRYPTION_KEY|DATABASE_PATH|NODE_ENV|DOMAIN)=" /opt/proxypilot/.env | sed "s/=.*$/=<set>/"' },
      { label: 'Quick DB sanity check',
        runOn: 'the host',
        code: 'sqlite3 /opt/proxypilot/data/db/proxypilot.db "SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM audit_log;"' },
    ],
  },
  {
    title: 'Database is locked',
    symptom: 'SQLITE_BUSY: database is locked  /  routes hang for 30s then 500.',
    why: 'Another writer (a CLI session, a stuck transaction, a second backend process) holds a write lock. WAL mode reduces this but doesn\'t eliminate it.',
    commands: [
      { label: 'Find processes holding the DB',
        runOn: 'the host',
        code: 'lsof /opt/proxypilot/data/db/proxypilot.db' },
      { label: 'Restart the dashboard (releases all backend locks)',
        runOn: 'the host',
        code: 'docker compose -f /opt/proxypilot/docker-compose.yml restart proxypilot' },
    ],
  },
  {
    title: 'Restart everything cleanly (no data loss)',
    symptom: 'Things are weird, want a clean cold start without losing state.',
    why: 'A clean stop + start clears in-memory state (rate-limit counters, cached sessions, stuck timers) without touching the DB or the inbox.',
    commands: [
      { label: 'Use the bundled restart script',
        runOn: 'the host',
        code: 'sudo bash /opt/proxypilot/restart.sh' },
      { label: 'Or do it by hand',
        runOn: 'the host',
        code: 'docker compose -f /opt/proxypilot/docker-compose.yml down\ndocker compose -f /opt/proxypilot/docker-compose.yml up -d\ndocker compose -f /opt/proxypilot/docker-compose.yml logs --tail 30 -f proxypilot' },
    ],
  },
];

const ENGINE_ENTRIES = [
  {
    title: 'Engine timers not firing',
    symptom: 'Inbox entries stay NEW forever; inventory.json never updates.',
    why: 'The systemd timers that drive the engine (inventory hourly, poll every 5 min) install during install.sh / update.sh. If those scripts didn\'t run successfully, or the host was rebooted before they were enabled, the timers may be inactive.',
    commands: [
      { label: 'Check timer state',
        runOn: 'the host',
        code: 'systemctl list-timers --no-pager | grep proxypilot' },
      { label: 'Last poll run',
        runOn: 'the host',
        code: 'systemctl status proxypilot-engine-poll.service --no-pager\njournalctl -u proxypilot-engine-poll.service -n 50 --no-pager' },
      { label: 'Re-enable',
        runOn: 'the host',
        code: 'systemctl enable --now proxypilot-engine-inventory.timer proxypilot-engine-poll.timer' },
    ],
  },
  {
    title: '"engine package not found" / "ruamel.yaml not installed"',
    symptom: 'Poll fails with: engine package not found on host PYTHONPATH …',
    why: 'The engine is bundled with the install.sh tarball at $INSTALL_DIR/proxypilot, and the host needs python3 + ruamel.yaml. Update.sh installs both. If you ran an older update or installed manually, these may be missing.',
    commands: [
      { label: 'Verify the package is on disk',
        runOn: 'the host',
        code: 'ls -la /opt/proxypilot/proxypilot/engine/__init__.py' },
      { label: 'Install the host-side Python deps',
        runOn: 'the host',
        code: 'sudo apt-get install -y python3 python3-ruamel.yaml git' },
      { label: 'Re-test the engine end to end',
        runOn: 'the host',
        code: 'PYTHONPATH=/opt/proxypilot python3 -m proxypilot.engine show CVE-2024-3094' },
    ],
  },
  {
    title: 'Inbox dir empty in the dashboard, but files exist on the host',
    symptom: '"0 total · 0 unread" in the dashboard despite YAMLs in /var/lib/proxypilot/cve-inbox/.',
    why: 'The dashboard reads the inbox via a bind mount into the container. If the mount is missing (older compose file), the listing endpoint sees an empty dir.',
    commands: [
      { label: 'Confirm the bind mount inside the container',
        runOn: 'the host',
        code: 'docker exec proxypilot-admin ls -la /var/lib/proxypilot/cve-inbox' },
      { label: 'Re-run update.sh to migrate the compose',
        runOn: 'the host',
        code: 'cd /path/to/ProxyPilot && sudo bash update.sh' },
    ],
  },
];

const VPN_ENTRIES = [
  {
    title: 'Peer never handshakes / 0 transferred',
    symptom: 'WireGuard tunnel shows green on the client; "Latest handshake: never" on the server.',
    why: 'The peer\'s endpoint, port, public key, or the firewall hop from client to server is wrong. A failing handshake is silent — the client sees an active tunnel, the server never receives a packet that decrypts.',
    commands: [
      { label: 'On the server: live wg state',
        runOn: 'the ProxyPilot host',
        code: 'wg show all latest-handshakes\nwg show all transfer' },
      { label: 'On the server: confirm the listen port is actually open',
        runOn: 'the ProxyPilot host',
        code: 'ss -ulnp | grep wg\nnft list ruleset 2>/dev/null | grep -A2 "udp dport"' },
      { label: 'From outside (any other host on the internet)',
        runOn: 'a different machine',
        code: 'nc -zvu YOUR.PUBLIC.IP 51820' },
    ],
  },
  {
    title: 'Listen port migrated unexpectedly',
    symptom: 'Peers stop connecting after a restart; server is now listening on a different UDP port.',
    why: 'ProxyPilot\'s VPN startup auto-heals the wg0 listen port when there\'s a conflict with a service L4 forward (commonly when a WebRTC range overlaps the IANA WG default 51820). It logs the migration, then peers using the old endpoint fail.',
    commands: [
      { label: 'Find the migration in dashboard logs',
        runOn: 'the host',
        code: 'docker compose -f /opt/proxypilot/docker-compose.yml logs proxypilot 2>&1 | grep -E "VPN-startup|wg0 listen port"' },
      { label: 'Update each peer\'s `Endpoint = host:NEW_PORT` to match',
        runOn: 'each client',
        code: '# Edit the WG config on each client and replace the port:\n# Endpoint = your.host:NEW_PORT' },
    ],
  },
];

export default function Troubleshooting() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin'
    || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';
  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <LifeBuoy className="h-5 w-5 text-orange-500" />
        <h1 className="text-lg font-semibold">Troubleshooting</h1>
      </div>
      <p className="text-xs text-muted-foreground max-w-2xl">
        Operator runbook for common issues. Every entry has a copy-to-clipboard command —
        nothing on this page auto-executes. Each command is annotated with where to run it
        (your laptop vs. the ProxyPilot host vs. a managed server).
      </p>

      <Tabs defaultValue="ssh" className="w-full">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="ssh"><KeyRound className="h-3.5 w-3.5 mr-1.5" /> SSH</TabsTrigger>
          <TabsTrigger value="cleanup"><Trash2 className="h-3.5 w-3.5 mr-1.5" /> Host cleanup</TabsTrigger>
          <TabsTrigger value="service"><Server className="h-3.5 w-3.5 mr-1.5" /> Dashboard</TabsTrigger>
          <TabsTrigger value="engine"><ShieldAlert className="h-3.5 w-3.5 mr-1.5" /> CVE engine</TabsTrigger>
          <TabsTrigger value="vpn"><Cable className="h-3.5 w-3.5 mr-1.5" /> VPN</TabsTrigger>
        </TabsList>

        <TabsContent value="ssh">
          <Card>
            <CardHeader><CardTitle className="text-base">SSH access</CardTitle></CardHeader>
            <CardContent>
              <Section title="Connection problems">
                {SSH_ENTRIES.map((e, i) => <Entry key={i} {...e} />)}
              </Section>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cleanup">
          <Card>
            <CardHeader><CardTitle className="text-base">Host cleanup</CardTitle></CardHeader>
            <CardContent>
              <Section title="Removing leftover state">
                {HOST_CLEANUP_ENTRIES.map((e, i) => <Entry key={i} {...e} />)}
              </Section>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="service">
          <Card>
            <CardHeader><CardTitle className="text-base">Dashboard service</CardTitle></CardHeader>
            <CardContent>
              <Section title="Common operational issues">
                {SERVICE_ENTRIES.map((e, i) => <Entry key={i} {...e} />)}
              </Section>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="engine">
          <Card>
            <CardHeader><CardTitle className="text-base">CVE engine</CardTitle></CardHeader>
            <CardContent>
              <Section title="Engine + inbox">
                {ENGINE_ENTRIES.map((e, i) => <Entry key={i} {...e} />)}
              </Section>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="vpn">
          <Card>
            <CardHeader><CardTitle className="text-base">WireGuard VPN</CardTitle></CardHeader>
            <CardContent>
              <Section title="Tunnel + peer issues">
                {VPN_ENTRIES.map((e, i) => <Entry key={i} {...e} />)}
              </Section>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
