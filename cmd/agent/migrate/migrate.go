package migrate

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Agent is one migration run on one source host.
//
// Shape of a run:
//
//	claim → inventory → (wait for the operator to approve) → transfer →
//	finish → remove itself
//
// It talks to exactly two places: the ProxyPilot API (TLS-pinned, one
// single-use token) and, in whole-machine mode, the Incus endpoint
// ProxyPilot named. It never phones anywhere else, and it writes nothing to
// the source outside /tmp.
type Agent struct {
	client *Client
	keep   bool
	selfIn string
}

// Run is the `proxypilot-agent migrate …` entry point.
func Run(argv []string) error {
	fs := flag.NewFlagSet("migrate", flag.ContinueOnError)
	url := fs.String("url", "", "ProxyPilot base URL (https://…)")
	token := fs.String("token", "", "the single-use migration token")
	pin := fs.String("pin", "", "sha256:<hex> of ProxyPilot's TLS certificate (TLS is pinned to it)")
	keep := fs.Bool("keep", false, "leave this binary on the source when the migration ends")
	once := fs.Bool("inventory-only", false, "collect and send the inventory, then exit (a dry run for the operator)")
	printOnly := fs.Bool("print", false, "print the inventory as JSON and exit — sends nothing, needs no token")
	if err := fs.Parse(argv); err != nil {
		return err
	}

	if *printOnly {
		m := NewCollector(nil).Collect()
		return writeJSON(os.Stdout, m)
	}
	if *token == "" || *url == "" {
		return errors.New("migrate needs --url and --token (the bootstrap script supplies both)")
	}
	if os.Geteuid() != 0 {
		return errors.New("the migration agent must run as root: it reads unit files, /etc, the connection table and the rootfs")
	}

	runID := newRunID()
	c, err := NewClient(*url, *token, *pin, runID)
	if err != nil {
		return err
	}
	self, _ := os.Executable()
	a := &Agent{client: c, keep: *keep, selfIn: self}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		_ = c.Send(Event{Kind: "error", Message: "the agent was interrupted on the source (Ctrl-C or a signal) — nothing further was copied"})
		a.cleanup()
		os.Exit(130)
	}()

	err = a.run(*once)
	a.cleanup()
	return err
}

func (a *Agent) run(inventoryOnly bool) error {
	job, err := a.client.Job()
	if err != nil {
		return fmt.Errorf("could not reach ProxyPilot: %w", err)
	}
	if job.Cancelled {
		return errors.New("this migration was cancelled in ProxyPilot")
	}
	a.client.Log("agent %s connected (migration %d, %s / %s)", Version, job.MigrationID, job.Mode, job.Transport)

	if job.Collect {
		_ = a.client.Send(Event{Kind: "phase", Phase: "inventory", Message: "reading the source"})
		m := NewCollector(a.client.Log).Collect()
		a.client.Log("inventory: %s, %d units, %d listening ports, %d vhosts, %d env files (names only), %d outbound hosts",
			m.OS.Pretty, len(m.Units), len(m.Listening), len(m.Vhosts), len(m.EnvFiles), len(m.Outbound))
		if err := a.client.SendInventory(m); err != nil {
			return a.client.Fail(fmt.Errorf("the inventory was refused: %w", err))
		}
	}
	if inventoryOnly {
		a.client.Log("--inventory-only: stopping here. Nothing was copied.")
		return nil
	}

	job, err = a.waitForApproval()
	if err != nil {
		return err
	}

	_ = a.client.Send(Event{Kind: "phase", Phase: "transfer", Message: "starting the transfer"})
	var moved int64
	switch job.Transport {
	case "incus-migrate":
		moved, err = a.RunIncusMigrate(job)
	case "rootfs-tar":
		moved, err = a.RunRootfsTar(job)
	case "rsync":
		moved, err = a.RunRsync(job)
	default:
		err = fmt.Errorf("unknown transport %q", job.Transport)
	}
	if err != nil {
		return a.client.Fail(err)
	}

	a.client.Log("transfer finished: %s moved", human(moved))
	if err := a.client.Finish(moved, fmt.Sprintf("%s transfer complete (%s)", job.Transport, human(moved))); err != nil {
		return fmt.Errorf("the transfer finished but ProxyPilot could not be told: %w", err)
	}
	return nil
}

// waitForApproval polls until the operator approves (or cancels). The wait
// is the point: nothing is copied off a production machine until a person
// has read what the inventory found.
func (a *Agent) waitForApproval() (*Job, error) {
	announced := false
	for {
		job, err := a.client.Job()
		if err != nil {
			// A transient network failure during a wait is not a reason to
			// abandon a migration someone is about to approve.
			a.client.Log("could not read the job (%v) — retrying", err)
			time.Sleep(15 * time.Second)
			continue
		}
		if job.Cancelled {
			return nil, errors.New("this migration was cancelled in ProxyPilot")
		}
		if job.Error != "" {
			return nil, errors.New(job.Error)
		}
		if job.Approved {
			return job, nil
		}
		if !announced {
			announced = true
			a.client.Log("waiting: the operator must review the inventory and approve the transfer in ProxyPilot")
		}
		time.Sleep(time.Duration(pick(job.PollSeconds, 10)) * time.Second)
	}
}

// cleanup removes the binary from the source unless asked to stay. A
// migration tool that leaves a root-capable binary behind on a machine it
// just copied is a liability, so removing itself is the default.
func (a *Agent) cleanup() {
	if a.keep || a.selfIn == "" {
		if a.keep {
			a.client.Log("--keep: leaving %s on the source", a.selfIn)
		}
		return
	}
	if err := os.Remove(a.selfIn); err == nil {
		a.client.Log("removed %s from the source", a.selfIn)
	}
}

func newRunID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("run-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func writeJSON(w *os.File, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
