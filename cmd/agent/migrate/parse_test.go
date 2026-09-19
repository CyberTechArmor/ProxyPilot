package migrate

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseOSRelease(t *testing.T) {
	id, ver, pretty := ParseOSRelease(`PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
ID=debian
# a comment
HOME_URL="https://www.debian.org/"`)
	if id != "debian" || ver != "12" || pretty != "Debian GNU/Linux 12 (bookworm)" {
		t.Fatalf("got %q %q %q", id, ver, pretty)
	}
	if id, _, _ := ParseOSRelease(""); id != "" {
		t.Errorf("an empty file must not invent an OS: %q", id)
	}
}

func TestParseSS(t *testing.T) {
	// Real `ss -lntupH` output: a loopback app behind nginx, nginx itself,
	// a UDP resolver, and a unix row that must be ignored.
	out := ParseSS(`tcp   LISTEN 0      511        127.0.0.1:3000       0.0.0.0:*    users:(("node",pid=812,fd=20))
tcp   LISTEN 0      511          0.0.0.0:443        0.0.0.0:*    users:(("nginx",pid=640,fd=6),("nginx",pid=639,fd=6))
tcp   LISTEN 0      4096            [::1]:5432          [::]:*    users:(("postgres",pid=700,fd=5))
udp   UNCONN 0      0          127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=300,fd=12))
u_str LISTEN 0      4096       /run/docker.sock 12345                * 0`)
	if len(out) != 4 {
		t.Fatalf("want 4 sockets, got %d: %+v", len(out), out)
	}
	if out[0].Port != 3000 || out[0].Address != "127.0.0.1" || out[0].Process != "node" || out[0].PID != 812 {
		t.Errorf("loopback app: %+v", out[0])
	}
	if out[1].Address != "0.0.0.0" || out[1].Port != 443 || out[1].Process != "nginx" {
		t.Errorf("nginx: %+v", out[1])
	}
	if out[2].Address != "::1" || out[2].Port != 5432 {
		t.Errorf("ipv6 postgres: %+v", out[2])
	}
	if out[3].Proto != "udp" || out[3].Port != 53 {
		t.Errorf("udp: %+v", out[3])
	}
}

func TestParseSystemctl(t *testing.T) {
	units := ParseSystemctlList(`  myapp.service    loaded active running   My application
  nginx.service    loaded active running   A high performance web server
● broken.service   loaded failed failed    Something broken
  mnt-data.mount   loaded active mounted   /mnt/data`)
	if len(units) != 3 {
		t.Fatalf("want 3 services (the .mount is not one), got %d: %+v", len(units), units)
	}
	if units[0].Name != "myapp.service" || units[0].State != "running" || units[0].Description != "My application" {
		t.Errorf("first unit: %+v", units[0])
	}
	if units[2].Name != "broken.service" {
		t.Errorf("a failed unit prefixed with ● must still be read: %+v", units[2])
	}

	u := ParseSystemctlShow(`Id=myapp.service
Description=My application
UnitFileState=enabled
ActiveState=active
User=app
WorkingDirectory=/srv/myapp
ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/myapp/server.js ; ignore_errors=no ; start_time=[n/a] }
EnvironmentFiles=/srv/myapp/.env (ignore_errors=no)`)
	if u.Name != "myapp.service" || u.User != "app" || u.WorkingDirectory != "/srv/myapp" || u.Enabled != "enabled" {
		t.Errorf("show: %+v", u)
	}
	if u.Exec != "/usr/bin/node /srv/myapp/server.js" {
		t.Errorf("ExecStart must yield the argv, not systemd's record: %q", u.Exec)
	}
	if len(u.EnvFiles) != 1 || u.EnvFiles[0] != "/srv/myapp/.env" {
		t.Errorf("env files: %+v — the (ignore_errors=no) suffix is not a path", u.EnvFiles)
	}
}

func TestParseNginx(t *testing.T) {
	conf := `
upstream app_backend {
    server 127.0.0.1:3000;
    server 127.0.0.1:3001 backup;
}

server {
    listen 80;
    server_name app.example.com www.app.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name app.example.com;
    ssl_certificate /etc/letsencrypt/live/app.example.com/fullchain.pem;
    root /var/www/app;

    location /api {
        proxy_pass http://app_backend;
    }
    location / {
        proxy_pass http://127.0.0.1:8080;
    }
}
`
	vhosts := ParseNginx("/etc/nginx/sites-enabled/app", conf)
	if len(vhosts) != 2 {
		t.Fatalf("want 2 server blocks, got %d: %+v", len(vhosts), vhosts)
	}
	if got := vhosts[0].ServerNames; len(got) != 2 || got[0] != "app.example.com" {
		t.Errorf("names: %+v", got)
	}
	v := vhosts[1]
	if !v.TLS {
		t.Errorf("a 443 ssl block with a certificate is TLS: %+v", v)
	}
	if len(v.Roots) != 1 || v.Roots[0] != "/var/www/app" {
		t.Errorf("root: %+v", v.Roots)
	}
	// The nested location blocks must not have ended the server block, and
	// the named upstream must have been resolved to its real backends.
	want := []string{"127.0.0.1:3000", "127.0.0.1:3001", "http://127.0.0.1:8080"}
	if strings.Join(v.Upstreams, ",") != strings.Join(want, ",") {
		t.Errorf("upstreams: %+v, want %+v", v.Upstreams, want)
	}
}

func TestParseApacheAndCaddy(t *testing.T) {
	ap := ParseApache("/etc/apache2/sites-enabled/site.conf", `
<VirtualHost *:443>
    ServerName shop.example.com
    ServerAlias www.shop.example.com
    DocumentRoot /var/www/shop
    SSLEngine on
    SSLCertificateFile /etc/ssl/shop.crt
    ProxyPass /api http://127.0.0.1:9000/
</VirtualHost>
<VirtualHost *:80>
    ServerName shop.example.com
</VirtualHost>`)
	if len(ap) != 2 {
		t.Fatalf("want 2 vhosts, got %d", len(ap))
	}
	if len(ap[0].ServerNames) != 2 || ap[0].ServerNames[1] != "www.shop.example.com" {
		t.Errorf("ServerAlias must count as a name: %+v", ap[0].ServerNames)
	}
	if !ap[0].TLS || ap[0].Roots[0] != "/var/www/shop" || ap[0].Upstreams[0] != "http://127.0.0.1:9000/" {
		t.Errorf("apache vhost: %+v", ap[0])
	}
	if ap[1].TLS {
		t.Errorf("a :80 vhost with no SSLEngine is not TLS: %+v", ap[1])
	}

	cd := ParseCaddyfile("/etc/caddy/Caddyfile", `
{
	email admin@example.com
}

app.example.com, www.app.example.com {
	reverse_proxy 127.0.0.1:3000
	encode gzip
}

http://insecure.example.com {
	root * /srv/static
	file_server
}
`)
	if len(cd) != 2 {
		t.Fatalf("want 2 sites (the global options block is not a site), got %d: %+v", len(cd), cd)
	}
	if len(cd[0].ServerNames) != 2 || !cd[0].TLS || cd[0].Upstreams[0] != "127.0.0.1:3000" {
		t.Errorf("caddy site: %+v", cd[0])
	}
	if cd[1].TLS {
		t.Errorf("an http:// site is not TLS: %+v", cd[1])
	}
	if cd[1].Roots[0] != "/srv/static" {
		t.Errorf("root * /srv/static: %+v", cd[1].Roots)
	}
}

func TestParseCrontab(t *testing.T) {
	entries := ParseCrontab("/etc/cron.d/app", `# m h dom mon dow user command
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin
MAILTO=ops@example.com
0 3 * * * root /srv/myapp/bin/nightly --full
@daily www-data curl -fsS https://hooks.example.com/ping
*/5 * * * * root /usr/bin/flock -n /tmp/x /srv/myapp/bin/poll`, true)
	if len(entries) != 3 {
		t.Fatalf("want 3 jobs (assignments are not jobs), got %d: %+v", len(entries), entries)
	}
	if entries[0].Schedule != "0 3 * * *" || entries[0].User != "root" || entries[0].Command != "/srv/myapp/bin/nightly --full" {
		t.Errorf("first: %+v", entries[0])
	}
	if entries[1].Schedule != "@daily" || entries[1].User != "www-data" {
		t.Errorf("@daily with a user column: %+v", entries[1])
	}
	// MAILTO carries an address, not a secret, but the rule is the same: an
	// assignment line never becomes a command.
	for _, e := range entries {
		if strings.Contains(e.Command, "MAILTO") || strings.Contains(e.Command, "PATH=") {
			t.Errorf("an assignment leaked into a command: %+v", e)
		}
	}

	user := ParseCrontab("/var/spool/cron/crontabs/deploy", "30 2 * * * /home/deploy/backup.sh\n", false)
	if len(user) != 1 || user[0].Command != "/home/deploy/backup.sh" {
		t.Fatalf("a user crontab has no user column: %+v", user)
	}
}

func TestEnvKeysNeverCarriesAValue(t *testing.T) {
	keys := EnvKeys(`# database
DATABASE_URL=postgres://app:hunter2@10.0.0.7:5432/appdb
export STRIPE_SECRET_KEY=sk_live_51abcdef
EMPTY=
QUOTED="a value with = in it"
not a key line
DATABASE_URL=postgres://second/line
lowercase_ok=1`)
	want := []string{"DATABASE_URL", "STRIPE_SECRET_KEY", "EMPTY", "QUOTED", "lowercase_ok"}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Fatalf("keys: %+v, want %+v", keys, want)
	}
	// The whole point: no fragment of any value may appear in the output.
	blob, _ := json.Marshal(EnvFile{Path: "/srv/.env", Keys: keys})
	for _, secret := range []string{"hunter2", "sk_live_51abcdef", "postgres://", "a value with"} {
		if strings.Contains(string(blob), secret) {
			t.Fatalf("a VALUE reached the manifest: %q in %s", secret, blob)
		}
	}
}

func TestParseCompose(t *testing.T) {
	svcs, warns := ParseCompose(`version: "3.8"

services:
  web:
    image: nginx:1.25
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./site:/usr/share/nginx/html:ro
    env_file:
      - .env
    environment:
      - SECRET_KEY=do-not-read-me
      POSTGRES_PASSWORD: hunter2
  db:
    image: postgres:16
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
`)
	if len(warns) != 0 {
		t.Errorf("unexpected warnings: %+v", warns)
	}
	if len(svcs) != 2 {
		t.Fatalf("want 2 services, got %d: %+v", len(svcs), svcs)
	}
	if svcs[0].Name != "web" || svcs[0].Image != "nginx:1.25" || len(svcs[0].Ports) != 2 || svcs[0].EnvFile[0] != ".env" {
		t.Errorf("web: %+v", svcs[0])
	}
	if svcs[1].Name != "db" || len(svcs[1].Ports) != 1 || svcs[1].Ports[0] != "5432:5432" {
		t.Errorf("db (inline list form): %+v", svcs[1])
	}
	blob, _ := json.Marshal(svcs)
	for _, secret := range []string{"do-not-read-me", "hunter2", "SECRET_KEY"} {
		if strings.Contains(string(blob), secret) {
			t.Fatalf("the environment block must never be carried: %q in %s", secret, blob)
		}
	}
}

func TestOutbound(t *testing.T) {
	conns := ParseConnections(`tcp   ESTAB  0 0  10.0.0.5:52344  151.101.1.69:443
udp   ESTAB  0 0  10.0.0.5:41234  8.8.8.8:53
tcp   ESTAB  0 0  10.0.0.5:22     198.51.100.3:60122`)
	if len(conns) != 3 || conns[0].Host != "151.101.1.69" || conns[0].Port != 443 || conns[0].Evidence != "conntrack" {
		t.Fatalf("connections: %+v", conns)
	}

	urls := ExtractURLs("curl -fsS https://hooks.example.com/ping && wget http://mirror.example.org:8080/x https://hooks.example.com/ping", "cron", "/etc/cron.d/app")
	if len(urls) != 2 {
		t.Fatalf("want 2 unique destinations, got %+v", urls)
	}
	if urls[0].Host != "hooks.example.com" || urls[0].Port != 443 {
		t.Errorf("https default port: %+v", urls[0])
	}
	if urls[1].Host != "mirror.example.org" || urls[1].Port != 8080 {
		t.Errorf("explicit port: %+v", urls[1])
	}
	if len(ExtractURLs("http://localhost:3000/health", "unit", "x")) != 0 {
		t.Errorf("localhost is not an outbound destination")
	}
}

func TestParseFindmntWalksTheTree(t *testing.T) {
	mounts := ParseFindmnt(`{
   "filesystems": [
      {"source":"/dev/vda1","target":"/","fstype":"ext4","options":"rw,relatime","size":"42949672960","used":"12884901888",
       "children": [
          {"source":"proc","target":"/proc","fstype":"proc","options":"rw","size":"0","used":"0"},
          {"source":"/dev/vdb1","target":"/var/lib/postgresql","fstype":"xfs","options":"rw","size":"107374182400","used":"53687091200",
           "children": [ {"source":"/dev/vdc1","target":"/var/lib/postgresql/wal","fstype":"xfs","options":"rw","size":"10","used":"5"} ]}
       ]}
   ]
}`)
	if len(mounts) != 3 {
		t.Fatalf("a nested data volume must not be missed: %+v", mounts)
	}
	if mounts[0].Target != "/" || mounts[0].SizeBytes != 42949672960 || mounts[0].UsedBytes != 12884901888 {
		t.Errorf("root: %+v", mounts[0])
	}
	if mounts[1].Target != "/var/lib/postgresql" || mounts[1].FSType != "xfs" {
		t.Errorf("child: %+v", mounts[1])
	}
	if mounts[2].Target != "/var/lib/postgresql/wal" {
		t.Errorf("grandchild: %+v", mounts[2])
	}
	if ParseFindmnt("not json") != nil {
		t.Errorf("garbage in must not panic or invent mounts")
	}
	// findmnt -b prints numbers unquoted on some releases and quoted on
	// others; both must read the same.
	num := ParseFindmnt(`{"filesystems":[{"source":"/dev/vda1","target":"/","fstype":"ext4","size":100,"used":50}]}`)
	if len(num) != 1 || num[0].SizeBytes != 100 || num[0].UsedBytes != 50 {
		t.Errorf("numeric sizes: %+v", num)
	}
}

func TestAppKind(t *testing.T) {
	cases := map[string][]string{
		"node":    {"package.json", "server.js"},
		"php":     {"composer.json"},
		"python":  {"manage.py", "app"},
		"static":  {"index.html", "style.css"},
		"go":      {"go.mod"},
		"compose": {"docker-compose.yml"},
		"unknown": {"README"},
	}
	for want, entries := range cases {
		if got := AppKind(entries); got != want {
			t.Errorf("AppKind(%v) = %q, want %q", entries, got, want)
		}
	}
}

func TestPinNormalization(t *testing.T) {
	hex64 := strings.Repeat("ab", 32)
	if normalizePin("sha256:"+strings.ToUpper(hex64)) != hex64 {
		t.Errorf("a pin is case-insensitive and prefix-optional")
	}
	if normalizePin(hex64) != hex64 {
		t.Errorf("a bare hex pin is a pin")
	}
	for _, bad := range []string{"", "sha256:short", "sha1:" + hex64, strings.Repeat("zz", 32)} {
		if normalizePin(bad) != "" {
			t.Errorf("%q must not be accepted as a pin", bad)
		}
	}
}

func TestMigrateProgressParsing(t *testing.T) {
	cases := map[string]int64{
		"Transferring image: 1.25 GiB (12 MiB/s)": 1342177280,
		"Progress: 512 MiB":                       536870912,
		"nothing numeric here":                    0,
	}
	for line, want := range cases {
		if got := parseMigrateBytes(line); got != want {
			t.Errorf("parseMigrateBytes(%q) = %d, want %d", line, got, want)
		}
	}
}
