package migrate

import (
	"os/exec"
	"strings"
	"testing"
)

func TestProbeTarCompressionHonoursAnExplicitRequest(t *testing.T) {
	if got := probeTarCompression("none"); got.Label != "none" || len(got.Args) != 0 {
		t.Fatalf("none: got %+v", got)
	}
	if got := probeTarCompression("gzip"); got.Label != "gzip" || strings.Join(got.Args, " ") != "-z" {
		t.Fatalf("gzip: got %+v", got)
	}
	// Case and whitespace come off the wire; they should not change the answer.
	if got := probeTarCompression("  GZIP "); got.Label != "gzip" {
		t.Fatalf("GZIP: got %+v", got)
	}
}

func TestProbeTarCompressionFallsBackToGzipWithoutZstd(t *testing.T) {
	got := probeTarCompression("zstd")
	if _, err := exec.LookPath("zstd"); err != nil {
		if got.Label != "gzip" {
			t.Fatalf("no zstd binary here, so the probe must answer gzip; got %+v", got)
		}
		return
	}
	// With zstd installed the probe must have chosen it AND produced flags
	// that this tar actually accepts — that is the whole point of probing.
	if got.Label != "zstd" {
		t.Fatalf("zstd is installed; got %+v", got)
	}
	if !tarAccepts(got.Args) {
		t.Fatalf("the probe returned flags tar rejects: %+v", got)
	}
}

func TestTarCreateArgsAlwaysEndsWithStdout(t *testing.T) {
	args := tarCreateArgs(tarCompressor{Args: []string{"-I", "zstd -T0 -3"}, Label: "zstd"})
	if strings.Join(args, " ") != "-I zstd -T0 -3 -cf -" {
		t.Fatalf("got %q", strings.Join(args, " "))
	}
	// An uncompressed tar is still a tar to stdout, not a tar to a file
	// called "-cf".
	if strings.Join(tarCreateArgs(tarCompressor{Label: "none"}), " ") != "-cf -" {
		t.Fatalf("none: got %q", tarCreateArgs(tarCompressor{Label: "none"}))
	}
}

func TestStreamCompressorNeverWrapsWhatItCannotRun(t *testing.T) {
	c := streamCompressor("none")
	if c.Label != "none" || c.Argv != nil {
		t.Fatalf("none: got %+v", c)
	}
	c = streamCompressor("")
	switch c.Label {
	case "zstd":
		if c.Argv[0] != "zstd" {
			t.Fatalf("zstd argv: %+v", c.Argv)
		}
	case "gzip":
		if c.Argv[0] != "gzip" {
			t.Fatalf("gzip argv: %+v", c.Argv)
		}
	case "none":
		if c.Argv != nil {
			t.Fatalf("none must carry no argv: %+v", c.Argv)
		}
	default:
		t.Fatalf("unexpected label %q", c.Label)
	}
	// Whatever it picked has to exist, or the dump pipeline dies on exec.
	if len(c.Argv) > 0 {
		if _, err := exec.LookPath(c.Argv[0]); err != nil {
			t.Fatalf("picked %q which is not on PATH", c.Argv[0])
		}
	}
}
