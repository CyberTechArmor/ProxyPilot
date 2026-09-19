// Package migrate is the source-side half of a ProxyPilot migration: the
// same binary as the host agent, run on a machine that is being moved.
//
// This file is the PURE half — everything that turns a command's output or a
// configuration file into manifest structure, with no exec and no I/O, so it
// can be tested against captured fixtures from real servers instead of only
// against a lab.
package migrate

import (
	"bufio"
	"encoding/json"
	"path"
	"regexp"
	"strconv"
	"strings"
)

/* ------------------------------ os-release ------------------------------ */

// ParseOSRelease reads /etc/os-release into its ID / VERSION_ID / PRETTY_NAME.
func ParseOSRelease(text string) (id, versionID, pretty string) {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		switch strings.TrimSpace(k) {
		case "ID":
			id = v
		case "VERSION_ID":
			versionID = v
		case "PRETTY_NAME":
			pretty = v
		}
	}
	return id, versionID, pretty
}

/* -------------------------------- sockets ------------------------------- */

// Listener is one listening socket as `ss -lntupH` reports it.
type Listener struct {
	Proto   string `json:"proto"`
	Address string `json:"address"`
	Port    int    `json:"port"`
	Process string `json:"process,omitempty"`
	PID     int    `json:"pid,omitempty"`
	Unit    string `json:"unit,omitempty"`
}

var ssUsersRe = regexp.MustCompile(`\(\("([^"]+)",pid=(\d+)`)

// ParseSS reads `ss -lntupH` (no header) into listeners. Loopback-only
// sockets are kept: an app behind the source's own nginx listens on
// 127.0.0.1, and that is exactly the port the new guest must expose.
func ParseSS(text string) []Listener {
	out := []Listener{}
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 5 {
			continue
		}
		proto := strings.ToLower(fields[0])
		if proto != "tcp" && proto != "udp" {
			continue
		}
		// ss -lntupH columns: Netid State Recv-Q Send-Q Local:Port Peer:Port [users:(...)]
		local := fields[4]
		addr, portStr := splitHostPort(local)
		port, err := strconv.Atoi(portStr)
		if err != nil || port <= 0 {
			continue
		}
		l := Listener{Proto: proto, Address: addr, Port: port}
		if m := ssUsersRe.FindStringSubmatch(sc.Text()); m != nil {
			l.Process = m[1]
			l.PID, _ = strconv.Atoi(m[2])
		}
		out = append(out, l)
	}
	return out
}

func splitHostPort(s string) (string, string) {
	i := strings.LastIndex(s, ":")
	if i < 0 {
		return s, ""
	}
	host := strings.Trim(s[:i], "[]")
	if host == "*" {
		host = "0.0.0.0"
	}
	return host, s[i+1:]
}

/* -------------------------------- systemd ------------------------------- */

// Unit is one systemd service with the facts a migration cares about.
type Unit struct {
	Name             string     `json:"name"`
	State            string     `json:"state,omitempty"`
	Enabled          string     `json:"enabled,omitempty"`
	Description      string     `json:"description,omitempty"`
	Exec             string     `json:"exec,omitempty"`
	WorkingDirectory string     `json:"working_directory,omitempty"`
	User             string     `json:"user,omitempty"`
	EnvFiles         []string   `json:"env_files,omitempty"`
	Ports            []UnitPort `json:"ports,omitempty"`
}

// UnitPort is a port a unit's main process was found listening on.
type UnitPort struct {
	Proto   string `json:"proto"`
	Port    int    `json:"port"`
	Address string `json:"address,omitempty"`
}

// ParseSystemctlList reads `systemctl list-units --type=service --all
// --no-legend --plain` into names and states.
func ParseSystemctlList(text string) []Unit {
	out := []Unit{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		// systemctl marks a failed unit with a leading ● in its own column,
		// which shifts every other column along by one. Drop the marker
		// before reading by position, or a failed unit reads as no unit —
		// and a failed unit is exactly the one a migration needs to see.
		if len(f) > 0 && (f[0] == "●" || f[0] == "*" || f[0] == "×") {
			f = f[1:]
		}
		if len(f) < 4 || !strings.HasSuffix(f[0], ".service") {
			continue
		}
		out = append(out, Unit{Name: f[0], State: f[3], Description: strings.Join(f[4:], " ")})
	}
	return out
}

// ParseSystemctlShow reads `systemctl show <unit> -p …` key=value output.
// EnvironmentFiles arrive as `path (ignore_errors=no)`; only the path is kept.
func ParseSystemctlShow(text string) Unit {
	u := Unit{}
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(strings.TrimRight(line, "\r"), "=")
		if !ok {
			continue
		}
		switch k {
		case "Id":
			u.Name = v
		case "Description":
			u.Description = v
		case "UnitFileState":
			u.Enabled = v
		case "ActiveState":
			u.State = v
		case "User":
			u.User = v
		case "WorkingDirectory":
			u.WorkingDirectory = v
		case "ExecStart":
			u.Exec = execStartPath(v)
		case "EnvironmentFiles":
			for _, f := range strings.Fields(v) {
				if strings.HasPrefix(f, "/") {
					u.EnvFiles = append(u.EnvFiles, f)
				}
			}
		}
	}
	return u
}

var execArgvRe = regexp.MustCompile(`argv\[\]=([^;]+)`)

// execStartPath pulls the command out of systemd's ExecStart record
// (`{ path=/usr/bin/node ; argv[]=/usr/bin/node app.js ; ignore_errors=no …`).
func execStartPath(v string) string {
	if m := execArgvRe.FindStringSubmatch(v); m != nil {
		return strings.TrimSpace(m[1])
	}
	return strings.TrimSpace(v)
}

/* --------------------------------- vhosts ------------------------------- */

// Vhost is one web-server virtual host: who it answers for, and where it
// sends the request.
type Vhost struct {
	Server      string   `json:"server"`
	File        string   `json:"file"`
	TLS         bool     `json:"tls"`
	ServerNames []string `json:"server_names"`
	Listen      []string `json:"listen,omitempty"`
	Roots       []string `json:"roots,omitempty"`
	Upstreams   []string `json:"upstreams,omitempty"`
}

var (
	nginxServerRe   = regexp.MustCompile(`(?m)^\s*server\s*\{`)
	nginxNameRe     = regexp.MustCompile(`(?m)^\s*server_name\s+([^;]+);`)
	nginxListenRe   = regexp.MustCompile(`(?m)^\s*listen\s+([^;]+);`)
	nginxRootRe     = regexp.MustCompile(`(?m)^\s*root\s+([^;]+);`)
	nginxProxyRe    = regexp.MustCompile(`(?m)^\s*proxy_pass\s+([^;]+);`)
	nginxUpstreamRe = regexp.MustCompile(`(?ms)upstream\s+([A-Za-z0-9_.-]+)\s*\{(.*?)\}`)
	nginxServerDir  = regexp.MustCompile(`(?m)^\s*server\s+([^;]+);`)
)

// ParseNginx splits an nginx configuration file into its server blocks. The
// brace walk is deliberate rather than regex-only: a `location` block inside
// a server must not end the server, and a regex cannot count braces.
func ParseNginx(file, text string) []Vhost {
	out := []Vhost{}
	upstreams := map[string][]string{}
	for _, m := range nginxUpstreamRe.FindAllStringSubmatch(text, -1) {
		for _, s := range nginxServerDir.FindAllStringSubmatch(m[2], -1) {
			upstreams[m[1]] = append(upstreams[m[1]], strings.Fields(s[1])[0])
		}
	}
	for _, loc := range nginxServerRe.FindAllStringIndex(text, -1) {
		body, ok := braceBody(text, loc[1]-1)
		if !ok {
			continue
		}
		v := Vhost{Server: "nginx", File: file}
		if m := nginxNameRe.FindStringSubmatch(body); m != nil {
			v.ServerNames = append(v.ServerNames, strings.Fields(m[1])...)
		}
		for _, m := range nginxListenRe.FindAllStringSubmatch(body, -1) {
			l := strings.TrimSpace(m[1])
			v.Listen = append(v.Listen, l)
			if strings.Contains(l, "ssl") || strings.Contains(l, "443") {
				v.TLS = true
			}
		}
		if m := nginxRootRe.FindStringSubmatch(body); m != nil {
			v.Roots = append(v.Roots, strings.TrimSpace(m[1]))
		}
		for _, m := range nginxProxyRe.FindAllStringSubmatch(body, -1) {
			target := strings.TrimSpace(m[1])
			// proxy_pass http://my_upstream; → resolve through the upstream block
			if u := upstreamName(target); u != "" && upstreams[u] != nil {
				v.Upstreams = append(v.Upstreams, upstreams[u]...)
				continue
			}
			v.Upstreams = append(v.Upstreams, target)
		}
		if strings.Contains(body, "ssl_certificate") {
			v.TLS = true
		}
		if len(v.ServerNames) > 0 || len(v.Upstreams) > 0 || len(v.Roots) > 0 {
			out = append(out, v)
		}
	}
	return out
}

func upstreamName(target string) string {
	t := strings.TrimPrefix(strings.TrimPrefix(target, "https://"), "http://")
	t = strings.SplitN(t, "/", 2)[0]
	if strings.Contains(t, ":") || strings.Count(t, ".") >= 1 {
		return ""
	}
	return t
}

// braceBody returns the text between the brace at or after `from` and its
// match, honouring nesting. Quotes and comments are not tracked: nginx and
// apache configs put braces in neither in practice, and a mis-split shows up
// as a vhost with no names, which is dropped.
func braceBody(text string, from int) (string, bool) {
	open := strings.IndexByte(text[from:], '{')
	if open < 0 {
		return "", false
	}
	start := from + open
	depth := 0
	for i := start; i < len(text); i++ {
		switch text[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return text[start+1 : i], true
			}
		}
	}
	return "", false
}

var (
	apacheVhostRe = regexp.MustCompile(`(?is)<VirtualHost([^>]*)>(.*?)</VirtualHost>`)
	apacheNameRe  = regexp.MustCompile(`(?mi)^\s*Server(?:Name|Alias)\s+(.+?)\s*$`)
	apacheRootRe  = regexp.MustCompile(`(?mi)^\s*DocumentRoot\s+"?([^"\s]+)"?`)
	apacheProxyRe = regexp.MustCompile(`(?mi)^\s*ProxyPass\s+\S+\s+(\S+)`)
	apacheSSLOnRe = regexp.MustCompile(`(?mi)^\s*SSLEngine\s+on`)
	apacheCertRe  = regexp.MustCompile(`(?mi)^\s*SSLCertificateFile\s+"?([^"\s]+)"?`)
	// A site address line, never the global options block and never a stray
	// `}`: the head must start with a real address character and must not run
	// across a newline to find its brace.
	caddySiteRe    = regexp.MustCompile(`(?m)^([^\s{#}][^{\n]*)\{`)
	caddyReverseRe = regexp.MustCompile(`(?m)^\s*reverse_proxy\s+(?:(?:/\S+)\s+)?([^\s{]+)`)
	caddyRootRe    = regexp.MustCompile(`(?m)^\s*root\s+(?:\*\s+)?(\S+)`)
)

// ParseApache splits an apache configuration into <VirtualHost> blocks.
func ParseApache(file, text string) []Vhost {
	out := []Vhost{}
	for _, m := range apacheVhostRe.FindAllStringSubmatch(text, -1) {
		addr, body := strings.TrimSpace(m[1]), m[2]
		v := Vhost{Server: "apache", File: file, Listen: []string{addr}}
		for _, n := range apacheNameRe.FindAllStringSubmatch(body, -1) {
			v.ServerNames = append(v.ServerNames, strings.Fields(n[1])...)
		}
		if r := apacheRootRe.FindStringSubmatch(body); r != nil {
			v.Roots = append(v.Roots, r[1])
		}
		for _, p := range apacheProxyRe.FindAllStringSubmatch(body, -1) {
			v.Upstreams = append(v.Upstreams, p[1])
		}
		v.TLS = apacheSSLOnRe.MatchString(body) || apacheCertRe.MatchString(body) || strings.Contains(addr, ":443")
		out = append(out, v)
	}
	return out
}

// ParseCaddyfile splits a Caddyfile into site blocks. A Caddyfile site's
// address line already carries the scheme, so TLS is whatever it says.
func ParseCaddyfile(file, text string) []Vhost {
	out := []Vhost{}
	for _, loc := range caddySiteRe.FindAllStringSubmatchIndex(text, -1) {
		head := strings.TrimSpace(text[loc[2]:loc[3]])
		if head == "" || strings.HasPrefix(head, "(") || strings.HasPrefix(head, "import") {
			continue
		}
		body, ok := braceBody(text, loc[1]-1)
		if !ok {
			continue
		}
		v := Vhost{Server: "caddy", File: file}
		for _, addr := range strings.FieldsFunc(head, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' }) {
			addr = strings.TrimSpace(addr)
			if addr == "" {
				continue
			}
			v.Listen = append(v.Listen, addr)
			name := strings.TrimPrefix(strings.TrimPrefix(addr, "https://"), "http://")
			name = strings.SplitN(name, "/", 2)[0]
			if !strings.HasPrefix(addr, "http://") {
				v.TLS = true
			}
			if h, _, found := strings.Cut(name, ":"); found {
				name = h
			}
			if name != "" {
				v.ServerNames = append(v.ServerNames, name)
			}
		}
		for _, m := range caddyReverseRe.FindAllStringSubmatch(body, -1) {
			v.Upstreams = append(v.Upstreams, m[1])
		}
		if m := caddyRootRe.FindStringSubmatch(body); m != nil {
			v.Roots = append(v.Roots, m[1])
		}
		out = append(out, v)
	}
	return out
}

/* --------------------------------- cron --------------------------------- */

// CronEntry is one scheduled command.
type CronEntry struct {
	Source   string `json:"source"`
	User     string `json:"user,omitempty"`
	Schedule string `json:"schedule"`
	Command  string `json:"command"`
}

var cronSpecialRe = regexp.MustCompile(`^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)\b`)

// ParseCrontab reads a crontab. `withUser` is true for /etc/crontab and
// /etc/cron.d, where a user column sits between the schedule and the command.
func ParseCrontab(source string, text string, withUser bool) []CronEntry {
	out := []CronEntry{}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// Environment assignments (PATH=…, MAILTO=…) are not jobs, and a
		// value could be a secret — never carried.
		if i := strings.IndexByte(line, '='); i > 0 && !strings.ContainsAny(line[:i], " \t") {
			continue
		}
		e := CronEntry{Source: source}
		if m := cronSpecialRe.FindString(line); m != "" {
			e.Schedule = m
			line = strings.TrimSpace(strings.TrimPrefix(line, m))
		} else {
			f := strings.Fields(line)
			if len(f) < 6 {
				continue
			}
			e.Schedule = strings.Join(f[:5], " ")
			line = strings.TrimSpace(strings.Join(f[5:], " "))
		}
		if withUser {
			f := strings.Fields(line)
			if len(f) < 2 {
				continue
			}
			e.User = f[0]
			line = strings.TrimSpace(strings.Join(f[1:], " "))
		}
		e.Command = line
		if e.Command != "" {
			out = append(out, e)
		}
	}
	return out
}

/* ------------------------------- env files ------------------------------ */

// EnvFile is a .env by path and KEY NAMES. There is no field for a value:
// ProxyPilot refuses a manifest that carries one, and this struct cannot
// produce one even by mistake.
type EnvFile struct {
	Path      string   `json:"path"`
	Keys      []string `json:"keys"`
	SizeBytes int64    `json:"size_bytes,omitempty"`
}

var envKeyRe = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]{0,127})\s*=`)

// EnvKeys reads KEY names out of a dotenv file. The value half of every line
// is discarded here, at the source, before anything is serialized — the
// secret never enters the agent's memory as a manifest field at all.
func EnvKeys(text string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		m := envKeyRe.FindStringSubmatch(line)
		if m == nil || seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		out = append(out, m[1])
	}
	return out
}

/* -------------------------------- compose ------------------------------- */

// ComposeService is one service in a compose file.
type ComposeService struct {
	Name    string   `json:"name"`
	Image   string   `json:"image,omitempty"`
	Ports   []string `json:"ports,omitempty"`
	Volumes []string `json:"volumes,omitempty"`
	EnvFile []string `json:"env_file,omitempty"`
}

// ParseCompose reads a docker-compose file well enough to inventory it:
// service names, images, published ports, bind mounts, env_file paths. A
// real YAML parser is not in the standard library and the agent carries no
// dependencies; this walks the two-space indentation compose files use in
// practice and reports what it could not read rather than guessing.
func ParseCompose(text string) ([]ComposeService, []string) {
	out := []ComposeService{}
	warnings := []string{}
	lines := strings.Split(text, "\n")
	inServices := false
	var cur *ComposeService
	var listKey string
	flush := func() {
		if cur != nil {
			out = append(out, *cur)
			cur = nil
		}
	}
	for _, raw := range lines {
		line := strings.TrimRight(raw, "\r")
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		trimmed := strings.TrimSpace(line)
		if indent == 0 {
			flush()
			inServices = strings.HasPrefix(trimmed, "services:")
			continue
		}
		if !inServices {
			continue
		}
		if indent <= 2 && strings.HasSuffix(trimmed, ":") {
			flush()
			cur = &ComposeService{Name: strings.TrimSuffix(trimmed, ":")}
			listKey = ""
			continue
		}
		if cur == nil {
			continue
		}
		if strings.HasPrefix(trimmed, "- ") {
			v := unquote(strings.TrimSpace(strings.TrimPrefix(trimmed, "- ")))
			switch listKey {
			case "ports":
				cur.Ports = append(cur.Ports, v)
			case "volumes":
				cur.Volumes = append(cur.Volumes, v)
			case "env_file":
				cur.EnvFile = append(cur.EnvFile, v)
			}
			continue
		}
		k, v, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = unquote(strings.TrimSpace(v))
		switch k {
		case "image":
			cur.Image = v
			listKey = ""
		case "ports", "volumes", "env_file":
			listKey = k
			if v != "" && v != "[]" {
				// inline form: ports: ["8080:80"]
				for _, item := range strings.Split(strings.Trim(v, "[]"), ",") {
					item = unquote(strings.TrimSpace(item))
					if item == "" {
						continue
					}
					switch k {
					case "ports":
						cur.Ports = append(cur.Ports, item)
					case "volumes":
						cur.Volumes = append(cur.Volumes, item)
					case "env_file":
						cur.EnvFile = append(cur.EnvFile, item)
					}
				}
			}
		case "environment":
			// Values live here. They are never read, never parsed and never
			// sent — the operator types them into ProxyPilot themselves.
			listKey = "environment"
		default:
			listKey = ""
		}
	}
	flush()
	if len(out) == 0 && strings.Contains(text, "services:") {
		warnings = append(warnings, "a compose file declared services but none could be read — check it by hand")
	}
	return out, warnings
}

func unquote(s string) string {
	return strings.Trim(strings.TrimSpace(s), `"'`)
}

/* -------------------------------- outbound ------------------------------ */

// Outbound is one observed or declared outbound destination.
type Outbound struct {
	Host     string `json:"host"`
	Port     int    `json:"port,omitempty"`
	Proto    string `json:"proto"`
	Evidence string `json:"evidence"`
	Detail   string `json:"detail,omitempty"`
}

var (
	connRe = regexp.MustCompile(`^(tcp|udp)\s+\S+\s+\S+\s+\S+\s+(\S+)`)
	urlRe  = regexp.MustCompile(`https?://([A-Za-z0-9._-]+)(?::(\d{2,5}))?`)
)

// ParseConnections reads `ss -tunH state established` (peer address in the
// last address column) into outbound destinations.
func ParseConnections(text string) []Outbound {
	out := []Outbound{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 6 {
			continue
		}
		proto := strings.ToLower(f[0])
		if proto != "tcp" && proto != "udp" {
			continue
		}
		host, portStr := splitHostPort(f[5])
		port, err := strconv.Atoi(portStr)
		if err != nil || host == "" {
			continue
		}
		out = append(out, Outbound{Host: host, Port: port, Proto: proto, Evidence: "conntrack"})
	}
	return out
}

// ExtractURLs finds http(s) destinations in arbitrary text (unit files,
// compose files, crontabs) — the outbound hosts a connection table misses
// because the job that calls them runs once a night.
func ExtractURLs(text, evidence, detail string) []Outbound {
	out := []Outbound{}
	seen := map[string]bool{}
	for _, m := range urlRe.FindAllStringSubmatch(text, -1) {
		host := strings.ToLower(m[1])
		port := 443
		if strings.HasPrefix(m[0], "http://") {
			port = 80
		}
		if m[2] != "" {
			if p, err := strconv.Atoi(m[2]); err == nil {
				port = p
			}
		}
		key := host + ":" + strconv.Itoa(port)
		if seen[key] || host == "localhost" || strings.HasPrefix(host, "127.") {
			continue
		}
		seen[key] = true
		out = append(out, Outbound{Host: host, Port: port, Proto: "tcp", Evidence: evidence, Detail: detail})
	}
	return out
}

/* --------------------------------- disks -------------------------------- */

// Mount is one mounted filesystem.
type Mount struct {
	Source    string `json:"source"`
	Target    string `json:"target"`
	FSType    string `json:"fstype"`
	Options   string `json:"options,omitempty"`
	SizeBytes int64  `json:"size_bytes,omitempty"`
	UsedBytes int64  `json:"used_bytes,omitempty"`
}

type findmntNode struct {
	Source   string          `json:"source"`
	Target   string          `json:"target"`
	FSType   string          `json:"fstype"`
	Options  string          `json:"options"`
	Size     json.RawMessage `json:"size"`
	Used     json.RawMessage `json:"used"`
	Children []findmntNode   `json:"children"`
}

// ParseFindmnt reads `findmnt -J -b -o SOURCE,TARGET,FSTYPE,OPTIONS,SIZE,USED`.
// findmnt answers with a TREE (a bind mount or a nested filesystem is a child
// of the one it sits under), so the walk is recursive — a flat read would
// miss /var, /home and every data volume on a normally partitioned host.
// Pseudo-filesystems are dropped: nothing about them travels.
func ParseFindmnt(jsonText string) []Mount {
	var doc struct {
		Filesystems []findmntNode `json:"filesystems"`
	}
	if err := json.Unmarshal([]byte(jsonText), &doc); err != nil {
		return nil
	}
	out := []Mount{}
	var walk func(nodes []findmntNode, depth int)
	walk = func(nodes []findmntNode, depth int) {
		if depth > 16 {
			return
		}
		for _, f := range nodes {
			if !isPseudoFS(f.FSType) {
				out = append(out, Mount{Source: f.Source, Target: f.Target, FSType: f.FSType, Options: f.Options, SizeBytes: rawInt(f.Size), UsedBytes: rawInt(f.Used)})
			}
			walk(f.Children, depth+1)
		}
	}
	walk(doc.Filesystems, 0)
	return out
}

func rawInt(r json.RawMessage) int64 {
	if len(r) == 0 {
		return 0
	}
	var n int64
	if err := json.Unmarshal(r, &n); err == nil {
		return n
	}
	var s string
	if err := json.Unmarshal(r, &s); err == nil {
		v, _ := strconv.ParseInt(s, 10, 64)
		return v
	}
	return 0
}

var pseudoFS = map[string]bool{
	"proc": true, "sysfs": true, "devtmpfs": true, "devpts": true, "tmpfs": true, "cgroup": true,
	"cgroup2": true, "securityfs": true, "pstore": true, "bpf": true, "debugfs": true, "tracefs": true,
	"configfs": true, "fusectl": true, "mqueue": true, "hugetlbfs": true, "autofs": true, "binfmt_misc": true,
	"nsfs": true, "ramfs": true, "efivarfs": true, "squashfs": true,
}

func isPseudoFS(t string) bool { return pseudoFS[strings.ToLower(t)] }

/* ------------------------------ app guessing ----------------------------- */

// AppKind labels a directory from the files in it, so the operator sees what
// they are adopting without opening a shell.
func AppKind(entries []string) string {
	has := func(n string) bool {
		for _, e := range entries {
			if path.Base(e) == n {
				return true
			}
		}
		return false
	}
	switch {
	case has("package.json"):
		return "node"
	case has("composer.json") || has("index.php"):
		return "php"
	case has("requirements.txt") || has("pyproject.toml") || has("manage.py"):
		return "python"
	case has("Gemfile"):
		return "ruby"
	case has("go.mod"):
		return "go"
	case has("index.html"):
		return "static"
	case has("docker-compose.yml") || has("docker-compose.yaml") || has("compose.yaml"):
		return "compose"
	}
	return "unknown"
}
