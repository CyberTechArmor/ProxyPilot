package migrate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Version is stamped at build time (-ldflags -X …migrate.Version=…).
var Version = "dev"

// ManifestSchema must match lib/migration/manifest.js MANIFEST_SCHEMA. The
// server refuses anything else, which is what keeps an old agent from
// silently sending a shape the server would half-understand.
const ManifestSchema = "proxypilot-migration-manifest@1"

// Manifest is the inventory document. Every field is a fact about the source
// the operator needs in order to decide; none of them is a secret VALUE.
type Manifest struct {
	Schema       string      `json:"schema"`
	CollectedAt  string      `json:"collected_at"`
	AgentVersion string      `json:"agent_version"`
	DurationMs   int64       `json:"duration_ms"`
	Source       Source      `json:"source"`
	OS           OSInfo      `json:"os"`
	Disks        []Disk      `json:"disks"`
	Mounts       []Mount     `json:"mounts"`
	Units        []Unit      `json:"units"`
	Listening    []Listener  `json:"listening"`
	Vhosts       []Vhost     `json:"vhosts"`
	Docker       Docker      `json:"docker"`
	Databases    []Database  `json:"databases"`
	Cron         []CronEntry `json:"cron"`
	TLS          []TLSItem   `json:"tls"`
	EnvFiles     []EnvFile   `json:"env_files"`
	Outbound     []Outbound  `json:"outbound"`
	AppDirs      []AppDir    `json:"app_dirs"`
	Warnings     []string    `json:"warnings"`
	Notes        []string    `json:"notes"`
}

// Source describes the machine itself.
type Source struct {
	Hostname      string   `json:"hostname"`
	Kind          string   `json:"kind"`
	Virt          string   `json:"virt,omitempty"`
	Arch          string   `json:"arch"`
	CPUs          int      `json:"cpus"`
	MemoryBytes   int64    `json:"memory_bytes"`
	Addresses     []string `json:"addresses,omitempty"`
	RootFSBytes   int64    `json:"root_fs_bytes,omitempty"`
	RootUsedBytes int64    `json:"root_used_bytes,omitempty"`
}

// OSInfo is the distribution and kernel.
type OSInfo struct {
	ID        string `json:"id"`
	VersionID string `json:"version_id"`
	Pretty    string `json:"pretty_name"`
	Kernel    string `json:"kernel"`
	Init      string `json:"init"`
}

// Disk is a whole block device.
type Disk struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"size_bytes"`
	Type      string `json:"type,omitempty"`
	Model     string `json:"model,omitempty"`
}

// Docker is what the source runs in containers, if anything.
type Docker struct {
	Present       bool             `json:"present"`
	Version       string           `json:"version,omitempty"`
	ComposeBinary string           `json:"compose_binary,omitempty"`
	ComposeFiles  []ComposeFile    `json:"compose_files"`
	Containers    []DockerContaine `json:"containers"`
}

// ComposeFile is one compose file and the services it declares.
type ComposeFile struct {
	Path      string           `json:"path"`
	SizeBytes int64            `json:"size_bytes,omitempty"`
	Services  []ComposeService `json:"services"`
}

// DockerContaine is one running container (name kept short for the wire).
type DockerContaine struct {
	Name   string   `json:"name"`
	Image  string   `json:"image"`
	Status string   `json:"status,omitempty"`
	Ports  []string `json:"ports,omitempty"`
}

// Database is one database engine found on the source.
type Database struct {
	Engine    string    `json:"engine"`
	Version   string    `json:"version,omitempty"`
	Port      int       `json:"port,omitempty"`
	Socket    string    `json:"socket,omitempty"`
	DataDir   string    `json:"data_dir,omitempty"`
	Running   bool      `json:"running"`
	Databases []DBEntry `json:"databases,omitempty"`
	Paths     []string  `json:"paths,omitempty"`
}

// DBEntry is one database inside an engine.
type DBEntry struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"size_bytes,omitempty"`
}

// TLSItem is where certificate material lives — the path, never the key.
type TLSItem struct {
	Path     string   `json:"path"`
	Kind     string   `json:"kind"`
	Names    []string `json:"names,omitempty"`
	NotAfter string   `json:"not_after,omitempty"`
}

// AppDir is a directory that looks like an application.
type AppDir struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes,omitempty"`
	Files     int64  `json:"files,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Unit      string `json:"unit,omitempty"`
}

// Collector reads the source. `run` is injected so the collectors can be
// exercised against recorded output in tests instead of a live machine.
type Collector struct {
	Run      func(ctx context.Context, name string, args ...string) (string, error)
	ReadDir  func(string) ([]os.DirEntry, error)
	Read     func(string) ([]byte, error)
	Stat     func(string) (os.FileInfo, error)
	Log      func(string, ...any)
	Deadline time.Duration
}

// NewCollector wires a collector to the real machine.
func NewCollector(log func(string, ...any)) *Collector {
	if log == nil {
		log = func(string, ...any) {}
	}
	return &Collector{
		Run: func(ctx context.Context, name string, args ...string) (string, error) {
			cmd := exec.CommandContext(ctx, name, args...)
			cmd.Env = append(os.Environ(), "LC_ALL=C")
			out, err := cmd.Output()
			return string(out), err
		},
		ReadDir:  os.ReadDir,
		Read:     os.ReadFile,
		Stat:     os.Stat,
		Log:      log,
		Deadline: 60 * time.Second,
	}
}

func (c *Collector) sh(name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), c.Deadline)
	defer cancel()
	out, err := c.Run(ctx, name, args...)
	if err != nil && out == "" {
		return ""
	}
	return out
}

func (c *Collector) has(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// Collect walks the source and returns the manifest. It never stops on a
// missing tool: a source without `ss`, or without systemd, still produces
// everything else, and says in `warnings` what it could not see.
func (c *Collector) Collect() *Manifest {
	t0 := time.Now()
	m := &Manifest{
		Schema: ManifestSchema, CollectedAt: time.Now().UTC().Format(time.RFC3339),
		AgentVersion: Version,
		Disks:        []Disk{}, Mounts: []Mount{}, Units: []Unit{}, Listening: []Listener{},
		Vhosts: []Vhost{}, Databases: []Database{}, Cron: []CronEntry{}, TLS: []TLSItem{},
		EnvFiles: []EnvFile{}, Outbound: []Outbound{}, AppDirs: []AppDir{}, Warnings: []string{}, Notes: []string{},
	}
	m.Docker.ComposeFiles = []ComposeFile{}
	m.Docker.Containers = []DockerContaine{}

	c.collectSource(m)
	c.collectMounts(m)
	c.collectDisks(m)
	c.collectListeners(m)
	c.collectUnits(m)
	c.collectVhosts(m)
	c.collectDocker(m)
	c.collectDatabases(m)
	c.collectCron(m)
	c.collectTLS(m)
	c.collectEnvFiles(m)
	c.collectAppDirs(m)
	c.collectOutbound(m)

	m.DurationMs = time.Since(t0).Milliseconds()
	return m
}

func (c *Collector) collectSource(m *Manifest) {
	host, _ := os.Hostname()
	m.Source.Hostname = host
	m.Source.Arch = runtime.GOARCH
	m.Source.CPUs = runtime.NumCPU()
	m.Source.MemoryBytes = memTotalBytes(c)
	m.Source.Virt = strings.TrimSpace(c.sh("systemd-detect-virt"))
	m.Source.Kind = guestKind(m.Source.Virt, c)
	if b, err := c.Read("/etc/os-release"); err == nil {
		m.OS.ID, m.OS.VersionID, m.OS.Pretty = ParseOSRelease(string(b))
	} else {
		m.Warnings = append(m.Warnings, "/etc/os-release could not be read — the OS is unidentified")
	}
	m.OS.Kernel = strings.TrimSpace(c.sh("uname", "-r"))
	if _, err := c.Stat("/run/systemd/system"); err == nil {
		m.OS.Init = "systemd"
	} else {
		m.OS.Init = "other"
	}
	for _, a := range c.addresses() {
		m.Source.Addresses = append(m.Source.Addresses, a)
	}
}

func memTotalBytes(c *Collector) int64 {
	b, err := c.Read("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				kb, _ := strconv.ParseInt(f[1], 10, 64)
				return kb * 1024
			}
		}
	}
	return 0
}

// guestKind separates the three whole-machine cases, because they need
// different transports: a physical host or a VM can run incus-migrate, a
// container generally cannot.
func guestKind(virt string, c *Collector) string {
	switch strings.ToLower(strings.TrimSpace(virt)) {
	case "", "none":
		return "physical"
	case "lxc", "lxc-libvirt", "systemd-nspawn":
		// Incus and LXD guests carry their own socket; everything else that
		// reports itself as an LXC container is Proxmox or a hand-rolled
		// container. The label is for the operator — BOTH take the
		// rootfs-tar transport, because neither can run incus-migrate
		// inside itself (there is no block device of its own to stream).
		for _, sock := range []string{"/dev/incus/sock", "/dev/lxd/sock"} {
			if _, err := c.Stat(sock); err == nil {
				return "lxc"
			}
		}
		if b, err := c.Read("/proc/1/environ"); err == nil && strings.Contains(string(b), "container=lxc") {
			return "proxmox-lxc"
		}
		return "lxc"
	case "docker", "podman":
		return "docker"
	default:
		return "vm"
	}
}

func (c *Collector) addresses() []string {
	out := []string{}
	txt := c.sh("ip", "-o", "-4", "addr", "show")
	for _, line := range strings.Split(txt, "\n") {
		f := strings.Fields(line)
		for i, w := range f {
			if w == "inet" && i+1 < len(f) {
				out = append(out, strings.SplitN(f[i+1], "/", 2)[0])
			}
		}
	}
	return out
}

func (c *Collector) collectMounts(m *Manifest) {
	txt := c.sh("findmnt", "-J", "-b", "-o", "SOURCE,TARGET,FSTYPE,OPTIONS,SIZE,USED")
	if txt == "" {
		m.Warnings = append(m.Warnings, "findmnt is not available — mounts were not collected")
		return
	}
	m.Mounts = ParseFindmnt(txt)
	for _, mt := range m.Mounts {
		if mt.Target == "/" {
			m.Source.RootFSBytes = mt.SizeBytes
			m.Source.RootUsedBytes = mt.UsedBytes
		}
	}
}

func (c *Collector) collectDisks(m *Manifest) {
	txt := c.sh("lsblk", "-J", "-b", "-d", "-o", "NAME,SIZE,TYPE,MODEL")
	if txt == "" {
		return
	}
	var doc struct {
		Blockdevices []struct {
			Name  string          `json:"name"`
			Size  json.RawMessage `json:"size"`
			Type  string          `json:"type"`
			Model string          `json:"model"`
		} `json:"blockdevices"`
	}
	if err := json.Unmarshal([]byte(txt), &doc); err != nil {
		return
	}
	for _, d := range doc.Blockdevices {
		if d.Type != "disk" {
			continue
		}
		m.Disks = append(m.Disks, Disk{Name: "/dev/" + d.Name, SizeBytes: rawInt(d.Size), Type: d.Type, Model: strings.TrimSpace(d.Model)})
	}
}

func (c *Collector) collectListeners(m *Manifest) {
	txt := c.sh("ss", "-lntupH")
	if txt == "" {
		txt = c.sh("netstat", "-lntup")
	}
	if txt == "" {
		m.Warnings = append(m.Warnings, "neither ss nor netstat is available — listening ports were not collected")
		return
	}
	m.Listening = ParseSS(txt)
}

var unitOfPIDRe = regexp.MustCompile(`(?m)^\d+:name=systemd:/system\.slice/(?:.*/)?([^/\n]+\.service)`)

func (c *Collector) collectUnits(m *Manifest) {
	if m.OS.Init != "systemd" {
		return
	}
	list := ParseSystemctlList(c.sh("systemctl", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager"))
	byPID := map[int]string{}
	for _, l := range m.Listening {
		if l.PID > 0 {
			if u := c.unitOfPID(l.PID); u != "" {
				byPID[l.PID] = u
			}
		}
	}
	for i, l := range m.Listening {
		if u, ok := byPID[l.PID]; ok {
			m.Listening[i].Unit = u
		}
	}
	for _, u := range list {
		// Only look closely at units that are running or enabled: a distro
		// ships a hundred oneshots nobody has ever started.
		if u.State != "running" && u.State != "active" && u.State != "exited" {
			continue
		}
		full := ParseSystemctlShow(c.sh("systemctl", "show", u.Name, "-p", "Id,Description,UnitFileState,ActiveState,User,WorkingDirectory,ExecStart,EnvironmentFiles", "--no-pager"))
		if full.Name == "" {
			full.Name = u.Name
		}
		if full.Description == "" {
			full.Description = u.Description
		}
		for _, l := range m.Listening {
			if l.Unit == full.Name {
				full.Ports = append(full.Ports, UnitPort{Proto: l.Proto, Port: l.Port, Address: l.Address})
			}
		}
		m.Units = append(m.Units, full)
	}
}

func (c *Collector) unitOfPID(pid int) string {
	b, err := c.Read(fmt.Sprintf("/proc/%d/cgroup", pid))
	if err != nil {
		return ""
	}
	txt := string(b)
	if m := unitOfPIDRe.FindStringSubmatch(txt); m != nil {
		return m[1]
	}
	// cgroup v2: a single `0::/system.slice/nginx.service` line.
	for _, line := range strings.Split(txt, "\n") {
		if i := strings.LastIndex(line, "/"); i >= 0 && strings.HasSuffix(line, ".service") {
			return line[i+1:]
		}
	}
	return ""
}

var vhostGlobs = []struct {
	glob   string
	parser func(file, text string) []Vhost
}{
	{"/etc/nginx/sites-enabled/*", ParseNginx},
	{"/etc/nginx/conf.d/*.conf", ParseNginx},
	{"/etc/nginx/nginx.conf", ParseNginx},
	{"/etc/apache2/sites-enabled/*", ParseApache},
	{"/etc/httpd/conf.d/*.conf", ParseApache},
	{"/etc/caddy/Caddyfile", ParseCaddyfile},
	{"/etc/caddy/conf.d/*", ParseCaddyfile},
}

func (c *Collector) collectVhosts(m *Manifest) {
	for _, g := range vhostGlobs {
		paths, _ := filepath.Glob(g.glob)
		for _, p := range paths {
			st, err := c.Stat(p)
			if err != nil || st.IsDir() || st.Size() > 4<<20 {
				continue
			}
			b, err := c.Read(p)
			if err != nil {
				continue
			}
			m.Vhosts = append(m.Vhosts, g.parser(p, string(b))...)
		}
	}
}

func (c *Collector) collectDocker(m *Manifest) {
	if !c.has("docker") {
		return
	}
	m.Docker.Present = true
	m.Docker.Version = strings.TrimSpace(c.sh("docker", "--version"))
	out := c.sh("docker", "ps", "--all", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}")
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(strings.TrimRight(line, "\r"), "\t")
		if len(f) < 2 || f[0] == "" {
			continue
		}
		dc := DockerContaine{Name: f[0], Image: f[1]}
		if len(f) > 2 {
			dc.Status = f[2]
		}
		if len(f) > 3 && f[3] != "" {
			dc.Ports = strings.Split(f[3], ", ")
		}
		m.Docker.Containers = append(m.Docker.Containers, dc)
	}
	for _, g := range []string{"/srv/*/docker-compose.y*ml", "/opt/*/docker-compose.y*ml", "/root/*/docker-compose.y*ml", "/home/*/*/docker-compose.y*ml", "/docker-compose.y*ml", "/srv/*/compose.y*ml", "/opt/*/compose.y*ml"} {
		paths, _ := filepath.Glob(g)
		for _, p := range paths {
			st, err := c.Stat(p)
			if err != nil || st.Size() > 1<<20 {
				continue
			}
			b, err := c.Read(p)
			if err != nil {
				continue
			}
			svcs, warns := ParseCompose(string(b))
			m.Docker.ComposeFiles = append(m.Docker.ComposeFiles, ComposeFile{Path: p, SizeBytes: st.Size(), Services: svcs})
			for _, w := range warns {
				m.Warnings = append(m.Warnings, p+": "+w)
			}
			m.Outbound = append(m.Outbound, ExtractURLs(string(b), "compose", p)...)
		}
	}
	if len(m.Docker.Containers) > 0 {
		m.Notes = append(m.Notes, "the application is CONTAINERIZED on the source: a whole-machine migration into a nested guest keeps it running as-is, and an adopt cycle can convert it later")
	}
}

func (c *Collector) collectDatabases(m *Manifest) {
	// PostgreSQL
	if c.has("psql") || c.has("pg_dump") {
		d := Database{Engine: "postgres", Port: 5432}
		d.Version = strings.TrimSpace(firstLine(c.sh("psql", "--version")))
		out, err := c.runAs("postgres", "psql", "-At", "-F", "|", "-c", "select datname, pg_database_size(datname) from pg_database where not datistemplate")
		d.Running = err == nil && strings.TrimSpace(out) != ""
		for _, line := range strings.Split(out, "\n") {
			name, size, ok := strings.Cut(strings.TrimSpace(line), "|")
			if !ok || name == "" {
				continue
			}
			n, _ := strconv.ParseInt(size, 10, 64)
			d.Databases = append(d.Databases, DBEntry{Name: name, SizeBytes: n})
		}
		for _, g := range []string{"/var/lib/postgresql/*/main", "/var/lib/pgsql/data"} {
			if p, _ := filepath.Glob(g); len(p) > 0 {
				d.DataDir = p[0]
			}
		}
		m.Databases = append(m.Databases, d)
	}
	// MySQL / MariaDB
	if c.has("mysql") || c.has("mariadb") {
		d := Database{Engine: "mysql", Port: 3306}
		d.Version = strings.TrimSpace(firstLine(c.sh("mysql", "--version")))
		out := c.sh("mysql", "-N", "-B", "-e", "select table_schema, sum(data_length+index_length) from information_schema.tables group by table_schema")
		d.Running = strings.TrimSpace(out) != ""
		for _, line := range strings.Split(out, "\n") {
			f := strings.Fields(line)
			if len(f) == 0 {
				continue
			}
			n := int64(0)
			if len(f) > 1 {
				n, _ = strconv.ParseInt(f[1], 10, 64)
			}
			d.Databases = append(d.Databases, DBEntry{Name: f[0], SizeBytes: n})
		}
		m.Databases = append(m.Databases, d)
	}
	// SQLite files inside the application directories are found by
	// collectAppDirs and recorded as paths, because a .db file is only a
	// database if something opens it.
}

// runAs runs a command as another user where the agent has the privilege
// (postgres refuses a root psql by default on most distributions).
func (c *Collector) runAs(user, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), c.Deadline)
	defer cancel()
	if os.Geteuid() == 0 && c.has("su") {
		full := append([]string{"-s", "/bin/sh", "-c", shellJoin(append([]string{name}, args...)), user}, []string{}...)
		return c.Run(ctx, "su", full...)
	}
	return c.Run(ctx, name, args...)
}

func shellJoin(argv []string) string {
	parts := make([]string, 0, len(argv))
	for _, a := range argv {
		if regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`).MatchString(a) {
			parts = append(parts, a)
			continue
		}
		parts = append(parts, "'"+strings.ReplaceAll(a, "'", `'\''`)+"'")
	}
	return strings.Join(parts, " ")
}

func (c *Collector) collectCron(m *Manifest) {
	if b, err := c.Read("/etc/crontab"); err == nil {
		m.Cron = append(m.Cron, ParseCrontab("/etc/crontab", string(b), true)...)
	}
	if entries, err := c.ReadDir("/etc/cron.d"); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			p := filepath.Join("/etc/cron.d", e.Name())
			if b, err := c.Read(p); err == nil {
				m.Cron = append(m.Cron, ParseCrontab(p, string(b), true)...)
			}
		}
	}
	if entries, err := c.ReadDir("/var/spool/cron/crontabs"); err == nil {
		for _, e := range entries {
			p := filepath.Join("/var/spool/cron/crontabs", e.Name())
			if b, err := c.Read(p); err == nil {
				for _, c2 := range ParseCrontab(p, string(b), false) {
					c2.User = e.Name()
					m.Cron = append(m.Cron, c2)
				}
			}
		}
	}
	for _, e := range m.Cron {
		m.Outbound = append(m.Outbound, ExtractURLs(e.Command, "cron", e.Source)...)
	}
}

func (c *Collector) collectTLS(m *Manifest) {
	globs := []struct{ glob, kind string }{
		{"/etc/letsencrypt/live/*/fullchain.pem", "cert"},
		{"/etc/letsencrypt/live/*/privkey.pem", "key"},
		{"/etc/ssl/certs/*.pem", "cert"},
		{"/etc/nginx/ssl/*", "cert"},
		{"/var/lib/caddy/.local/share/caddy/certificates", "acme-store"},
		{"/root/.acme.sh", "acme-store"},
	}
	for _, g := range globs {
		paths, _ := filepath.Glob(g.glob)
		for _, p := range paths {
			if len(m.TLS) >= 128 {
				return
			}
			// /etc/ssl/certs is mostly the CA bundle; only report it when it
			// is plainly a site certificate directory.
			if strings.HasPrefix(p, "/etc/ssl/certs/") && !strings.Contains(p, m.Source.Hostname) {
				continue
			}
			item := TLSItem{Path: p, Kind: g.kind}
			if g.kind == "cert" && c.has("openssl") {
				out := c.sh("openssl", "x509", "-noout", "-subject", "-enddate", "-in", p)
				for _, line := range strings.Split(out, "\n") {
					if cn, ok := strings.CutPrefix(line, "subject="); ok {
						item.Names = append(item.Names, strings.TrimSpace(cn))
					}
					if na, ok := strings.CutPrefix(line, "notAfter="); ok {
						item.NotAfter = strings.TrimSpace(na)
					}
				}
			}
			m.TLS = append(m.TLS, item)
		}
	}
}

func (c *Collector) collectEnvFiles(m *Manifest) {
	seen := map[string]bool{}
	candidates := []string{}
	for _, u := range m.Units {
		candidates = append(candidates, u.EnvFiles...)
		if u.WorkingDirectory != "" {
			candidates = append(candidates, filepath.Join(u.WorkingDirectory, ".env"))
		}
	}
	for _, g := range []string{"/srv/*/.env", "/opt/*/.env", "/var/www/*/.env", "/home/*/*/.env", "/etc/default/*", "/srv/*/*/.env"} {
		paths, _ := filepath.Glob(g)
		candidates = append(candidates, paths...)
	}
	for _, cf := range m.Docker.ComposeFiles {
		dir := filepath.Dir(cf.Path)
		candidates = append(candidates, filepath.Join(dir, ".env"))
		for _, s := range cf.Services {
			for _, e := range s.EnvFile {
				if strings.HasPrefix(e, "/") {
					candidates = append(candidates, e)
				} else {
					candidates = append(candidates, filepath.Join(dir, e))
				}
			}
		}
	}
	for _, p := range candidates {
		if seen[p] || len(m.EnvFiles) >= 128 {
			continue
		}
		seen[p] = true
		st, err := c.Stat(p)
		if err != nil || st.IsDir() || st.Size() > 1<<20 {
			continue
		}
		b, err := c.Read(p)
		if err != nil {
			continue
		}
		keys := EnvKeys(string(b))
		if len(keys) == 0 {
			continue
		}
		// Only the names leave this function. The bytes holding the values
		// go out of scope here and are never placed in a manifest field.
		m.EnvFiles = append(m.EnvFiles, EnvFile{Path: p, Keys: keys, SizeBytes: st.Size()})
	}
}

func (c *Collector) collectAppDirs(m *Manifest) {
	seen := map[string]bool{}
	add := func(p, unit string) {
		p = filepath.Clean(p)
		if p == "/" || p == "." || seen[p] || len(m.AppDirs) >= 128 {
			return
		}
		st, err := c.Stat(p)
		if err != nil || !st.IsDir() {
			return
		}
		seen[p] = true
		entries, _ := c.ReadDir(p)
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		d := AppDir{Path: p, Kind: AppKind(names), Unit: unit}
		d.SizeBytes, d.Files = c.dirSize(p)
		m.AppDirs = append(m.AppDirs, d)
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".db") || strings.HasSuffix(e.Name(), ".sqlite") || strings.HasSuffix(e.Name(), ".sqlite3") {
				m.Databases = append(m.Databases, Database{Engine: "sqlite", Running: true, Paths: []string{filepath.Join(p, e.Name())}})
			}
		}
	}
	for _, u := range m.Units {
		if u.WorkingDirectory != "" && u.WorkingDirectory != "/" {
			add(u.WorkingDirectory, u.Name)
		}
	}
	for _, v := range m.Vhosts {
		for _, r := range v.Roots {
			add(r, "")
		}
	}
	for _, cf := range m.Docker.ComposeFiles {
		add(filepath.Dir(cf.Path), "")
	}
	for _, g := range []string{"/srv/*", "/var/www/*", "/opt/*"} {
		paths, _ := filepath.Glob(g)
		for _, p := range paths {
			add(p, "")
		}
	}
	sort.Slice(m.AppDirs, func(i, j int) bool { return m.AppDirs[i].SizeBytes > m.AppDirs[j].SizeBytes })
}

// dirSize uses du, which is far faster than walking from Go and is present
// everywhere. A directory it cannot read reports what it could.
func (c *Collector) dirSize(p string) (int64, int64) {
	out := c.sh("du", "-sb", "--", p)
	f := strings.Fields(out)
	var bytes int64
	if len(f) > 0 {
		bytes, _ = strconv.ParseInt(f[0], 10, 64)
	}
	cnt := strings.TrimSpace(c.sh("sh", "-c", "find "+shellJoin([]string{p})+" -type f 2>/dev/null | wc -l"))
	files, _ := strconv.ParseInt(cnt, 10, 64)
	return bytes, files
}

func (c *Collector) collectOutbound(m *Manifest) {
	if txt := c.sh("ss", "-tunH", "state", "established"); txt != "" {
		m.Outbound = append(m.Outbound, ParseConnections(txt)...)
	}
	for _, u := range m.Units {
		if u.Exec != "" {
			m.Outbound = append(m.Outbound, ExtractURLs(u.Exec, "unit", u.Name)...)
		}
	}
	if b, err := c.Read("/etc/resolv.conf"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if ns, ok := strings.CutPrefix(strings.TrimSpace(line), "nameserver "); ok {
				m.Outbound = append(m.Outbound, Outbound{Host: strings.TrimSpace(ns), Port: 53, Proto: "udp", Evidence: "resolv", Detail: "/etc/resolv.conf"})
			}
		}
	}
	if len(m.Outbound) > 512 {
		m.Outbound = m.Outbound[:512]
		m.Warnings = append(m.Warnings, "more than 512 outbound destinations were observed; the list was truncated")
	}
}
