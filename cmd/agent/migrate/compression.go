package migrate

import (
	"os/exec"
	"strings"
	"sync"
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
	return tarCompressor{Args: []string{"-z"}, Label: "gzip"}
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
