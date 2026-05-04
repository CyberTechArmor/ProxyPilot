//go:build linux

package methods

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// CVE-2026-31431 ("Copy Fail") — Linux kernel algif_aead local
// privilege escalation. Any unprivileged UID can write 4 bytes into
// the page cache of a setuid binary by binding AF_ALG aead to
// authencesn(hmac(sha256),cbc(aes)). Debian 13 trixie ships the fix
// in linux source >= 6.12.85-1; upstream stable kernels >= 6.12.85
// (or any later major) carry the fix even without a distro package.
//
// This file exposes two RPCs to the dashboard:
//
//   security.cve_2026_31431.check  — read-only detection. Reports
//   the host's classification (resolved / vulnerable / blocked /
//   unknown) plus the inputs the verdict was drawn from.
//
//   security.cve_2026_31431.patch  — applies the resolution: prefers
//   `apt-get install --only-upgrade linux-image-*`; falls back to a
//   grub initcall_blacklist + modprobe install-/bin/false mitigation
//   when no upgrade is available. Writes a YAML record to the
//   ProxyPilot CVE inbox so the engine and human reviewers see the
//   action that was taken. Refuses to mitigate when IPsec ESN is in
//   use or OpenSSL's afalg engine is enabled, unless the caller
//   passes force=true (operator has accepted the breakage).

const (
	cveID                 = "CVE-2026-31431"
	cveName               = "Copy Fail"
	cveDisclosed          = "2026-04-29"
	cveCVSS               = 7.8
	cveImpact             = "LOCAL_LPE"
	cveBlastRadius        = "HOST_FULL"
	cveSourcePrimary      = "https://copy.fail"
	cveSourceTracker      = "https://security-tracker.debian.org/tracker/CVE-2026-31431"
	fixedTrixieSourceVer  = "6.12.85-1"
	aeadVulnAlg           = "authencesn(hmac(sha256),cbc(aes))"
	cveInboxFilename      = "CVE-2026-31431.yaml"
	grubMitigationToken   = "initcall_blacklist=algif_aead_init"
	modprobeBlacklistBody = "install algif_aead /bin/false\n"
)

// fixedKernelMin is the upstream baseline above which the fix is
// always present, used when no Debian linux-image-* is installed
// (firecracker microVMs, custom-built kernels supplied externally).
var fixedKernelMin = kernelTriple{6, 12, 85}

// Swappable command paths and filesystem locations. Tests redirect
// each of these to a stub or t.TempDir so handler logic exercises
// every branch without touching the real host.
var (
	unameBin         = "/bin/uname"
	hostnameBin      = "/bin/hostname"
	dpkgQueryBin     = "/usr/bin/dpkg-query"
	dpkgBin          = "/usr/bin/dpkg"
	aptGetBin        = "/usr/bin/apt-get"
	grubbyBin        = "/usr/sbin/grubby"
	updateGrubBin    = "/usr/sbin/update-grub"
	modprobeBin      = "/sbin/modprobe"
	ipBin            = "/sbin/ip"
	opensslCnfPath   = "/etc/ssl/openssl.cnf"
	grubDefaultPath  = "/etc/default/grub"
	cveBlacklistPath = "/etc/modprobe.d/proxypilot-cve-2026-31431.conf"
	cveInboxDir      = "/var/lib/proxypilot/cve-inbox"
	cveNow           = func() time.Time { return time.Now().UTC() }
)

// algBindProbe reports whether the kernel exposes the vulnerable
// AF_ALG aead bind. Tests substitute this var directly.
//
// We probe in-process from whatever UID the agent runs under: the
// vulnerable surface is reachable from any UID at the kernel layer,
// so the bind verdict is UID-independent. (The CVE's privilege
// escalation requires further setup beyond the bind itself; we
// don't reproduce that here — only the reachability signal.)
var algBindProbe = bindAEADProbe

// =============================================================
// Status / wire shapes
// =============================================================

// CVE state.status enum, mirrors the YAML inbox schema.
const (
	statusVulnerable             = "vulnerable"
	statusMitigatedPendingReboot = "mitigated-pending-reboot"
	statusPatchedPendingReboot   = "patched-pending-reboot"
	statusResolved               = "resolved"
	statusBlocked                = "blocked"
	statusUnknown                = "unknown"
)

type cveCheckResult struct {
	CVE                 string `json:"cve"`
	Host                string `json:"host"`
	RunningKernel       string `json:"running_kernel"`
	InstalledKernel     string `json:"installed_kernel"`
	AEADBindReachable   bool   `json:"aead_bind_reachable"`
	AEADBindError       string `json:"aead_bind_error,omitempty"`
	IPsecESNInUse       bool   `json:"ipsec_esn_in_use"`
	OpenSSLAFAlgEnabled bool   `json:"openssl_afalg_enabled"`
	BlockedReason       string `json:"blocked_reason,omitempty"`
	Classification      string `json:"classification"`
}

type cvePatchParams struct {
	// Force overrides the IPsec-ESN / OpenSSL-afalg safety gate.
	// The operator has accepted that the mitigation will break those
	// callers. Has no effect on the apt-get upgrade path, which is
	// always safe to run.
	Force bool `json:"force,omitempty"`
	// MitigateOnly skips the apt upgrade attempt and goes straight
	// to grub/modprobe mitigation. Useful when the operator knows
	// the package archive doesn't yet carry a fix.
	MitigateOnly bool `json:"mitigate_only,omitempty"`
	// PatchOnly skips the mitigation fallback. If apt can't upgrade,
	// the result is left as `vulnerable` for the caller to decide
	// how to proceed.
	PatchOnly bool `json:"patch_only,omitempty"`
}

type cvePatchResult struct {
	cveCheckResult
	Status                 string   `json:"status"`
	ActionsTaken           []string `json:"actions_taken"`
	OperatorActionRequired string   `json:"operator_action_required"`
	InboxPath              string   `json:"inbox_path"`
}

// =============================================================
// Handlers
// =============================================================

// SecurityCVE202631431Check is the security.cve_2026_31431.check
// RPC handler: read-only detection only. Never writes to the host.
func SecurityCVE202631431Check(_ json.RawMessage) (any, *Error) {
	r, err := runCheck()
	if err != nil {
		return nil, err
	}
	return r, nil
}

// SecurityCVE202631431Patch is the security.cve_2026_31431.patch
// RPC handler. Detects, applies the right resolution, writes a YAML
// inbox record, and returns the full action trace.
func SecurityCVE202631431Patch(params json.RawMessage) (any, *Error) {
	var p cvePatchParams
	if len(params) > 0 && string(params) != "null" {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &Error{Code: "invalid_params", Message: "params must be {force?,mitigate_only?,patch_only?:bool}: " + err.Error()}
		}
	}
	if p.MitigateOnly && p.PatchOnly {
		return nil, &Error{Code: "invalid_params", Message: "mitigate_only and patch_only are mutually exclusive"}
	}

	check, cerr := runCheck()
	if cerr != nil {
		return nil, cerr
	}
	out := cvePatchResult{cveCheckResult: check, ActionsTaken: []string{}}

	// Safety gate: if the host is using IPsec ESN or has OpenSSL's
	// afalg engine enabled, the mitigation would break them. Block
	// the action unless the operator forces it. apt-get upgrade is
	// still safe — only skip it if mitigate_only was requested.
	if check.BlockedReason != "" && !p.Force {
		out.Status = statusBlocked
		out.OperatorActionRequired = "confirm-esn-impact"
		if writeErr := writeInbox(&out); writeErr != nil {
			return nil, writeErr
		}
		return out, nil
	}

	// Already resolved — record it and exit. No mutating actions.
	if check.Classification == statusResolved {
		out.Status = statusResolved
		out.OperatorActionRequired = "none"
		if writeErr := writeInbox(&out); writeErr != nil {
			return nil, writeErr
		}
		return out, nil
	}

	// Patch path: try to upgrade linux-image-* via apt. If a new
	// kernel was installed the host needs a reboot. Skip if the
	// caller asked for mitigation only.
	upgraded := false
	if !p.MitigateOnly {
		var perr *Error
		upgraded, perr = aptUpgradeKernel(&out)
		if perr != nil {
			return nil, perr
		}
	}
	if upgraded {
		out.Status = statusPatchedPendingReboot
		out.OperatorActionRequired = "reboot"
		if writeErr := writeInbox(&out); writeErr != nil {
			return nil, writeErr
		}
		return out, nil
	}

	// No upgrade. Mitigate unless the caller said patch-only.
	if p.PatchOnly {
		out.Status = statusVulnerable
		out.OperatorActionRequired = "none"
		if writeErr := writeInbox(&out); writeErr != nil {
			return nil, writeErr
		}
		return out, nil
	}
	if perr := applyMitigation(&out); perr != nil {
		return nil, perr
	}
	out.Status = statusMitigatedPendingReboot
	out.OperatorActionRequired = "reboot"
	if writeErr := writeInbox(&out); writeErr != nil {
		return nil, writeErr
	}
	return out, nil
}

// =============================================================
// Detection
// =============================================================

func runCheck() (cveCheckResult, *Error) {
	r := cveCheckResult{CVE: cveID}

	r.Host = readHostname()
	r.RunningKernel = readRunningKernel()
	r.InstalledKernel = readInstalledKernelVersion()

	ok, errno := algBindProbe()
	r.AEADBindReachable = ok
	if !ok && errno != 0 {
		r.AEADBindError = errnoString(errno)
	}

	r.IPsecESNInUse = ipsecESNInUse()
	r.OpenSSLAFAlgEnabled = opensslAFAlgEnabled()
	if r.IPsecESNInUse {
		r.BlockedReason = "IPsec ESN is in use; algif_aead mitigation would break it"
	} else if r.OpenSSLAFAlgEnabled {
		r.BlockedReason = "OpenSSL afalg engine is enabled in " + opensslCnfPath
	}

	r.Classification = classify(&r)
	return r, nil
}

func classify(r *cveCheckResult) string {
	// Authoritative signal: the AF_ALG bind. Unreachable means the
	// vulnerable code path can't be triggered, regardless of how we
	// got there (patch, modprobe blacklist, or a kernel that never
	// shipped CRYPTO_USER_API_AEAD).
	if !r.AEADBindReachable {
		return statusResolved
	}
	// Reachable AND running a kernel >= the upstream fix baseline:
	// the fix is in but the surface still binds. Treat as resolved
	// — the bind succeeding is expected, the 4-byte write is what
	// the patch closes, and we can't reproduce the write safely.
	if k, ok := parseKernel(r.RunningKernel); ok && !k.less(fixedKernelMin) {
		return statusResolved
	}
	// Reachable AND running an older kernel: vulnerable.
	if _, ok := parseKernel(r.RunningKernel); ok {
		return statusVulnerable
	}
	return statusUnknown
}

func readHostname() string {
	out, _, err := runCVECmd(hostnameBin)
	if err == nil {
		s := strings.TrimSpace(string(out))
		if s != "" {
			return s
		}
	}
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "unknown"
}

func readRunningKernel() string {
	out, _, err := runCVECmd(unameBin, "-r")
	if err == nil {
		return strings.TrimSpace(string(out))
	}
	var u syscall.Utsname
	if syscall.Uname(&u) == nil {
		buf := make([]byte, 0, len(u.Release))
		for _, c := range u.Release {
			if c == 0 {
				break
			}
			buf = append(buf, byte(c))
		}
		return string(buf)
	}
	return ""
}

// readInstalledKernelVersion returns the highest linux-image-*
// version dpkg reports as installed, or "none-installed-via-dpkg"
// when no matching package is installed (firecracker microVMs).
func readInstalledKernelVersion() string {
	out, _, err := runCVECmd(dpkgQueryBin, "-W", "-f=${Package}\t${Version}\t${Status}\n", "linux-image-*")
	if err != nil {
		return "none-installed-via-dpkg"
	}
	versions := []string{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Split(strings.TrimSpace(line), "\t")
		if len(fields) < 3 {
			continue
		}
		if !strings.Contains(fields[2], "installed") {
			continue
		}
		if fields[1] == "" {
			continue
		}
		versions = append(versions, fields[1])
	}
	if len(versions) == 0 {
		return "none-installed-via-dpkg"
	}
	sort.Slice(versions, func(i, j int) bool {
		return dpkgVersionCompare(versions[i], versions[j]) < 0
	})
	return versions[len(versions)-1]
}

// dpkgVersionCompare returns -1/0/1 like strcmp, deferring to
// `dpkg --compare-versions` when available. Falls back to a plain
// string compare which is good enough for sort stability when dpkg
// is missing (we don't make security decisions on the fallback).
func dpkgVersionCompare(a, b string) int {
	cmd := exec.Command(dpkgBin, "--compare-versions", a, "lt", b)
	if err := cmd.Run(); err == nil {
		return -1
	}
	cmd = exec.Command(dpkgBin, "--compare-versions", a, "gt", b)
	if err := cmd.Run(); err == nil {
		return 1
	}
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

// kernelTriple is a parsed major.minor.patch kernel version.
type kernelTriple struct{ major, minor, patch int }

func (k kernelTriple) less(o kernelTriple) bool {
	if k.major != o.major {
		return k.major < o.major
	}
	if k.minor != o.minor {
		return k.minor < o.minor
	}
	return k.patch < o.patch
}

var kernelTripleRe = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)`)

func parseKernel(s string) (kernelTriple, bool) {
	m := kernelTripleRe.FindStringSubmatch(s)
	if m == nil {
		return kernelTriple{}, false
	}
	a, _ := strconv.Atoi(m[1])
	b, _ := strconv.Atoi(m[2])
	c, _ := strconv.Atoi(m[3])
	return kernelTriple{a, b, c}, true
}

func ipsecESNInUse() bool {
	out, _, err := runCVECmd(ipBin, "xfrm", "state")
	if err != nil {
		// `ip` not installed → iproute2 absent → no SAs possible.
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(strings.ToLower(line), "esn") {
			return true
		}
	}
	return false
}

func opensslAFAlgEnabled() bool {
	data, err := os.ReadFile(opensslCnfPath)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "#") || strings.HasPrefix(t, ";") {
			continue
		}
		if strings.Contains(t, "afalg") {
			return true
		}
	}
	return false
}

// =============================================================
// AF_ALG bind probe — direct kernel reachability test.
// =============================================================

// sockaddrAlg mirrors `struct sockaddr_alg` from <linux/if_alg.h>.
// 2 + 14 + 4 + 4 + 64 = 88 bytes.
type sockaddrAlg struct {
	family  uint16
	algType [14]byte
	feat    uint32
	mask    uint32
	name    [64]byte
}

func bindAEADProbe() (bool, syscall.Errno) {
	fd, err := syscall.Socket(syscall.AF_ALG, syscall.SOCK_SEQPACKET, 0)
	if err != nil {
		if e, ok := err.(syscall.Errno); ok {
			return false, e
		}
		return false, 0
	}
	defer syscall.Close(fd)

	var sa sockaddrAlg
	sa.family = syscall.AF_ALG
	copy(sa.algType[:], "aead")
	copy(sa.name[:], aeadVulnAlg)

	_, _, e := syscall.Syscall(syscall.SYS_BIND, uintptr(fd),
		uintptr(unsafe.Pointer(&sa)), unsafe.Sizeof(sa))
	if e != 0 {
		return false, e
	}
	return true, 0
}

func errnoString(e syscall.Errno) string {
	if e == 0 {
		return ""
	}
	return e.Error()
}

// =============================================================
// Patch & mitigation
// =============================================================

// aptUpgradeKernel runs `apt-get update` then
// `apt-get install -y --only-upgrade 'linux-image-*'`. Returns true
// if the installed-kernel version moved as a result.
func aptUpgradeKernel(out *cvePatchResult) (bool, *Error) {
	before := out.InstalledKernel

	updateOut, updateErr, err := runCVECmd(aptGetBin, "update")
	out.ActionsTaken = append(out.ActionsTaken, "apt-get update")
	if err != nil {
		// `apt-get update` failures are common on hosts with
		// archive issues; we still want to try the install. Record
		// the error in the trace and continue.
		out.ActionsTaken = append(out.ActionsTaken,
			fmt.Sprintf("# apt-get update failed: %s", firstNonEmpty(string(updateErr), string(updateOut), err.Error())))
	}

	_, instErr, err := runCVECmd(aptGetBin, "install", "-y", "--only-upgrade", "linux-image-*")
	out.ActionsTaken = append(out.ActionsTaken, "apt-get install -y --only-upgrade 'linux-image-*'")
	if err != nil {
		// Non-zero apt-get install: surface the message but don't
		// fail the whole patch — we'll fall through to mitigation.
		out.ActionsTaken = append(out.ActionsTaken,
			fmt.Sprintf("# apt-get install --only-upgrade exited non-zero: %s", firstNonEmpty(string(instErr), err.Error())))
		return false, nil
	}

	after := readInstalledKernelVersion()
	out.InstalledKernel = after
	return after != before && after != "none-installed-via-dpkg", nil
}

func applyMitigation(out *cvePatchResult) *Error {
	if err := applyGrubMitigation(out); err != nil {
		return err
	}
	if err := applyModprobeBlacklist(out); err != nil {
		return err
	}
	return nil
}

func applyGrubMitigation(out *cvePatchResult) *Error {
	if _, err := os.Stat(grubbyBin); err == nil {
		_, stderr, runErr := runCVECmd(grubbyBin, "--update-kernel=ALL", "--args="+grubMitigationToken)
		out.ActionsTaken = append(out.ActionsTaken,
			fmt.Sprintf(`grubby --update-kernel=ALL --args="%s"`, grubMitigationToken))
		if runErr != nil {
			return &Error{Code: "grubby_failed", Message: firstNonEmpty(string(stderr), runErr.Error())}
		}
		return nil
	}

	// /etc/default/grub path: append the token if not already there,
	// then run update-grub. Read-modify-write is atomic via tmpfile
	// rename so a crash mid-write can't leave a half-edited grub.
	if _, err := os.Stat(grubDefaultPath); err != nil {
		// No grub config and no grubby — bootloader-side mitigation
		// isn't possible here. Modprobe blacklist is still meaningful
		// (it stops on-demand load), so don't fail.
		out.ActionsTaken = append(out.ActionsTaken,
			fmt.Sprintf("# %s not present and no grubby; skipping bootloader mitigation", grubDefaultPath))
		return nil
	}

	body, err := os.ReadFile(grubDefaultPath)
	if err != nil {
		return &Error{Code: "grub_read_failed", Message: err.Error()}
	}
	if strings.Contains(string(body), grubMitigationToken) {
		out.ActionsTaken = append(out.ActionsTaken,
			fmt.Sprintf("# %s already contains %s", grubDefaultPath, grubMitigationToken))
		return nil
	}
	patched := appendGrubArg(string(body), grubMitigationToken)
	if patched == string(body) {
		out.ActionsTaken = append(out.ActionsTaken,
			fmt.Sprintf("# could not locate GRUB_CMDLINE_LINUX in %s; skipping", grubDefaultPath))
		return nil
	}
	if err := writeFileAtomic(grubDefaultPath, []byte(patched), 0o644); err != nil {
		return &Error{Code: "grub_write_failed", Message: err.Error()}
	}
	out.ActionsTaken = append(out.ActionsTaken,
		fmt.Sprintf(`sed -i 's|^GRUB_CMDLINE_LINUX="\(.*\)"|GRUB_CMDLINE_LINUX="\1 %s"|' %s`, grubMitigationToken, grubDefaultPath))

	if _, err := os.Stat(updateGrubBin); err == nil {
		_, stderr, runErr := runCVECmd(updateGrubBin)
		out.ActionsTaken = append(out.ActionsTaken, "update-grub")
		if runErr != nil {
			return &Error{Code: "update_grub_failed", Message: firstNonEmpty(string(stderr), runErr.Error())}
		}
	}
	return nil
}

// appendGrubArg appends arg inside the existing GRUB_CMDLINE_LINUX
// quotes. If the line isn't found, returns body unchanged so the
// caller can fall back to a no-op trace entry.
var grubCmdlineRe = regexp.MustCompile(`(?m)^GRUB_CMDLINE_LINUX="([^"]*)"`)

func appendGrubArg(body, arg string) string {
	return grubCmdlineRe.ReplaceAllStringFunc(body, func(match string) string {
		m := grubCmdlineRe.FindStringSubmatch(match)
		existing := m[1]
		if strings.Contains(existing, arg) {
			return match
		}
		joined := strings.TrimSpace(existing + " " + arg)
		return `GRUB_CMDLINE_LINUX="` + joined + `"`
	})
}

func applyModprobeBlacklist(out *cvePatchResult) *Error {
	if err := os.MkdirAll(filepath.Dir(cveBlacklistPath), 0o755); err != nil {
		return &Error{Code: "blacklist_write_failed", Message: err.Error()}
	}
	if err := writeFileAtomic(cveBlacklistPath, []byte(modprobeBlacklistBody), 0o644); err != nil {
		return &Error{Code: "blacklist_write_failed", Message: err.Error()}
	}
	out.ActionsTaken = append(out.ActionsTaken,
		fmt.Sprintf("install -m0644 /dev/stdin %s  # contents: %q", cveBlacklistPath, strings.TrimSpace(modprobeBlacklistBody)))

	if _, err := os.Stat(modprobeBin); err == nil {
		// modprobe -r returns non-zero when the module isn't loaded;
		// that's expected in most cases and not an error. We record
		// the attempt either way.
		_, _, runErr := runCVECmd(modprobeBin, "-r", "algif_aead")
		if runErr != nil {
			out.ActionsTaken = append(out.ActionsTaken, "modprobe -r algif_aead || true")
		} else {
			out.ActionsTaken = append(out.ActionsTaken, "modprobe -r algif_aead")
		}
	}
	return nil
}

// =============================================================
// Inbox YAML
// =============================================================

func writeInbox(r *cvePatchResult) *Error {
	if err := os.MkdirAll(cveInboxDir, 0o755); err != nil {
		return &Error{Code: "inbox_mkdir_failed", Message: err.Error()}
	}
	path := filepath.Join(cveInboxDir, cveInboxFilename)

	first := cveNow().Format(time.RFC3339)
	last := first
	if existing, err := os.ReadFile(path); err == nil {
		if seen := extractFirstSeen(string(existing)); seen != "" {
			first = seen
		}
	}

	body := buildInboxYAML(r, first, last)
	if err := writeFileAtomic(path, []byte(body), 0o644); err != nil {
		return &Error{Code: "inbox_write_failed", Message: err.Error()}
	}
	r.InboxPath = path
	return nil
}

var firstSeenRe = regexp.MustCompile(`(?m)^\s*first_seen:\s*([^\s#]+)`)

func extractFirstSeen(body string) string {
	if m := firstSeenRe.FindStringSubmatch(body); m != nil {
		return strings.TrimSpace(m[1])
	}
	return ""
}

func buildInboxYAML(r *cvePatchResult, firstSeen, lastUpdated string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "cve: %s\n", cveID)
	fmt.Fprintf(&b, "name: %s\n", cveName)
	fmt.Fprintf(&b, "disclosed: %s\n", cveDisclosed)
	fmt.Fprintf(&b, "cvss: %.1f\n", cveCVSS)
	fmt.Fprintf(&b, "impact: %s\n", cveImpact)
	fmt.Fprintf(&b, "blast_radius: %s\n", cveBlastRadius)
	fmt.Fprintf(&b, "sources:\n  - %s\n  - %s\n", cveSourcePrimary, cveSourceTracker)
	fmt.Fprintf(&b, "affects:\n  package: linux-image-*\n  fixed_source_version_trixie: %s\n", fixedTrixieSourceVer)
	fmt.Fprintf(&b, "host: %s\n", yamlScalar(r.Host))
	fmt.Fprintf(&b, "running_kernel: %s\n", yamlScalar(r.RunningKernel))
	fmt.Fprintf(&b, "installed_kernel: %s\n", yamlScalar(r.InstalledKernel))
	fmt.Fprintf(&b, "state:\n")
	fmt.Fprintf(&b, "  status: %s\n", r.Status)
	fmt.Fprintf(&b, "  first_seen: %s\n", firstSeen)
	fmt.Fprintf(&b, "  last_updated: %s\n", lastUpdated)
	fmt.Fprintf(&b, "  classification: %s\n", r.Classification)
	fmt.Fprintf(&b, "  aead_bind_reachable: %t\n", r.AEADBindReachable)
	if r.AEADBindError != "" {
		fmt.Fprintf(&b, "  aead_bind_error: %s\n", yamlScalar(r.AEADBindError))
	}
	fmt.Fprintf(&b, "  ipsec_esn_in_use: %t\n", r.IPsecESNInUse)
	fmt.Fprintf(&b, "  openssl_afalg_enabled: %t\n", r.OpenSSLAFAlgEnabled)
	if r.BlockedReason != "" {
		fmt.Fprintf(&b, "  blocked_reason: %s\n", yamlScalar(r.BlockedReason))
	}
	if len(r.ActionsTaken) == 0 {
		fmt.Fprintf(&b, "  actions_taken: []\n")
	} else {
		fmt.Fprintf(&b, "  actions_taken:\n")
		for _, a := range r.ActionsTaken {
			fmt.Fprintf(&b, "    - %s\n", yamlScalar(a))
		}
	}
	fmt.Fprintf(&b, "  operator_action_required: %s\n", r.OperatorActionRequired)
	return b.String()
}

// yamlScalar returns a YAML-safe representation of s. Anything with
// a metacharacter, leading whitespace, or that resembles a YAML
// boolean/number is double-quoted with backslash-escapes.
func yamlScalar(s string) string {
	if s == "" {
		return `""`
	}
	if strings.ContainsAny(s, ":#&*?{}[],!|>'\"%@`\n\t") || strings.HasPrefix(s, " ") || strings.HasSuffix(s, " ") {
		return strconv.Quote(s)
	}
	switch strings.ToLower(s) {
	case "true", "false", "yes", "no", "null", "~", "on", "off":
		return strconv.Quote(s)
	}
	return s
}

// =============================================================
// helpers
// =============================================================

func runCVECmd(bin string, args ...string) (stdout, stderr []byte, err error) {
	cmd := exec.Command(bin, args...)
	var outBuf, errBuf strings.Builder
	cmd.Stdout = &writerFromBuilder{b: &outBuf}
	cmd.Stderr = &writerFromBuilder{b: &errBuf}
	err = cmd.Run()
	return []byte(outBuf.String()), []byte(errBuf.String()), err
}

type writerFromBuilder struct{ b *strings.Builder }

func (w *writerFromBuilder) Write(p []byte) (int, error) { return w.b.Write(p) }

func writeFileAtomic(path string, body []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".cve-tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := func() { os.Remove(tmpPath) }
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	return os.Rename(tmpPath, path)
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if t := strings.TrimSpace(s); t != "" {
			return t
		}
	}
	return ""
}
