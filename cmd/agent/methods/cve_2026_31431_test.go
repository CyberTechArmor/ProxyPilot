//go:build linux

package methods

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// writeShellStub creates a #!/bin/sh script under t.TempDir and
// returns its path. body is everything after the shebang.
func writeShellStub(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "stub")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	return path
}

// swap replaces *target with v for the duration of the test. Tests
// using swap must NOT call t.Parallel.
func swap[T any](t *testing.T, target *T, v T) {
	t.Helper()
	prev := *target
	*target = v
	t.Cleanup(func() { *target = prev })
}

// missingPath returns a path that doesn't exist (under a t.TempDir
// so cleanup is automatic).
func missingPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "does-not-exist")
}

// neutralizeShell points every binary the CVE handlers shell out to
// at a missing path under t.TempDir, so any branch we forget to stub
// behaves like "binary not present" rather than firing the real one.
func neutralizeShell(t *testing.T) {
	t.Helper()
	swap(t, &unameBin, missingPath(t))
	swap(t, &hostnameBin, missingPath(t))
	swap(t, &dpkgQueryBin, missingPath(t))
	swap(t, &dpkgBin, missingPath(t))
	swap(t, &aptGetBin, missingPath(t))
	swap(t, &grubbyBin, missingPath(t))
	swap(t, &updateGrubBin, missingPath(t))
	swap(t, &modprobeBin, missingPath(t))
	swap(t, &ipBin, missingPath(t))
	swap(t, &opensslCnfPath, missingPath(t))
	swap(t, &grubDefaultPath, missingPath(t))
	dir := t.TempDir()
	swap(t, &cveBlacklistPath, filepath.Join(dir, "modprobe.d", "blacklist.conf"))
	swap(t, &cveInboxDir, filepath.Join(dir, "cve-inbox"))
	swap(t, &cveNow, func() time.Time { return time.Date(2026, 5, 4, 23, 15, 55, 0, time.UTC) })
	swap(t, &algBindProbe, func() (bool, syscall.Errno) { return false, syscall.EAFNOSUPPORT })
}

// =============================================================
// Pure helpers
// =============================================================

func TestParseKernel(t *testing.T) {
	cases := []struct {
		in   string
		ok   bool
		want kernelTriple
	}{
		{"6.18.5", true, kernelTriple{6, 18, 5}},
		{"6.12.85-1-amd64", true, kernelTriple{6, 12, 85}},
		{"5.10.0", true, kernelTriple{5, 10, 0}},
		{"garbage", false, kernelTriple{}},
		{"", false, kernelTriple{}},
	}
	for _, c := range cases {
		got, ok := parseKernel(c.in)
		if ok != c.ok || got != c.want {
			t.Errorf("parseKernel(%q) = (%+v,%t); want (%+v,%t)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestKernelTripleLess(t *testing.T) {
	a := kernelTriple{6, 12, 85}
	cases := []struct {
		o    kernelTriple
		less bool
	}{
		{kernelTriple{6, 12, 84}, false},
		{kernelTriple{6, 12, 85}, false},
		{kernelTriple{6, 12, 86}, true},
		{kernelTriple{6, 13, 0}, true},
		{kernelTriple{7, 0, 0}, true},
		{kernelTriple{5, 99, 99}, false},
	}
	for _, c := range cases {
		if a.less(c.o) != c.less {
			t.Errorf("%+v.less(%+v) = %t, want %t", a, c.o, !c.less, c.less)
		}
	}
}

func TestAppendGrubArg(t *testing.T) {
	body := `GRUB_TIMEOUT=5
GRUB_CMDLINE_LINUX="console=ttyS0 quiet"
GRUB_CMDLINE_LINUX_DEFAULT="splash"
`
	got := appendGrubArg(body, grubMitigationToken)
	if !strings.Contains(got, `GRUB_CMDLINE_LINUX="console=ttyS0 quiet `+grubMitigationToken+`"`) {
		t.Errorf("expected token appended inside GRUB_CMDLINE_LINUX, got:\n%s", got)
	}
	if strings.Contains(got, `GRUB_CMDLINE_LINUX_DEFAULT="splash `+grubMitigationToken+`"`) {
		t.Errorf("must not touch GRUB_CMDLINE_LINUX_DEFAULT, got:\n%s", got)
	}

	// Idempotent: running twice doesn't double-append.
	twice := appendGrubArg(got, grubMitigationToken)
	if strings.Count(twice, grubMitigationToken) != 1 {
		t.Errorf("expected 1 occurrence after re-apply, got %d:\n%s",
			strings.Count(twice, grubMitigationToken), twice)
	}

	// No GRUB_CMDLINE_LINUX line: unchanged.
	bare := "GRUB_TIMEOUT=5\n"
	if appendGrubArg(bare, grubMitigationToken) != bare {
		t.Errorf("expected unchanged when line absent")
	}
}

func TestYamlScalarQuoting(t *testing.T) {
	cases := []struct{ in, want string }{
		{"vm", "vm"},
		{"6.18.5", "6.18.5"},
		{"", `""`},
		{"true", `"true"`},
		{"no", `"no"`},
		{"has: colon", `"has: colon"`},
		{"has #hash", `"has #hash"`},
		{" leading", `" leading"`},
		{"trailing ", `"trailing "`},
	}
	for _, c := range cases {
		if got := yamlScalar(c.in); got != c.want {
			t.Errorf("yamlScalar(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// =============================================================
// classify
// =============================================================

func TestClassify(t *testing.T) {
	cases := []struct {
		name          string
		bind          bool
		runningKernel string
		wantClass     string
	}{
		{"bind unreachable → resolved", false, "5.10.0", statusResolved},
		{"bind reachable + new kernel → resolved (fix in)", true, "6.12.85", statusResolved},
		{"bind reachable + newer major → resolved", true, "6.18.5", statusResolved},
		{"bind reachable + old kernel → vulnerable", true, "6.12.84", statusVulnerable},
		{"bind reachable + unparseable kernel → unknown", true, "wat", statusUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := &cveCheckResult{AEADBindReachable: c.bind, RunningKernel: c.runningKernel}
			if got := classify(r); got != c.wantClass {
				t.Errorf("classify = %q, want %q", got, c.wantClass)
			}
		})
	}
}

// =============================================================
// Detection — runCheck end-to-end
// =============================================================

func TestRunCheck_ResolvedOnPatchedKernel(t *testing.T) {
	neutralizeShell(t)
	swap(t, &unameBin, writeShellStub(t, `[ "$1" = "-r" ] && echo 6.18.5`))
	swap(t, &hostnameBin, writeShellStub(t, `echo testhost`))
	// dpkg-query exits 0 with no rows.
	swap(t, &dpkgQueryBin, writeShellStub(t, `exit 0`))

	r, err := runCheck()
	if err != nil {
		t.Fatalf("unexpected error: %+v", err)
	}
	if r.Classification != statusResolved {
		t.Errorf("classification = %q, want resolved", r.Classification)
	}
	if r.RunningKernel != "6.18.5" {
		t.Errorf("running_kernel = %q", r.RunningKernel)
	}
	if r.Host != "testhost" {
		t.Errorf("host = %q", r.Host)
	}
	if r.InstalledKernel != "none-installed-via-dpkg" {
		t.Errorf("installed_kernel = %q", r.InstalledKernel)
	}
	if r.BlockedReason != "" {
		t.Errorf("unexpected blocked_reason: %q", r.BlockedReason)
	}
}

func TestRunCheck_VulnerableOnOldKernelWithReachableBind(t *testing.T) {
	neutralizeShell(t)
	swap(t, &unameBin, writeShellStub(t, `[ "$1" = "-r" ] && echo 6.10.0`))
	swap(t, &hostnameBin, writeShellStub(t, `echo testhost`))
	swap(t, &algBindProbe, func() (bool, syscall.Errno) { return true, 0 })

	r, err := runCheck()
	if err != nil {
		t.Fatalf("unexpected error: %+v", err)
	}
	if r.Classification != statusVulnerable {
		t.Errorf("classification = %q, want vulnerable", r.Classification)
	}
	if !r.AEADBindReachable {
		t.Errorf("expected aead_bind_reachable=true")
	}
}

func TestRunCheck_BlockedByIPsecESN(t *testing.T) {
	neutralizeShell(t)
	swap(t, &unameBin, writeShellStub(t, `echo 6.18.5`))
	swap(t, &hostnameBin, writeShellStub(t, `echo testhost`))
	swap(t, &ipBin, writeShellStub(t, `cat <<EOF
src 10.0.0.1 dst 10.0.0.2
	proto esp spi 0x0001 reqid 1 mode tunnel
	flag esn
EOF
exit 0`))

	r, err := runCheck()
	if err != nil {
		t.Fatalf("unexpected error: %+v", err)
	}
	if !r.IPsecESNInUse {
		t.Errorf("expected ipsec_esn_in_use=true")
	}
	if !strings.Contains(r.BlockedReason, "IPsec ESN") {
		t.Errorf("expected ESN blocked reason, got %q", r.BlockedReason)
	}
}

func TestRunCheck_BlockedByOpenSSLAFAlg(t *testing.T) {
	neutralizeShell(t)
	cnf := filepath.Join(t.TempDir(), "openssl.cnf")
	if err := os.WriteFile(cnf, []byte("[engine_section]\nafalg = afalg_section\n"), 0o644); err != nil {
		t.Fatalf("write openssl.cnf: %v", err)
	}
	swap(t, &opensslCnfPath, cnf)
	swap(t, &unameBin, writeShellStub(t, `echo 6.18.5`))
	swap(t, &hostnameBin, writeShellStub(t, `echo testhost`))

	r, err := runCheck()
	if err != nil {
		t.Fatalf("unexpected error: %+v", err)
	}
	if !r.OpenSSLAFAlgEnabled {
		t.Errorf("expected openssl_afalg_enabled=true")
	}
	if !strings.Contains(r.BlockedReason, "OpenSSL afalg") {
		t.Errorf("expected afalg blocked reason, got %q", r.BlockedReason)
	}
}

func TestRunCheck_OpenSSLCommentedOutNotBlocking(t *testing.T) {
	neutralizeShell(t)
	cnf := filepath.Join(t.TempDir(), "openssl.cnf")
	body := "# afalg = afalg_section\n; afalg = legacy\n"
	if err := os.WriteFile(cnf, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	swap(t, &opensslCnfPath, cnf)
	swap(t, &unameBin, writeShellStub(t, `echo 6.18.5`))
	swap(t, &hostnameBin, writeShellStub(t, `echo h`))

	r, err := runCheck()
	if err != nil {
		t.Fatalf("unexpected error: %+v", err)
	}
	if r.OpenSSLAFAlgEnabled {
		t.Errorf("commented afalg lines must not count as enabled")
	}
}

// =============================================================
// Patch handler — full flows
// =============================================================

func TestPatch_ResolvedShortCircuits(t *testing.T) {
	neutralizeShell(t)
	swap(t, &unameBin, writeShellStub(t, `echo 6.18.5`))
	swap(t, &hostnameBin, writeShellStub(t, `echo h`))

	res, err := SecurityCVE202631431Patch(json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("unexpected envelope error: %+v", err)
	}
	r := res.(cvePatchResult)
	if r.Status != statusResolved {
		t.Errorf("status = %q, want resolved", r.Status)
	}
	if r.OperatorActionRequired != "none" {
		t.Errorf("operator_action_required = %q", r.OperatorActionRequired)
	}
	if len(r.ActionsTaken) != 0 {
		t.Errorf("expected no mutating actions on resolved host, got %v", r.ActionsTaken)
	}
	if _, statErr := os.Stat(r.InboxPath); statErr != nil {
		t.Errorf("inbox not written: %v", statErr)
	}
	body, _ := os.ReadFile(r.InboxPath)
	if !strings.Contains(string(body), "status: resolved") {
		t.Errorf("inbox missing status:resolved\n%s", body)
	}
	if !strings.Contains(string(body), "first_seen: 2026-05-04T23:15:55Z") {
		t.Errorf("inbox missing fixed first_seen\n%s", body)
	}
}

func TestPatch_BlockedByESNWithoutForce(t *testing.T) {
	neutralizeShell(t)
	swap(t, &unameBin, writeShellStub(t, `echo 6.18.5`))
	swap(t, &hostnameBin, writeShellStub(t, `echo h`))
	swap(t, &ipBin, writeShellStub(t, `echo "flag esn"`))

	res, err := SecurityCVE202631431Patch(json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("unexpected envelope error: %+v", err)
	}
	r := res.(cvePatchResult)
	if r.Status != statusBlocked {
		t.Errorf("status = %q, want blocked", r.Status)
	}
	if r.OperatorActionRequired != "confirm-esn-impact" {
		t.Errorf("operator_action_required = %q", r.OperatorActionRequired)
	}
	if len(r.ActionsTaken) != 0 {
		t.Errorf("expected zero actions when blocked, got %v", r.ActionsTaken)
	}
}

func TestPatch_AptUpgradeInstallsNewKernel(t *testing.T) {
	neutralizeShell(t)
	// AF_ALG reachable + old running kernel → vulnerable, so patch
	// path runs apt and the dpkg-query "after" returns a fixed kernel.
	swap(t, &algBindProbe, func() (bool, syscall.Errno) { return true, 0 })
	swap(t, &unameBin, writeShellStub(t, `echo 6.10.0`))
	swap(t, &hostnameBin, writeShellStub(t, `echo h`))

	// dpkg-query: first call (during runCheck) → old version; later
	// call (after apt install) → new version. Switch via counter file.
	counter := filepath.Join(t.TempDir(), "counter")
	swap(t, &dpkgQueryBin, writeShellStub(t, `
n=$(cat `+counter+` 2>/dev/null || echo 0)
echo $((n+1)) > `+counter+`
if [ "$n" = "0" ]; then
	printf 'linux-image-amd64\t6.10.0-1\tinstall ok installed\n'
else
	printf 'linux-image-amd64\t6.12.85-1\tinstall ok installed\n'
fi
exit 0`))
	swap(t, &dpkgBin, writeShellStub(t, `exit 0`))
	swap(t, &aptGetBin, writeShellStub(t, `exit 0`))

	res, err := SecurityCVE202631431Patch(json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("unexpected envelope error: %+v", err)
	}
	r := res.(cvePatchResult)
	if r.Status != statusPatchedPendingReboot {
		t.Errorf("status = %q, want patched-pending-reboot", r.Status)
	}
	if r.OperatorActionRequired != "reboot" {
		t.Errorf("operator_action_required = %q", r.OperatorActionRequired)
	}
	if !containsAny(r.ActionsTaken, "apt-get update") {
		t.Errorf("expected apt-get update in trace: %v", r.ActionsTaken)
	}
	if !containsAny(r.ActionsTaken, "apt-get install -y --only-upgrade 'linux-image-*'") {
		t.Errorf("expected apt-get install in trace: %v", r.ActionsTaken)
	}
	if r.InstalledKernel != "6.12.85-1" {
		t.Errorf("installed_kernel after upgrade = %q", r.InstalledKernel)
	}
}

func TestPatch_FallsBackToMitigationWhenNoUpgrade(t *testing.T) {
	neutralizeShell(t)
	swap(t, &algBindProbe, func() (bool, syscall.Errno) { return true, 0 })
	swap(t, &unameBin, writeShellStub(t, `echo 6.10.0`))
	swap(t, &hostnameBin, writeShellStub(t, `echo h`))

	// dpkg-query always returns the same version (apt no-op).
	swap(t, &dpkgQueryBin, writeShellStub(t,
		`printf 'linux-image-amd64\t6.10.0-1\tinstall ok installed\n'`))
	swap(t, &dpkgBin, writeShellStub(t, `exit 0`))
	swap(t, &aptGetBin, writeShellStub(t, `exit 0`))

	// Provide a /etc/default/grub for the mitigation to edit, and an
	// update-grub stub that records its invocation.
	grub := filepath.Join(t.TempDir(), "grub")
	if err := os.WriteFile(grub, []byte(`GRUB_CMDLINE_LINUX="console=ttyS0"`+"\n"), 0o644); err != nil {
		t.Fatalf("write grub: %v", err)
	}
	swap(t, &grubDefaultPath, grub)
	updateGrubMarker := filepath.Join(t.TempDir(), "update-grub-ran")
	swap(t, &updateGrubBin, writeShellStub(t, `touch `+updateGrubMarker))
	// modprobe -r exits non-zero (module not loaded) which we tolerate.
	swap(t, &modprobeBin, writeShellStub(t, `exit 1`))

	res, err := SecurityCVE202631431Patch(json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("unexpected envelope error: %+v", err)
	}
	r := res.(cvePatchResult)
	if r.Status != statusMitigatedPendingReboot {
		t.Errorf("status = %q, want mitigated-pending-reboot", r.Status)
	}
	if r.OperatorActionRequired != "reboot" {
		t.Errorf("operator_action_required = %q", r.OperatorActionRequired)
	}

	body, _ := os.ReadFile(grub)
	if !strings.Contains(string(body), grubMitigationToken) {
		t.Errorf("grub config missing %q after mitigation:\n%s", grubMitigationToken, body)
	}
	if _, err := os.Stat(updateGrubMarker); err != nil {
		t.Errorf("update-grub was not invoked")
	}
	if data, err := os.ReadFile(cveBlacklistPath); err != nil {
		t.Errorf("blacklist file not written: %v", err)
	} else if !strings.Contains(string(data), "install algif_aead /bin/false") {
		t.Errorf("blacklist body unexpected: %q", data)
	}
}

func TestPatch_PatchOnlySkipsMitigation(t *testing.T) {
	neutralizeShell(t)
	swap(t, &algBindProbe, func() (bool, syscall.Errno) { return true, 0 })
	swap(t, &unameBin, writeShellStub(t, `echo 6.10.0`))
	swap(t, &hostnameBin, writeShellStub(t, `echo h`))
	swap(t, &dpkgQueryBin, writeShellStub(t,
		`printf 'linux-image-amd64\t6.10.0-1\tinstall ok installed\n'`))
	swap(t, &dpkgBin, writeShellStub(t, `exit 0`))
	swap(t, &aptGetBin, writeShellStub(t, `exit 0`))

	res, err := SecurityCVE202631431Patch(json.RawMessage(`{"patch_only":true}`))
	if err != nil {
		t.Fatalf("unexpected envelope error: %+v", err)
	}
	r := res.(cvePatchResult)
	if r.Status != statusVulnerable {
		t.Errorf("status = %q, want vulnerable (patch_only)", r.Status)
	}
	if _, err := os.Stat(cveBlacklistPath); err == nil {
		t.Errorf("patch_only must not write modprobe blacklist")
	}
}

func TestPatch_MitigateOnlySkipsApt(t *testing.T) {
	neutralizeShell(t)
	swap(t, &algBindProbe, func() (bool, syscall.Errno) { return true, 0 })
	swap(t, &unameBin, writeShellStub(t, `echo 6.10.0`))
	swap(t, &hostnameBin, writeShellStub(t, `echo h`))
	aptCalled := filepath.Join(t.TempDir(), "apt-called")
	swap(t, &aptGetBin, writeShellStub(t, `touch `+aptCalled))

	grub := filepath.Join(t.TempDir(), "grub")
	_ = os.WriteFile(grub, []byte(`GRUB_CMDLINE_LINUX=""`+"\n"), 0o644)
	swap(t, &grubDefaultPath, grub)

	res, err := SecurityCVE202631431Patch(json.RawMessage(`{"mitigate_only":true}`))
	if err != nil {
		t.Fatalf("unexpected envelope error: %+v", err)
	}
	r := res.(cvePatchResult)
	if r.Status != statusMitigatedPendingReboot {
		t.Errorf("status = %q, want mitigated-pending-reboot", r.Status)
	}
	if _, err := os.Stat(aptCalled); err == nil {
		t.Errorf("mitigate_only must not invoke apt-get")
	}
}

func TestPatch_MitigateOnlyAndPatchOnlyMutuallyExclusive(t *testing.T) {
	neutralizeShell(t)
	_, err := SecurityCVE202631431Patch(json.RawMessage(`{"mitigate_only":true,"patch_only":true}`))
	if err == nil || err.Code != "invalid_params" {
		t.Errorf("expected invalid_params, got %+v", err)
	}
}

func TestPatch_GrubbyPreferredOverDefaultGrub(t *testing.T) {
	neutralizeShell(t)
	swap(t, &algBindProbe, func() (bool, syscall.Errno) { return true, 0 })
	swap(t, &unameBin, writeShellStub(t, `echo 6.10.0`))
	swap(t, &hostnameBin, writeShellStub(t, `echo h`))

	grubbyArgs := filepath.Join(t.TempDir(), "grubby-args")
	swap(t, &grubbyBin, writeShellStub(t, `echo "$@" > `+grubbyArgs))

	// /etc/default/grub also exists but must not be touched when
	// grubby is present.
	grub := filepath.Join(t.TempDir(), "grub")
	_ = os.WriteFile(grub, []byte(`GRUB_CMDLINE_LINUX="x"`+"\n"), 0o644)
	swap(t, &grubDefaultPath, grub)

	res, err := SecurityCVE202631431Patch(json.RawMessage(`{"mitigate_only":true}`))
	if err != nil {
		t.Fatalf("unexpected error: %+v", err)
	}
	r := res.(cvePatchResult)
	if r.Status != statusMitigatedPendingReboot {
		t.Errorf("status = %q", r.Status)
	}

	args, _ := os.ReadFile(grubbyArgs)
	if !strings.Contains(string(args), grubMitigationToken) {
		t.Errorf("grubby not invoked with mitigation arg, got %q", args)
	}
	body, _ := os.ReadFile(grub)
	if strings.Contains(string(body), grubMitigationToken) {
		t.Errorf("/etc/default/grub must not be modified when grubby is used")
	}
}

// =============================================================
// Inbox YAML
// =============================================================

func TestInbox_PreservesFirstSeenAcrossWrites(t *testing.T) {
	neutralizeShell(t)
	swap(t, &unameBin, writeShellStub(t, `echo 6.18.5`))
	swap(t, &hostnameBin, writeShellStub(t, `echo h`))

	// First write at T0.
	swap(t, &cveNow, func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) })
	res1, err := SecurityCVE202631431Patch(json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("first patch: %+v", err)
	}
	path := res1.(cvePatchResult).InboxPath

	// Second write at T1; first_seen should still be T0.
	swap(t, &cveNow, func() time.Time { return time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC) })
	if _, err := SecurityCVE202631431Patch(json.RawMessage(`{}`)); err != nil {
		t.Fatalf("second patch: %+v", err)
	}
	body, _ := os.ReadFile(path)
	if !strings.Contains(string(body), "first_seen: 2026-01-01T00:00:00Z") {
		t.Errorf("first_seen was not preserved across writes:\n%s", body)
	}
	if !strings.Contains(string(body), "last_updated: 2026-06-01T00:00:00Z") {
		t.Errorf("last_updated was not refreshed:\n%s", body)
	}
}

// =============================================================
// Registry wiring
// =============================================================

func TestDefaultRegistry_HasCVEMethods(t *testing.T) {
	r := DefaultRegistry()
	for _, m := range []string{"security.cve_2026_31431.check", "security.cve_2026_31431.patch"} {
		if _, ok := r.Lookup(m); !ok {
			t.Errorf("DefaultRegistry missing %q", m)
		}
	}
}

func containsAny(haystack []string, needle string) bool {
	for _, h := range haystack {
		if strings.Contains(h, needle) {
			return true
		}
	}
	return false
}
