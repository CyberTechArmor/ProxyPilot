package migrate

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// How this source compresses what it streams to ProxyPilot.
//
// The server asks for one (job.compression) because it is the side that has
// to decompress, but the SOURCE is the side that has to be able to produce
// it: a 2014 CentOS box with GNU tar 1.26 and no zstd package is exactly the
// machine an operator is trying to get off. So the request is a preference
// and this file is the reality check — we probe what tar here can actually
// do, once, and fall back to gzip, which every tar has had for thirty years.
//
// Why it matters: gzip is single-threaded at roughly 50 MB/s. On a LAN or a
// fast uplink it, not the network, is what makes a migration take hours.
// `zstd -T0 -3` saturates every core the source has at a similar ratio.

type tarCompressor struct {
	// Args are the flags that go before -cf on the tar command line.
	Args []string
	// Label is what we tell the operator and the server.
	Label string
}

var (
	compressOnce sync.Once
	compressPick tarCompressor
)

// tarCompression picks the best compressor this source can actually run,
// bounded by what the server asked for. The probe is a real tar invocation
// over an empty file list, so a tar that merely prints a nicer error is not
// mistaken for one that works.
func tarCompression(requested string) tarCompressor {
	compressOnce.Do(func() { compressPick = probeTarCompression(requested) })
	return compressPick
}

func probeTarCompression(requested string) tarCompressor {
	switch strings.ToLower(strings.TrimSpace(requested)) {
	case "none":
		return tarCompressor{Args: nil, Label: "none"}
	case "gzip":
		return tarCompressor{Args: []string{"-z"}, Label: "gzip"}
	}
	// zstd, or an unset/unknown request, which means "the best you have".
	if _, err := exec.LookPath("zstd"); err == nil {
		// -T0 is one thread per core and -3 is zstd's default level: the
		// point here is throughput, not the last few percent of ratio.
		// --use-compress-program with ARGUMENTS needs GNU tar >= 1.29.
		if tarAccepts([]string{"-I", "zstd -T0 -3"}) {
			return tarCompressor{Args: []string{"-I", "zstd -T0 -3"}, Label: "zstd"}
		}
		// GNU tar >= 1.31 knows --zstd, but calls it single-threaded.
		if tarAccepts([]string{"--zstd"}) {
			return tarCompressor{Args: []string{"--zstd"}, Label: "zstd"}
		}
	}
	// No zstd: pigz is gzip on every core, and a source that has it (it is
	// common on build boxes) gets most of the win without a new package.
	if _, err := exec.LookPath("pigz"); err == nil && tarAccepts([]string{"-I", "pigz"}) {
		return tarCompressor{Args: []string{"-I", "pigz"}, Label: "pigz"}
	}
	return tarCompressor{Args: []string{"-z"}, Label: "gzip"}
}

/* ------------------------------ installing ------------------------------ */

// ZstdInstall is what would install zstd on this source: the package
// manager found and the argv to run, or nil when none is known. Pure apart
// from the lookups, so the choice is testable.
type ZstdInstall struct {
	Manager string
	Argv    [][]string // run in order; a later command retries after the earlier ones
}

func zstdInstallPlan(has func(string) bool) *ZstdInstall {
	switch {
	case has("apt-get"):
		// Try the install first — the package lists are usually there. An
		// update is a network round trip to the mirrors and only needed when
		// they are stale or absent, so it is the retry, not the first move.
		return &ZstdInstall{Manager: "apt-get", Argv: [][]string{
			{"apt-get", "install", "-y", "-q", "--no-install-recommends", "zstd"},
			{"apt-get", "update", "-q"},
			{"apt-get", "install", "-y", "-q", "--no-install-recommends", "zstd"},
		}}
	case has("dnf"):
		return &ZstdInstall{Manager: "dnf", Argv: [][]string{{"dnf", "install", "-y", "-q", "zstd"}}}
	case has("yum"):
		return &ZstdInstall{Manager: "yum", Argv: [][]string{{"yum", "install", "-y", "-q", "zstd"}}}
	case has("apk"):
		return &ZstdInstall{Manager: "apk", Argv: [][]string{{"apk", "add", "--no-progress", "zstd"}}}
	case has("zypper"):
		return &ZstdInstall{Manager: "zypper", Argv: [][]string{{"zypper", "--non-interactive", "--quiet", "install", "zstd"}}}
	case has("pacman"):
		return &ZstdInstall{Manager: "pacman", Argv: [][]string{{"pacman", "-S", "--noconfirm", "--needed", "zstd"}}}
	}
	return nil
}

// EnsureZstd installs zstd on the source when the server asked for zstd and
// the source has none — the one package that turns a five-hour gzip copy of
// a big disk into a sub-hour one, because zstd -T0 uses every core and gzip
// uses one. It runs only when the job says install_tools (the operator's
// spec, default on) and only after the transfer is approved: the inventory
// changes nothing on a machine it is merely reading. Failure is a log line
// and the gzip fallback, never a failed migration — the copy still works,
// it is just slow, and the log says exactly why.
func (a *Agent) EnsureZstd(job *Job) {
	want := strings.ToLower(strings.TrimSpace(job.Compression))
	if want == "none" || want == "gzip" || !job.InstallTools {
		return
	}
	if _, err := exec.LookPath("zstd"); err == nil {
		return
	}
	plan := zstdInstallPlan(func(bin string) bool { _, err := exec.LookPath(bin); return err == nil })
	if plan == nil {
		a.client.Log("zstd is not installed on this source and no package manager was recognised — compressing with gzip on one core (install zstd by hand for a faster transfer)")
		return
	}
	a.client.Log("zstd is not installed on this source — installing it with %s so the transfer compresses on every core", plan.Manager)
	var lastOut string
	for _, argv := range plan.Argv {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
		cmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive", "LC_ALL=C")
		out, err := cmd.CombinedOutput()
		cancel()
		lastOut = tailStr(string(out), 300)
		if _, lookErr := exec.LookPath("zstd"); lookErr == nil {
			a.client.Log("zstd installed on the source (%s)", plan.Manager)
			return
		}
		if err == nil && argv[1] != "update" {
			// The package manager said yes but there is still no binary —
			// a wrong package name for this distribution. Stop guessing.
			break
		}
	}
	a.client.Log("could not install zstd with %s (%s) — compressing with gzip on one core instead", plan.Manager, lastOut)
}

// tarAccepts runs tar for real over an empty member list. Cheap, and it
// catches the tar that knows the flag but cannot find the helper binary.
func tarAccepts(args []string) bool {
	argv := append(append([]string{}, args...), "-cf", osDevNull, "-T", osDevNull)
	return exec.Command("tar", argv...).Run() == nil
}

const osDevNull = "/dev/null"

// tarCreateArgs is the front of every `tar -c` this agent runs.
func tarCreateArgs(c tarCompressor) []string {
	return append(append([]string{}, c.Args...), "-cf", "-")
}

// streamCompressor picks the compressor for a byte stream that is NOT a tar
// — the mysqldump. Same preference order, same fallback, but it returns an
// argv because the caller wires the processes together itself.
func streamCompressor(requested string) streamComp {
	switch strings.ToLower(strings.TrimSpace(requested)) {
	case "none":
		return streamComp{Argv: nil, Label: "none"}
	case "gzip":
		return gzipStream()
	}
	if _, err := exec.LookPath("zstd"); err == nil {
		return streamComp{Argv: []string{"zstd", "-T0", "-3"}, Label: "zstd"}
	}
	return gzipStream()
}

func gzipStream() streamComp {
	if _, err := exec.LookPath("gzip"); err != nil {
		// No compressor at all: send it raw rather than fail the migration
		// over a missing package. The server reads whatever arrives.
		return streamComp{Argv: nil, Label: "none"}
	}
	// -1 rather than the default 6: a SQL dump is highly compressible, so
	// the fast level gets most of the win at a fraction of the CPU.
	return streamComp{Argv: []string{"gzip", "-1"}, Label: "gzip"}
}

type streamComp struct {
	Argv  []string
	Label string
}
