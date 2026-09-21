package migrate

import (
	"errors"
	"strings"
	"testing"
)

// The prompts Incus 6.0.4 printed during the live run, in order. The old
// positional answer script fed the trust token into the authentication menu
// here and the migration died on "illegal base64 data" (LEARNINGS 183), so
// this walks the real transcript through the matcher.
func TestAnswerRulesAgainstIncus604Transcript(t *testing.T) {
	rules, err := compileAnswerRules([]AnswerRule{
		{Label: "server URL", When: "provide (the )?(Incus|LXD) server URL", Send: "https://10.0.0.1:8443"},
		{Label: "accept the certificate", When: `ok \(y/n\)`, Send: "y"},
		{Label: "authentication mechanism", When: "pick an authentication mechanism", Send: "1"},
		{Label: "trust token", When: "provide the certificate token", Send: "TOKEN", Secret: true},
		{Label: "container or virtual machine", When: `container \(1\) or (a )?virtual[- ]machine \(2\)`, Send: "1"},
		{Label: "instance name", When: "name of the (new )?instance", Send: "pp-x"},
		{Label: "root filesystem path", When: "path to (a|the) root ?(filesystem|fs)", Send: "{{ROOTFS}}"},
		{Label: "source disk", When: "path to a disk, partition, or image file", Send: "/dev/sda"},
		{Label: "additional mounts", When: "add additional (filesystem )?(mounts|mount points)", Send: "no"},
		{Label: "begin the migration", When: "pick one of the options above", Send: "1", Max: 2},
	}, func(v string) string {
		if v == "{{ROOTFS}}" {
			return "/"
		}
		return v
	})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	transcript := []struct{ partial, label, send string }{
		{"Please provide Incus server URL: ", "server URL", "https://10.0.0.1:8443"},
		{"ok (y/n)? ", "accept the certificate", "y"},
		{"Please pick an authentication mechanism above: ", "authentication mechanism", "1"},
		{"Please provide the certificate token: ", "trust token", "TOKEN"},
		{"Would you like to create a container (1) or virtual-machine (2)?: ", "container or virtual machine", "1"},
		{"Name of the new instance: ", "instance name", "pp-x"},
		{"Please provide the path to a root filesystem: ", "root filesystem path", "/"},
		{"Do you want to add additional filesystem mounts? [default=no]: ", "additional mounts", "no"},
		{"Please pick one of the options above [default=1]: ", "begin the migration", "1"},
	}
	for _, step := range transcript {
		got := matchAnswerRule(rules, step.partial)
		if got == nil {
			t.Fatalf("%q matched no rule", step.partial)
		}
		if got.label != step.label || got.send != step.send {
			t.Fatalf("%q → %s/%q, want %s/%q", step.partial, got.label, got.send, step.label, step.send)
		}
	}

	// Ordinary output is not a prompt.
	for _, line := range []string{
		"1) Use a certificate token",
		"Instance to be created:",
		"Transferring instance: 42.13MiB (14.02MiB/s)",
		"",
		"   ",
	} {
		if r := matchAnswerRule(rules, line); r != nil {
			t.Fatalf("%q should not be answered, matched %s", line, r.label)
		}
	}
}

// A prompt incus-migrate keeps re-asking (because it rejected the answer) must
// stop being answered: a loop here would hang the migration instead of
// failing it with the prompt in the log.
func TestAnswerRuleStopsRepeating(t *testing.T) {
	rules, err := compileAnswerRules([]AnswerRule{
		{Label: "token", When: "certificate token", Send: "nope", Max: 2},
	}, func(v string) string { return v })
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	for i := 0; i < 2; i++ {
		if matchAnswerRule(rules, "Please provide the certificate token: ") == nil {
			t.Fatalf("answer %d should have fired", i+1)
		}
	}
	if r := matchAnswerRule(rules, "Please provide the certificate token: "); r != nil {
		t.Fatal("the third ask must go unanswered so the run fails with the prompt")
	}
}

func TestCompileAnswerRulesRejectsBadPattern(t *testing.T) {
	if _, err := compileAnswerRules([]AnswerRule{{When: "([", Send: "x"}}, func(v string) string { return v }); err == nil {
		t.Fatal("a pattern that does not compile must be an error, not a silent skip")
	}
	rules, err := compileAnswerRules([]AnswerRule{{When: "  ", Send: "x"}}, func(v string) string { return v })
	if err != nil || len(rules) != 0 {
		t.Fatalf("an empty pattern is dropped: %v %d", err, len(rules))
	}
}

func TestFallbackTransport(t *testing.T) {
	// A container target arrives as a rootfs tarball when the tool is missing.
	j := &Job{Transport: "incus-migrate"}
	j.Target.Type = "container"
	got, err := fallbackTransport(j)
	if err != nil || got != "rootfs-tar" {
		t.Fatalf("container: got %q, %v", got, err)
	}
	// A VM cannot: the answer is to install the tool, and the message says so.
	v := &Job{Transport: "incus-migrate"}
	v.Target.Type = "virtual-machine"
	if _, err := fallbackTransport(v); err == nil || !errors.Is(err, ErrNoMigrateTool) || !strings.Contains(err.Error(), "incus-extra") {
		t.Fatalf("vm: expected the install hint, got %v", err)
	}
	// Only the incus-migrate transport has a fallback at all.
	if _, err := fallbackTransport(&Job{Transport: "rootfs-tar"}); err == nil {
		t.Fatal("rootfs-tar has nothing to fall back to")
	}
}
