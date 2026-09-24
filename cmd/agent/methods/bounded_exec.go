package methods

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

const maxCommandOutput = 2 * 1024 * 1024

var errOutputLimit = errors.New("command output limit exceeded")

// Keep draining after the cap so a child cannot block on a full pipe. Overflow
// cancels the process and is always an error, never a successful partial result.
type boundedOutput struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
	cancel   context.CancelFunc
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.limit - b.buffer.Len()
	if n > remaining {
		_, _ = b.buffer.Write(p[:remaining])
		b.overflow = true
		b.cancel()
	} else {
		_, _ = b.buffer.Write(p)
	}
	return n, nil
}

func runBounded(timeout time.Duration, binary string, args ...string) ([]byte, []byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	// Descendants retaining inherited pipes must not hang Wait after cancellation.
	cmd.WaitDelay = time.Second
	out := &boundedOutput{limit: maxCommandOutput, cancel: cancel}
	errout := &boundedOutput{limit: maxCommandOutput, cancel: cancel}
	cmd.Stdout, cmd.Stderr = out, errout
	err := cmd.Run()
	if out.overflow || errout.overflow {
		err = errOutputLimit
	} else if ctx.Err() != nil {
		err = ctx.Err()
	}
	return out.buffer.Bytes(), errout.buffer.Bytes(), err
}
