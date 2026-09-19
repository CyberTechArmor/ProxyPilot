package migrate

import (
	"bufio"
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
			return 0, errors.New("neither incus-migrate nor lxd-migrate is installed on this source. Install the incus-tools package (Debian/Ubuntu: `apt install incus-tools`), or re-create the migration with transport: rootfs-tar")
		}
	}
	if job.Incus == nil || job.Incus.URL == "" || job.Incus.Token == "" {
		return 0, errors.New("the server did not supply an Incus endpoint and trust token")
	}

	answers := make([]string, len(job.Incus.Answers.Lines))
	copy(answers, job.Incus.Answers.Lines)
	root := a.rootDevice(job)
	for i, l := range answers {
		l = strings.ReplaceAll(l, "{{ROOT_DEVICE}}", root)
		l = strings.ReplaceAll(l, "{{ROOTFS}}", "/")
		// The server writes a placeholder path for the source disk because
		// only the source knows what its own disk is called.
		if l == "/dev/sda" && root != "" {
			l = root
		}
		answers[i] = l
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
	go func() {
		defer stdin.Close()
		for _, line := range answers {
			// A prompt loop reads a line at a time; a burst of lines with no
			// pause is fine for a pipe but makes a mis-ordered answer
			// impossible to see in the log, so pace them.
			fmt.Fprintln(stdin, line)
			time.Sleep(150 * time.Millisecond)
		}
	}()

	var lastBytes int64
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if b := parseMigrateBytes(line); b > lastBytes {
			lastBytes = b
			_ = a.client.Send(Event{Kind: "progress", Phase: "transfer", Bytes: b, Message: line})
			continue
		}
		a.client.Log("%s", line)
	}
	if err := cmd.Wait(); err != nil {
		return lastBytes, fmt.Errorf("%s failed: %w — the lines above are its own output", filepath.Base(bin), err)
	}
	return lastBytes, nil
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
	uploadErr := a.client.UploadArtifact(counted, "", func(n int64) {
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

/* --------------------------------- rsync -------------------------------- */

var rsyncTotalRe = regexp.MustCompile(`([\d,]+)\s+\d+%`)

// RunRsync copies the application directories into the new guest and then
// moves the database logically. The env VALUES are not touched: the
// operator types them into ProxyPilot, which is the whole point of carrying
// only key names in the manifest.
func (a *Agent) RunRsync(job *Job) (int64, error) {
	if job.Rsync == nil {
		return 0, errors.New("the server did not supply an rsync target")
	}
	if _, err := exec.LookPath("rsync"); err != nil {
		return 0, errors.New("rsync is not installed on this source (apt install rsync)")
	}
	var total int64
	ssh := fmt.Sprintf("ssh -p %d -o StrictHostKeyChecking=accept-new -o BatchMode=yes", pick(job.Rsync.Port, 22))
	for _, dir := range job.Rsync.Dirs {
		args := []string{"-aHAX", "--delete", "--numeric-ids", "--info=progress2", "-e", ssh}
		for _, ex := range job.Rsync.Excludes {
			args = append(args, "--exclude", ex)
		}
		// A trailing slash on the source copies the CONTENTS; without it
		// rsync nests the directory inside itself on a second run.
		args = append(args, strings.TrimRight(dir, "/")+"/", fmt.Sprintf("%s@%s:%s/", pickStr(job.Rsync.User, "root"), job.Rsync.Host, strings.TrimRight(dir, "/")))
		a.client.Log("rsync %s → %s:%s", dir, job.Rsync.Host, dir)
		n, err := a.streamCommand("rsync", args, func(line string) int64 {
			if m := rsyncTotalRe.FindStringSubmatch(line); m != nil {
				v, _ := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64)
				return v
			}
			return 0
		})
		if err != nil {
			return total, fmt.Errorf("rsync of %s failed: %w", dir, err)
		}
		total += n
	}
	if job.Rsync.Database != "" && job.Rsync.Database != "none" {
		n, err := a.moveDatabase(job)
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

// moveDatabase dumps on the source and restores inside the guest, over the
// same SSH channel — the dump never lands on either disk.
func (a *Agent) moveDatabase(job *Job) (int64, error) {
	host := fmt.Sprintf("%s@%s", pickStr(job.Rsync.User, "root"), job.Rsync.Host)
	sshArgs := []string{"-p", strconv.Itoa(pick(job.Rsync.Port, 22)), "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", host}
	switch job.Rsync.Database {
	case "postgres":
		dbs := a.postgresDatabases()
		if len(dbs) == 0 {
			return 0, errors.New("no PostgreSQL database was found to dump")
		}
		var total int64
		for _, db := range dbs {
			a.client.Log("dumping postgres database %s into the guest", db)
			n, err := a.pipeThroughSSH(
				exec.Command("su", "-s", "/bin/sh", "-c", shellJoin([]string{"pg_dump", "--format=custom", "--no-owner", "--no-acl", db}), "postgres"),
				append(sshArgs, shellJoin([]string{"sh", "-c", fmt.Sprintf("createdb -U postgres %s 2>/dev/null; pg_restore -U postgres --no-owner --no-acl -d %s", db, db)})),
			)
			if err != nil {
				return total, fmt.Errorf("postgres %s: %w", db, err)
			}
			total += n
		}
		return total, nil
	case "mysql":
		a.client.Log("dumping every MySQL database into the guest")
		return a.pipeThroughSSH(
			exec.Command("mysqldump", "--single-transaction", "--routines", "--triggers", "--all-databases"),
			append(sshArgs, "mysql"),
		)
	case "sqlite":
		a.client.Log("sqlite travels with the application directory — nothing separate to dump")
		return 0, nil
	}
	return 0, fmt.Errorf("unknown database engine %q", job.Rsync.Database)
}

// pipeThroughSSH runs `dump | ssh host restore` without a temporary file.
func (a *Agent) pipeThroughSSH(dump *exec.Cmd, sshArgs []string) (int64, error) {
	ssh := exec.Command("ssh", sshArgs...)
	pr, pw := io.Pipe()
	counted := &countingReader{r: pr}
	dump.Stdout = pw
	ssh.Stdin = counted
	var dumpErr, sshErr strings.Builder
	dump.Stderr = &dumpErr
	ssh.Stderr = &sshErr
	if err := ssh.Start(); err != nil {
		return 0, err
	}
	if err := dump.Start(); err != nil {
		_ = pw.CloseWithError(err)
		return 0, err
	}
	go func() {
		err := dump.Wait()
		_ = pw.CloseWithError(err)
	}()
	if err := ssh.Wait(); err != nil {
		return counted.n, fmt.Errorf("%w: %s%s", err, tailStr(dumpErr.String(), 200), tailStr(sshErr.String(), 200))
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

// streamCommand runs a command, forwards every line as a log event, and
// reports the largest byte count any line yielded.
func (a *Agent) streamCommand(name string, args []string, bytesOf func(string) int64) (int64, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	var max int64
	var lastSent time.Time
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	// rsync's progress2 rewrites one line with \r; split on both.
	sc.Split(scanLinesCR)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if b := bytesOf(line); b > 0 {
			if b > max {
				max = b
			}
			if time.Since(lastSent) > 5*time.Second {
				lastSent = time.Now()
				_ = a.client.Send(Event{Kind: "progress", Phase: "transfer", Bytes: max, Message: line})
			}
			continue
		}
		a.client.Log("%s", line)
	}
	return max, cmd.Wait()
}

func scanLinesCR(data []byte, atEOF bool) (int, []byte, error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	for i, b := range data {
		if b == '\n' || b == '\r' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
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

func pickStr(v, def string) string {
	if v != "" {
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
