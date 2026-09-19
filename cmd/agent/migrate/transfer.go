package migrate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The three transports, one per line of the brief:
//
//   incus-migrate   wrap the official tool. ProxyPilot supplies the target
//                   definition and a one-time trust token; we feed the
//                   answers it asks for and stream its output back.
//   rootfs-tar      for a Proxmox LXC, where incus-migrate cannot run inside
//                   the guest: tar the rootfs and PUT it to ProxyPilot,
//                   which turns it into an image and a guest.
//   rsync           application mode: the directories, then a logical
//                   database dump restored inside the new guest.

/* ----------------------------- incus-migrate ---------------------------- */

var migrateProgressRe = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB)`)

// RunIncusMigrate drives the official incus-migrate non-interactively.
//
// The tool is a prompt loop and its prompt ORDER has changed between
// releases, so the answer script comes from the server (job.incus.answers)
// rather than being compiled in: adapting to a new incus-migrate is a
// server-side edit, not a re-roll of every agent on every source host.
func (a *Agent) RunIncusMigrate(job *Job) (int64, error) {
	bin, err := exec.LookPath("incus-migrate")
	if err != nil {
		if p, err2 := exec.LookPath("lxd-migrate"); err2 == nil {
			bin = p
			a.client.Log("incus-migrate is not installed; using lxd-migrate, which speaks the same protocol")
		} else {
			return 0, errors.New("neither incus-migrate nor lxd-migrate is installed on this source. Install it (Debian/Ubuntu: `apt install incus-extra`; the Zabbly packages call it `incus-tools`), or re-create the migration with transport: rootfs-tar")
		}
	}
	if job.Incus == nil || job.Incus.URL == "" || job.Incus.Token == "" {
		return 0, errors.New("the server did not supply an Incus endpoint and trust token")
	}

	root := a.rootDevice(job)
	subst := func(v string) string {
		v = strings.ReplaceAll(v, "{{ROOT_DEVICE}}", root)
		v = strings.ReplaceAll(v, "{{ROOTFS}}", "/")
		// The server writes a placeholder path for the source disk because
		// only the source knows what its own disk is called.
		if v == "/dev/sda" && root != "" {
			v = root
		}
		return v
	}

	rules, err := compileAnswerRules(job.Incus.Answers.Rules, subst)
	if err != nil {
		return 0, err
	}
	// An older server sends only the positional lines. Feeding them blind is
	// what broke against 6.0.4, so say so rather than pretending.
	blind := make([]string, 0, len(job.Incus.Answers.Lines))
	if len(rules) == 0 {
		for _, l := range job.Incus.Answers.Lines {
			blind = append(blind, subst(l))
		}
		a.client.Log("this ProxyPilot sent no prompt rules, only a positional answer script — feeding it in order")
	}

	a.client.Log("running %s → %s as %s (%s)", filepath.Base(bin), job.Incus.URL, job.Target.Name, job.Target.Type)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, bin)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return 0, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("%s would not start: %w", bin, err)
	}

	if len(rules) == 0 {
		go func() {
			defer stdin.Close()
			for _, line := range blind {
				// A prompt loop reads a line at a time; a burst of lines with
				// no pause is fine for a pipe but makes a mis-ordered answer
				// impossible to see in the log, so pace them.
				fmt.Fprintln(stdin, line)
				time.Sleep(150 * time.Millisecond)
			}
		}()
	} else {
		defer stdin.Close()
	}

	// Read BYTES, not lines: a prompt is a partial line with no newline, so a
	// line scanner never sees it until the answer has already been missed.
	chunks := make(chan []byte, 32)
	go func() {
		buf := make([]byte, 8192)
		defer close(chunks)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				c := make([]byte, n)
				copy(c, buf[:n])
				chunks <- c
			}
			if err != nil {
				return
			}
		}
	}()

	var (
		lastBytes int64
		pending   strings.Builder
		unmatched string
		lastMove  = time.Now()
	)
	emit := func(line string) {
		line = strings.TrimSpace(line)
		if line == "" {
			return
		}
		if b := parseMigrateBytes(line); b > lastBytes {
			lastBytes = b
			_ = a.client.Send(Event{Kind: "progress", Phase: "transfer", Bytes: b, Message: line})
			return
		}
		a.client.Log("%s", line)
	}
	answer := func(r *answerRule) error {
		shown := r.send
		if r.secret {
			shown = "(secret)"
		}
		a.client.Log("answered %q → %s", strings.TrimSpace(r.label), shown)
		if _, err := fmt.Fprintln(stdin, r.send); err != nil {
			return fmt.Errorf("could not answer %s: %w", r.label, err)
		}
		return nil
	}

	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	var loopErr error

readLoop:
	for {
		select {
		case c, ok := <-chunks:
			if !ok {
				break readLoop
			}
			lastMove = time.Now()
			for _, b := range string(c) {
				if b == '\n' || b == '\r' {
					emit(pending.String())
					pending.Reset()
					continue
				}
				pending.WriteRune(b)
			}
			if len(rules) == 0 {
				continue
			}
			if r := matchAnswerRule(rules, pending.String()); r != nil {
				emit(pending.String())
				pending.Reset()
				if err := answer(r); err != nil {
					loopErr = err
					cancel()
					break readLoop
				}
			}
		case <-tick.C:
			// A prompt nothing answers is a version difference, and the useful
			// thing to report is the prompt itself — not a hang.
			if len(rules) > 0 && strings.TrimSpace(pending.String()) != "" && time.Since(lastMove) > 45*time.Second {
				unmatched = strings.TrimSpace(pending.String())
				cancel()
				break readLoop
			}
		}
	}

	waitErr := cmd.Wait()
	if s := strings.TrimSpace(pending.String()); s != "" && unmatched == "" {
		emit(s)
	}
	switch {
	case unmatched != "":
		return lastBytes, fmt.Errorf("%s asked something this ProxyPilot has no answer for: %q — the answer rules need a line for it (lib/migration/service.js, migrateAnswers)", filepath.Base(bin), unmatched)
	case loopErr != nil:
		return lastBytes, loopErr
	case waitErr != nil:
		return lastBytes, fmt.Errorf("%s failed: %w — the lines above are its own output", filepath.Base(bin), waitErr)
	}
	return lastBytes, nil
}

// answerRule is a compiled AnswerRule plus how many times it has fired.
type answerRule struct {
	re     *regexp.Regexp
	send   string
	label  string
	secret bool
	max    int
	fired  int
}

func compileAnswerRules(in []AnswerRule, subst func(string) string) ([]*answerRule, error) {
	out := make([]*answerRule, 0, len(in))
	for _, r := range in {
		if strings.TrimSpace(r.When) == "" {
			continue
		}
		re, err := regexp.Compile("(?i)" + r.When)
		if err != nil {
			return nil, fmt.Errorf("the server sent an answer rule this agent cannot compile (%q): %w", r.When, err)
		}
		label := r.Label
		if label == "" {
			label = r.When
		}
		max := r.Max
		if max <= 0 {
			max = 3
		}
		out = append(out, &answerRule{re: re, send: subst(r.Send), label: label, secret: r.Secret, max: max})
	}
	return out, nil
}

// matchAnswerRule returns the first rule whose pattern the partial line
// matches and which has not been answered too often. A rule that keeps
// matching means incus-migrate keeps rejecting the answer, and repeating it
// forever would hang the migration instead of failing it.
func matchAnswerRule(rules []*answerRule, partial string) *answerRule {
	p := strings.TrimSpace(partial)
	if p == "" {
		return nil
	}
	for _, r := range rules {
		if r.fired >= r.max || !r.re.MatchString(p) {
			continue
		}
		r.fired++
		return r
	}
	return nil
}

// rootDevice is the block device backing / — what incus-migrate asks for
// when migrating a VM or a physical host.
func (a *Agent) rootDevice(job *Job) string {
	if job.Target.Type != "virtual-machine" {
		return "/"
	}
	out, err := exec.Command("findmnt", "-n", "-o", "SOURCE", "/").Output()
	if err != nil {
		return "/dev/sda"
	}
	src := strings.TrimSpace(string(out))
	// /dev/sda1 → /dev/sda: a VM migration streams the whole disk, not one
	// partition, or the guest boots to a partition with no table in front.
	if m := regexp.MustCompile(`^(/dev/(?:sd[a-z]+|vd[a-z]+|nvme\d+n\d+))p?\d+$`).FindStringSubmatch(src); m != nil {
		return m[1]
	}
	return src
}

func parseMigrateBytes(line string) int64 {
	m := migrateProgressRe.FindStringSubmatch(line)
	if m == nil {
		return 0
	}
	v, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0
	}
	switch m[2] {
	case "KiB":
		v *= 1 << 10
	case "MiB":
		v *= 1 << 20
	case "GiB":
		v *= 1 << 30
	case "TiB":
		v *= 1 << 40
	}
	return int64(v)
}

/* ------------------------------- rootfs tar ----------------------------- */

// RunRootfsTar streams the rootfs to ProxyPilot as one tar.gz, hashing as it
// goes so the server can prove the bytes survived. Nothing is written to the
// source's disk: the tar is produced and consumed in the same pipe, because
// a Proxmox LXC rarely has room for a copy of itself.
func (a *Agent) RunRootfsTar(job *Job) (int64, error) {
	if _, err := exec.LookPath("tar"); err != nil {
		return 0, errors.New("tar is not installed on this source")
	}
	excludes := []string{"./proc/*", "./sys/*", "./dev/*", "./run/*", "./tmp/*", "./mnt/*", "./media/*", "./var/cache/apt/archives/*", "./var/tmp/*", "./lost+found", "./swap.img", "./swapfile"}
	if job.Artifact != nil && len(job.Artifact.Exclude) > 0 {
		excludes = job.Artifact.Exclude
	}
	args := []string{"-czf", "-", "-C", "/", "--numeric-owner", "--one-file-system", "--warning=no-file-ignored", "--warning=no-file-changed"}
	for _, e := range excludes {
		args = append(args, "--exclude="+e)
	}
	args = append(args, ".")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, "tar", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	a.client.Log("streaming the rootfs (excluding %d pseudo/scratch paths)", len(excludes))

	// The server verifies a sha256 it is told; we compute it over the same
	// stream we send, so a truncated upload cannot look complete.
	hash := sha256.New()
	tee := io.TeeReader(stdout, hash)
	counted := &countingReader{r: tee}
	uploadErr := a.client.UploadArtifact(counted, "rootfs", "", "", func(n int64) {
		_ = a.client.Send(Event{Kind: "progress", Phase: "transfer", Bytes: n, Message: fmt.Sprintf("rootfs: %s sent", human(n))})
	})
	waitErr := cmd.Wait()
	if uploadErr != nil {
		return counted.n, uploadErr
	}
	// tar exits 1 on "file changed as we read it", which is normal on a live
	// machine and is not a failure of the copy; exit 2 is a real error.
	if waitErr != nil {
		if ee := (&exec.ExitError{}); errors.As(waitErr, &ee) && ee.ExitCode() == 1 {
			a.client.Log("tar reported files that changed while being read (normal on a running machine): %s", tailStr(stderr.String(), 300))
		} else {
			return counted.n, fmt.Errorf("tar failed: %w: %s", waitErr, tailStr(stderr.String(), 300))
		}
	}
	a.client.Log("rootfs uploaded: %s, sha256 %s", human(counted.n), hex.EncodeToString(hash.Sum(nil))[:16]+"…")
	return counted.n, nil
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	c.n += int64(n)
	return n, err
}

/* ------------------------------- file sync ------------------------------- */

// RunFileSync copies the application directories and the database into the
// new guest — through ProxyPilot, not through the guest.
//
// The brief said rsync. rsync would need a reachable sshd and an authorized
// key inside the target guest: a package and an open port ProxyPilot would be
// ADDING to a guest that did not ask for either, when `incus exec` already
// reaches it from the host. So each directory is tarred and PUT to the same
// artifact endpoint the rootfs path uses, and ProxyPilot unpacks it into the
// guest. The final delta sync keeps its meaning: on the second pass the
// server sets `since`, and tar carries only what changed after it.
func (a *Agent) RunFileSync(job *Job) (int64, error) {
	if job.Sync == nil {
		return 0, errors.New("the server did not supply the directories to copy")
	}
	if _, err := exec.LookPath("tar"); err != nil {
		return 0, errors.New("tar is not installed on this source")
	}
	var total int64
	for _, dir := range job.Sync.Dirs {
		n, err := a.sendDirectory(dir, job.Sync.Excludes, job.Sync.Since)
		if err != nil {
			return total, err
		}
		total += n
	}
	if job.Sync.Database != "" && job.Sync.Database != "none" {
		n, err := a.sendDatabase(job.Sync.Database)
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

// sendDirectory tars one directory (absolute paths preserved) straight into
// the upload, so nothing is staged on a source that may be short of disk.
func (a *Agent) sendDirectory(dir string, excludes []string, since string) (int64, error) {
	// Tar from / with the path RELATIVE to /, so the member names are
	// `srv/myapp/…` and an extract with `-C /` in the guest puts the tree
	// back where it came from. Tarring from the parent would name the
	// members `myapp/…` and restore the app to /myapp.
	base := strings.TrimPrefix(strings.TrimRight(dir, "/"), "/")
	if base == "" {
		return 0, errors.New("refusing to copy / as an application directory")
	}
	args := []string{"-czf", "-", "-C", "/", "--warning=no-file-changed", "--warning=no-file-ignored"}
	for _, e := range excludes {
		args = append(args, "--exclude="+e)
	}
	if since != "" {
		// The delta pass. tar takes an ISO date directly; a source whose tar
		// refuses it fails loudly here rather than silently copying nothing.
		args = append(args, "--newer-mtime="+since)
	}
	args = append(args, base)

	cmd := exec.Command("tar", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	if since != "" {
		a.client.Log("delta pass: %s (only files changed since %s)", dir, since)
	} else {
		a.client.Log("copying %s", dir)
	}
	counted := &countingReader{r: stdout}
	upErr := a.client.UploadArtifact(counted, "dir", dir, "", func(n int64) {
		_ = a.client.Send(Event{Kind: "progress", Phase: "transfer", Bytes: n, Message: fmt.Sprintf("%s: %s sent", dir, human(n))})
	})
	waitErr := cmd.Wait()
	if upErr != nil {
		return counted.n, fmt.Errorf("uploading %s: %w", dir, upErr)
	}
	if waitErr != nil {
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) && ee.ExitCode() == 1 {
			a.client.Log("tar reported files that changed while being read (normal on a running app): %s", tailStr(stderr.String(), 200))
		} else {
			return counted.n, fmt.Errorf("tar of %s failed: %w: %s", dir, waitErr, tailStr(stderr.String(), 300))
		}
	}
	a.client.Log("%s copied (%s)", dir, human(counted.n))
	return counted.n, nil
}

// sendDatabase dumps logically and streams the dump to ProxyPilot, which
// restores it with the guest's own engine. The dump never lands on a disk at
// either end.
func (a *Agent) sendDatabase(engine string) (int64, error) {
	switch engine {
	case "postgres":
		dbs := a.postgresDatabases()
		if len(dbs) == 0 {
			return 0, errors.New("no PostgreSQL database was found to dump")
		}
		var total int64
		for _, db := range dbs {
			a.client.Log("dumping postgres database %s", db)
			n, err := a.streamToArtifact(
				exec.Command("su", "-s", "/bin/sh", "-c", shellJoin([]string{"pg_dump", "--format=custom", "--no-owner", "--no-acl", db}), "postgres"),
				"dbdump", "postgres:"+db)
			if err != nil {
				return total, fmt.Errorf("postgres %s: %w", db, err)
			}
			total += n
		}
		return total, nil
	case "mysql":
		a.client.Log("dumping every MySQL database")
		return a.streamToArtifact(exec.Command("mysqldump", "--single-transaction", "--routines", "--triggers", "--all-databases"), "dbdump", "mysql:all")
	case "sqlite":
		a.client.Log("sqlite travels with the application directory — nothing separate to dump")
		return 0, nil
	}
	return 0, fmt.Errorf("unknown database engine %q", engine)
}

func (a *Agent) streamToArtifact(cmd *exec.Cmd, kind, name string) (int64, error) {
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	counted := &countingReader{r: stdout}
	upErr := a.client.UploadArtifact(counted, kind, name, "", func(n int64) {
		_ = a.client.Send(Event{Kind: "progress", Phase: "transfer", Bytes: n, Message: fmt.Sprintf("%s: %s sent", name, human(n))})
	})
	waitErr := cmd.Wait()
	if upErr != nil {
		return counted.n, upErr
	}
	if waitErr != nil {
		return counted.n, fmt.Errorf("%w: %s", waitErr, tailStr(stderr.String(), 300))
	}
	return counted.n, nil
}

func (a *Agent) postgresDatabases() []string {
	out, err := exec.Command("su", "-s", "/bin/sh", "-c", "psql -At -c \"select datname from pg_database where not datistemplate and datname <> 'postgres'\"", "postgres").Output()
	if err != nil {
		return nil
	}
	dbs := []string{}
	for _, l := range strings.Split(string(out), "\n") {
		if s := strings.TrimSpace(l); s != "" {
			dbs = append(dbs, s)
		}
	}
	return dbs
}

/* -------------------------------- freezing ------------------------------ */

// FreezeSource stops (or makes read-only) the thing that takes writes on the
// source, so two copies never both accept traffic. The operator chooses;
// ProxyPilot never freezes a production server on its own.
func (a *Agent) FreezeSource(unit string, mode string) error {
	switch mode {
	case "stop":
		if unit == "" {
			return errors.New("no service was named to stop")
		}
		out, err := exec.Command("systemctl", "stop", unit).CombinedOutput()
		if err != nil {
			return fmt.Errorf("systemctl stop %s: %w: %s", unit, err, tailStr(string(out), 200))
		}
		a.client.Log("stopped %s on the source", unit)
		return nil
	case "none":
		return nil
	default:
		return fmt.Errorf("unknown freeze mode %q", mode)
	}
}

func pick(v, def int) int {
	if v > 0 {
		return v
	}
	return def
}

func tailStr(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func human(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
