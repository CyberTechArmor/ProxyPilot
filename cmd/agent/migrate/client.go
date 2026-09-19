package migrate

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client talks to exactly one ProxyPilot, for exactly one migration.
//
// TLS is PINNED to the certificate fingerprint the bootstrap script carried:
// the token is the source host's credential, and a credential must never be
// presented to a server we have not identified. Pinning is not belt and
// braces here — the agent runs as root on a machine that is about to be
// copied, and a mis-delivered token is a copy of that machine.
type Client struct {
	BaseURL string
	Token   string
	RunID   string
	http    *http.Client
}

// NewClient builds the pinned client. An empty pin falls back to the system
// trust store (an http:// ProxyPilot on a lab network has no certificate to
// pin); anything else is a hard verification failure, never a warning.
func NewClient(baseURL, token, pin, runID string) (*Client, error) {
	base := strings.TrimRight(baseURL, "/")
	if base == "" {
		return nil, errors.New("--url is required")
	}
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          8,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   20 * time.Second,
		ResponseHeaderTimeout: 120 * time.Second,
		ExpectContinueTimeout: 5 * time.Second,
	}
	if want := normalizePin(pin); want != "" {
		tr.TLSClientConfig = &tls.Config{
			// The certificate is verified BY FINGERPRINT below. Chain
			// verification is off because a pinned certificate needs no CA —
			// and a self-signed ProxyPilot on a private network is a normal
			// deployment, not a downgrade.
			InsecureSkipVerify: true, //nolint:gosec // pinned in VerifyPeerCertificate
			MinVersion:         tls.VersionTLS12,
			VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
				if len(rawCerts) == 0 {
					return errors.New("tls: the server presented no certificate")
				}
				sum := sha256.Sum256(rawCerts[0])
				got := hex.EncodeToString(sum[:])
				if got != want {
					return fmt.Errorf("tls: REFUSED — the server's certificate is %s, the migration token was issued for %s", got[:16]+"…", want[:16]+"…")
				}
				return nil
			},
		}
	}
	return &Client{BaseURL: base, Token: token, RunID: runID, http: &http.Client{Transport: tr, Timeout: 0}}, nil
}

func normalizePin(pin string) string {
	p := strings.ToLower(strings.TrimSpace(pin))
	p = strings.TrimPrefix(p, "sha256:")
	if len(p) != 64 {
		return ""
	}
	for _, c := range p {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return ""
		}
	}
	return p
}

func (c *Client) url(suffix string) string {
	return fmt.Sprintf("%s/api/migrations/agent/%s%s", c.BaseURL, c.Token, suffix)
}

func (c *Client) do(method, suffix string, body io.Reader, contentType string, timeout time.Duration) ([]byte, error) {
	req, err := http.NewRequest(method, c.url(suffix), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Migration-Run", c.RunID)
	req.Header.Set("User-Agent", "proxypilot-migrate/"+Version)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	cl := c.http
	if timeout > 0 {
		cp := *c.http
		cp.Timeout = timeout
		cl = &cp
	}
	resp, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= 400 {
		return out, fmt.Errorf("%s %s: %s: %s", method, suffix, resp.Status, strings.TrimSpace(firstLine(string(out))))
	}
	return out, nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	if len(s) > 400 {
		return s[:400]
	}
	return s
}

// Job is the server's instruction document, polled until it says go.
type Job struct {
	MigrationID int    `json:"migration_id"`
	Status      string `json:"status"`
	Phase       string `json:"phase"`
	Mode        string `json:"mode"`
	Transport   string `json:"transport"`
	Approved    bool   `json:"approved"`
	Cancelled   bool   `json:"cancelled"`
	Collect     bool   `json:"collect_inventory"`
	KeepAgent   bool   `json:"keep_agent"`
	PollSeconds int    `json:"poll_seconds"`
	Error       string `json:"error"`
	Target      struct {
		Name     string  `json:"name"`
		Type     string  `json:"type"`
		Pool     string  `json:"pool"`
		Network  string  `json:"network"`
		CPU      int     `json:"cpu"`
		MemoryGB float64 `json:"memory_gb"`
		DiskGB   int     `json:"disk_gb"`
		Nested   bool    `json:"nested"`
	} `json:"target"`
	App *struct {
		Dirs        []string `json:"dirs"`
		Excludes    []string `json:"excludes"`
		Database    string   `json:"database"`
		ServiceName string   `json:"service_name"`
	} `json:"app"`
	Incus *struct {
		URL         string `json:"url"`
		Token       string `json:"token"`
		Fingerprint string `json:"fingerprint"`
		Answers     struct {
			Lines []string `json:"lines"`
		} `json:"answers"`
	} `json:"incus"`
	Artifact *struct {
		ChunkBytes int      `json:"chunk_bytes"`
		Exclude    []string `json:"exclude"`
	} `json:"artifact"`
	Rsync *struct {
		Host     string   `json:"host"`
		User     string   `json:"user"`
		Port     int      `json:"port"`
		Dirs     []string `json:"dirs"`
		Excludes []string `json:"excludes"`
		Database string   `json:"database"`
	} `json:"rsync"`
}

// Job fetches the current instruction document.
func (c *Client) Job() (*Job, error) {
	out, err := c.do(http.MethodGet, "/job", nil, "", 60*time.Second)
	if err != nil {
		return nil, err
	}
	var j Job
	if err := json.Unmarshal(out, &j); err != nil {
		return nil, fmt.Errorf("job: %w", err)
	}
	return &j, nil
}

// SendInventory posts the manifest. A refusal here is final: the server
// refuses a manifest that carries a secret value, and the right response is
// to stop, not to retry with something else.
func (c *Client) SendInventory(m *Manifest) error {
	buf, err := json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = c.do(http.MethodPost, "/inventory", bytes.NewReader(buf), "application/json", 120*time.Second)
	return err
}

// Event is one progress/log/error line.
type Event struct {
	Kind       string `json:"kind,omitempty"`
	Phase      string `json:"phase,omitempty"`
	Bytes      int64  `json:"bytes,omitempty"`
	TotalBytes int64  `json:"total_bytes,omitempty"`
	Message    string `json:"message,omitempty"`
}

// Send posts one event. Progress reporting must never take the migration
// down, so a failed send is returned but callers log and continue.
func (c *Client) Send(e Event) error {
	buf, err := json.Marshal(e)
	if err != nil {
		return err
	}
	_, err = c.do(http.MethodPost, "/event", bytes.NewReader(buf), "application/json", 30*time.Second)
	return err
}

// Log is Send for a plain line, with the error swallowed.
func (c *Client) Log(format string, args ...any) {
	_ = c.Send(Event{Kind: "log", Message: fmt.Sprintf(format, args...)})
}

// Fail reports a terminal error, then returns it so the caller can stop.
func (c *Client) Fail(err error) error {
	_ = c.Send(Event{Kind: "error", Message: err.Error()})
	_, _ = c.do(http.MethodPost, "/finish", strings.NewReader(`{"ok":false,"message":`+jsonString(err.Error())+`}`), "application/json", 60*time.Second)
	return err
}

// Finish reports success and the byte count.
func (c *Client) Finish(bytesMoved int64, message string) error {
	body := fmt.Sprintf(`{"ok":true,"bytes":%d,"message":%s}`, bytesMoved, jsonString(message))
	_, err := c.do(http.MethodPost, "/finish", strings.NewReader(body), "application/json", 30*time.Minute)
	return err
}

// UploadArtifact streams the rootfs tarball, reporting progress as it goes.
func (c *Client) UploadArtifact(r io.Reader, sha string, onProgress func(int64)) error {
	pr := &progressReader{r: r, onProgress: onProgress}
	req, err := http.NewRequest(http.MethodPut, c.url("/artifact"), pr)
	if err != nil {
		return err
	}
	req.Header.Set("X-Migration-Run", c.RunID)
	req.Header.Set("Content-Type", "application/octet-stream")
	if sha != "" {
		req.Header.Set("X-Content-SHA256", sha)
	}
	cp := *c.http
	cp.Timeout = 0 // a multi-hundred-GB rootfs takes as long as it takes
	resp, err := cp.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return fmt.Errorf("artifact upload: %s: %s", resp.Status, strings.TrimSpace(firstLine(string(out))))
	}
	return nil
}

type progressReader struct {
	r          io.Reader
	n          int64
	last       time.Time
	onProgress func(int64)
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.n += int64(n)
	if p.onProgress != nil && time.Since(p.last) > 5*time.Second {
		p.last = time.Now()
		p.onProgress(p.n)
	}
	return n, err
}

func jsonString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}
