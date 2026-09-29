// Command a7-live-probe is the A7 host proof's WebRTC viewer. It opens one
// live relay on the A3 supervisor's backend socket (root peers only, exactly
// like the backend), connects to the Neko inside the proof VM through the TURN
// relay with relay candidates only, and reports what it measured as JSON lines
// on stdout: whether it connected, over which candidate types and transport,
// the video frames and frame rate it received, and (with -control) the input
// it sent before and after it was given control. It never prints the TURN
// credential, a token or anything from the page.
//
// With -control it waits, once connected, for one line "control" on stdin (the
// proof harness takes the attempt over for this viewer in between), then for
// Neko to name this session as the controller, then sends a fixed set of input
// events over Neko's data channel. Input it sends before that must not reach
// the browser: the runner's X input counter proves it.
//
// It streams over the UDP TURN URL only: pion gives a relay candidate gathered
// over TCP or TLS the TCP network type and pairs it only with TCP remotes, so it
// cannot reach Neko's UDP port that way (browsers relay UDP over a TCP or TLS
// TURN connection correctly). The TCP and TLS media path is proven with the
// dashboard's own client in Chromium (scripts/tests/a7_live_browser_e2e.mjs);
// on the host, -relay-check with -relay-transport tcp or tls proves those
// listeners: a verified certificate for the TURN name (TLS), the viewer's
// credential accepted, a UDP allocation, and the same peer scope.
package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/pion/transport/v4"
	"github.com/pion/transport/v4/stdnet"
	"github.com/pion/turn/v4"
	"github.com/pion/webrtc/v4"
)

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

type opened struct {
	Conn       string      `json:"conn"`
	ICEServers []iceServer `json:"ice_servers"`
	TTL        int         `json:"ttl_seconds"`
}

type line struct {
	OK     *bool           `json:"ok,omitempty"`
	Error  string          `json:"error,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Recv   *neko           `json:"recv,omitempty"`
	Closed string          `json:"closed,omitempty"`
}

type neko struct {
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

var (
	outMu sync.Mutex
	out   = json.NewEncoder(os.Stdout)
)

func emit(v map[string]any) {
	outMu.Lock()
	defer outMu.Unlock()
	_ = out.Encode(v)
}

func fail(code string, err error) {
	emit(map[string]any{"event": "error", "code": code, "detail": fmt.Sprint(err)})
	os.Exit(1)
}

// pickURL chooses the TURN URL of one transport from the supervisor's list.
func pickURL(urls []string, transportName string) (string, error) {
	for _, u := range urls {
		switch {
		case transportName == "tls" && strings.HasPrefix(u, "turns:"):
			return u, nil
		case transportName == "udp" && strings.HasPrefix(u, "turn:") && strings.HasSuffix(u, "transport=udp"):
			return u, nil
		case transportName == "tcp" && strings.HasPrefix(u, "turn:") && strings.HasSuffix(u, "transport=tcp"):
			return u, nil
		}
	}
	return "", fmt.Errorf("no %s TURN URL in %v", transportName, urls)
}

// hostOf is the TURN URL's host name ("turn:host:3478?transport=udp").
func hostOf(turnURL string) string {
	rest := turnURL[strings.Index(turnURL, ":")+1:]
	if i := strings.IndexAny(rest, ":?"); i >= 0 {
		rest = rest[:i]
	}
	return rest
}

// resolving sends the TURN host name to another address (a host that cannot
// reach its own public name), keeping the name for TLS verification.
type resolving struct {
	transport.Net
	name, address string
}

func (r resolving) swap(address string) string {
	host, port, err := net.SplitHostPort(address)
	if err == nil && host == r.name {
		return net.JoinHostPort(r.address, port)
	}
	return address
}

func (r resolving) ResolveUDPAddr(network, address string) (*net.UDPAddr, error) {
	return r.Net.ResolveUDPAddr(network, r.swap(address))
}

func (r resolving) ResolveTCPAddr(network, address string) (*net.TCPAddr, error) {
	return r.Net.ResolveTCPAddr(network, r.swap(address))
}

// Neko's data-channel input (server/internal/webrtc/payload at the pinned commit).
func frame(op byte, payload []byte) []byte {
	b := make([]byte, 3+len(payload))
	b[0] = op
	binary.BigEndian.PutUint16(b[1:3], uint16(len(payload)))
	copy(b[3:], payload)
	return b
}

func u32(v uint32) []byte { b := make([]byte, 4); binary.BigEndian.PutUint32(b, v); return b }

func move(x, y uint16) []byte {
	b := make([]byte, 4)
	binary.BigEndian.PutUint16(b[0:2], x)
	binary.BigEndian.PutUint16(b[2:4], y)
	return frame(0x01, b)
}

func scroll(dy int16) []byte {
	b := make([]byte, 5)
	binary.BigEndian.PutUint16(b[2:4], uint16(dy))
	return frame(0x02, b)
}

// checkRelay allocates on the TURN relay and asks for a permission to each
// peer: the relay must allow only the VM's Neko address (coturn answers 403
// Forbidden IP for every other peer).
//
// Over "tcp" or "tls" the control connection is a stream (TLS on 5349, the
// certificate verified for the TURN host name against the system roots, or
// against caFile when given); the allocation itself is UDP either way.
func checkRelay(turnURL, username, credential, address, transportName, caFile string, peers []string) {
	name := hostOf(turnURL)
	port := "3478"
	if transportName == "tls" {
		port = "5349"
	}
	server := net.JoinHostPort(name, port)
	dial := server
	if address != "" {
		dial = net.JoinHostPort(address, port)
	}
	var conn net.PacketConn
	tlsInfo := map[string]any(nil)
	switch transportName {
	case "udp":
		c, err := net.ListenPacket("udp4", "0.0.0.0:0")
		if err != nil {
			fail("NET", err)
		}
		conn = c
		server = dial
	case "tcp", "tls":
		var stream net.Conn
		var err error
		if transportName == "tcp" {
			stream, err = net.DialTimeout("tcp", dial, 10*time.Second)
		} else {
			config := &tls.Config{ServerName: name, MinVersion: tls.VersionTLS12}
			if caFile != "" {
				pem, readErr := os.ReadFile(caFile)
				if readErr != nil {
					fail("TLS_CA", readErr)
				}
				config.RootCAs = x509.NewCertPool()
				if !config.RootCAs.AppendCertsFromPEM(pem) {
					fail("TLS_CA", errors.New("no certificate in the CA file"))
				}
			}
			var tlsConn *tls.Conn
			tlsConn, err = tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", dial, config)
			if err == nil {
				leaf := tlsConn.ConnectionState().PeerCertificates[0]
				tlsInfo = map[string]any{"verified_name": name, "not_after": leaf.NotAfter.UTC().Format(time.RFC3339),
					"version": tls.VersionName(tlsConn.ConnectionState().Version)}
				stream = tlsConn
			} else {
				var unknown x509.UnknownAuthorityError
				var hostname x509.HostnameError
				if errors.As(err, &unknown) || errors.As(err, &hostname) {
					emit(map[string]any{"event": "relay_check", "transport": transportName, "allocated": false,
						"code": "TLS_UNVERIFIED", "detail": err.Error()})
					return
				}
			}
		}
		if err != nil {
			fail("TURN_CONNECT", err)
		}
		conn = turn.NewSTUNConn(stream)
		server = stream.RemoteAddr().String()
	default:
		fail("TRANSPORT_UNSUPPORTED", fmt.Errorf("relay transport %q", transportName))
	}
	defer conn.Close()
	client, err := turn.NewClient(&turn.ClientConfig{STUNServerAddr: server, TURNServerAddr: server, Conn: conn,
		Username: username, Password: credential})
	if err != nil {
		fail("TURN_CLIENT", err)
	}
	defer client.Close()
	if err := client.Listen(); err != nil {
		fail("TURN_LISTEN", err)
	}
	relay, err := client.Allocate()
	if err != nil {
		emit(map[string]any{"event": "relay_check", "transport": transportName, "tls": tlsInfo, "allocated": false,
			"detail": err.Error()})
		return
	}
	defer relay.Close()
	results := map[string]string{}
	for _, peer := range peers {
		addr, err := net.ResolveUDPAddr("udp4", strings.TrimSpace(peer))
		if err != nil {
			results[peer] = "invalid"
			continue
		}
		if _, err := relay.WriteTo([]byte{0}, addr); err != nil {
			results[peer] = "refused: " + err.Error()
		} else {
			results[peer] = "permitted"
		}
	}
	emit(map[string]any{"event": "relay_check", "transport": transportName, "tls": tlsInfo, "allocated": true,
		"peers": results})
}

func main() {
	socket := flag.String("socket", "/run/proxypilot-a3/supervisor.sock", "the supervisor's backend socket")
	runID := flag.String("run", "", "run id of the running attempt")
	attemptID := flag.String("attempt", "", "attempt id")
	fence := flag.Int("fence", 1, "attempt fence")
	seconds := flag.Int("seconds", 10, "how long to measure after connecting")
	transportName := flag.String("transport", "udp", "TURN transport (udp only; see the package comment)")
	turnAddress := flag.String("turn-address", "", "reach the TURN host name at this address instead (TLS still checks the name)")
	badCredential := flag.Bool("bad-credential", false, "use a wrong TURN credential (the connection must fail)")
	control := flag.Bool("control", false, "send input before and after a \"control\" line on stdin")
	keys := flag.Int("keys", 5, "with -control: key presses to send once in control")
	forceInput := flag.Bool("force-input", false, "with -control: send the input after the control line without waiting to be the controller (a second viewer's input must be ignored)")
	verbose := flag.Bool("verbose", false, "report each relayed signalling event (names and candidate types only)")
	relayCheck := flag.String("relay-check", "", "only allocate on the relay with this viewer's credential and try these peers (ip:port,...)")
	relayTransport := flag.String("relay-transport", "udp", "with -relay-check: the control connection, udp, tcp or tls")
	caFile := flag.String("tls-ca", "", "with -relay-transport tls: trust this CA file instead of the system roots (tests)")
	flag.Parse()

	conn, err := net.Dial("unix", *socket)
	if err != nil {
		fail("SOCKET_UNREACHABLE", err)
	}
	defer conn.Close()
	reader := bufio.NewReaderSize(conn, 1<<20)
	var writeMu sync.Mutex
	send := func(v any) {
		writeMu.Lock()
		defer writeMu.Unlock()
		b, _ := json.Marshal(v)
		_, _ = conn.Write(append(b, '\n'))
	}
	send(map[string]any{"method": "live", "params": map[string]any{"run_id": *runID, "attempt_id": *attemptID, "fence": *fence}})
	first, err := reader.ReadBytes('\n')
	if err != nil {
		fail("SUPERVISOR_PROTOCOL", err)
	}
	var head line
	if json.Unmarshal(first, &head) != nil || head.OK == nil {
		fail("SUPERVISOR_PROTOCOL", errors.New("first line"))
	}
	if !*head.OK {
		emit(map[string]any{"event": "refused", "code": head.Error})
		os.Exit(2)
	}
	var live opened
	if json.Unmarshal(head.Result, &live) != nil || len(live.ICEServers) != 1 {
		fail("SUPERVISOR_PROTOCOL", errors.New("result"))
	}
	if *transportName != "udp" && *relayCheck == "" {
		fail("TRANSPORT_UNSUPPORTED", errors.New("the probe streams over UDP TURN only"))
	}
	pick := *transportName
	if *relayCheck != "" {
		pick = *relayTransport
	}
	turnURL, err := pickURL(live.ICEServers[0].URLs, pick)
	if err != nil {
		fail("NO_TURN_URL", err)
	}
	credential := live.ICEServers[0].Credential
	if *badCredential {
		credential = strings.Repeat("A", 27) + "="
	}
	emit(map[string]any{"event": "opened", "conn": live.Conn, "turn_url": turnURL, "ttl_seconds": live.TTL,
		"username_expiry_and_viewer": strings.Contains(live.ICEServers[0].Username, ":"+live.Conn)})

	if *relayCheck != "" {
		checkRelay(turnURL, live.ICEServers[0].Username, credential, *turnAddress, *relayTransport, *caFile,
			strings.Split(*relayCheck, ","))
		send(map[string]any{"close": true})
		return
	}

	settings := webrtc.SettingEngine{}
	std, err := stdnet.NewNet()
	if err != nil {
		fail("NET", err)
	}
	if *turnAddress != "" {
		settings.SetNet(resolving{Net: std, name: hostOf(turnURL), address: *turnAddress})
	}
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers:         []webrtc.ICEServer{{URLs: []string{turnURL}, Username: live.ICEServers[0].Username, Credential: credential}},
		ICETransportPolicy: webrtc.ICETransportPolicyRelay,
	})
	if err != nil {
		fail("PEER", err)
	}
	defer pc.Close()

	var (
		mu                     sync.Mutex
		frames, packets, bytes int
		firstPacket            time.Time
		connectedAt            time.Time
		session                string
		host                   string
		channel                *webrtc.DataChannel
		channelOpen            = make(chan struct{})
		connected              = make(chan struct{})
		hostChanged            = make(chan struct{}, 8)
	)
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Kind() != webrtc.RTPCodecTypeVideo {
			return
		}
		emit(map[string]any{"event": "track", "codec": track.Codec().MimeType})
		for {
			p, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			mu.Lock()
			if firstPacket.IsZero() {
				firstPacket = time.Now()
			}
			packets++
			bytes += len(p.Payload)
			if p.Marker {
				frames++
			}
			mu.Unlock()
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnOpen(func() {
			mu.Lock()
			channel = dc
			mu.Unlock()
			close(channelOpen)
		})
	})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			send(map[string]any{"send": map[string]any{"event": "signal/candidate", "payload": c.ToJSON()}})
		}
	})
	var once sync.Once
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateConnected {
			once.Do(func() { connectedAt = time.Now(); close(connected) })
		}
	})

	// Relay lines from the supervisor. Neko may trickle a candidate before its
	// offer arrives; such candidates wait for the remote description.
	closed := make(chan string, 1)
	var early []webrtc.ICECandidateInit
	haveRemote := false
	go func() {
		for {
			raw, err := reader.ReadBytes('\n')
			if err != nil {
				closed <- "socket_closed"
				return
			}
			var l line
			if json.Unmarshal(raw, &l) != nil {
				continue
			}
			if l.Closed != "" {
				closed <- l.Closed
				return
			}
			if l.Recv == nil {
				continue
			}
			if *verbose {
				note := map[string]any{"event": "relay", "neko": l.Recv.Event}
				var p struct {
					SDP       string `json:"sdp"`
					Candidate string `json:"candidate"`
				}
				_ = json.Unmarshal(l.Recv.Payload, &p)
				if p.SDP != "" {
					note["sdp_candidates"] = strings.Count(p.SDP, "a=candidate:")
					note["ice_lite"] = strings.Contains(p.SDP, "a=ice-lite")
					var lines []string
					for _, c := range strings.Split(p.SDP, "\n") {
						if strings.HasPrefix(c, "a=candidate:") {
							lines = append(lines, strings.TrimSpace(c))
						}
					}
					note["candidates"] = lines
				}
				if p.Candidate != "" {
					note["candidate"] = p.Candidate
				}
				emit(note)
			}
			switch l.Recv.Event {
			case "system/init":
				var p struct {
					SessionID   string `json:"session_id"`
					ControlHost struct {
						HostID string `json:"host_id"`
					} `json:"control_host"`
				}
				_ = json.Unmarshal(l.Recv.Payload, &p)
				mu.Lock()
				session = p.SessionID
				mu.Unlock()
			case "signal/provide", "signal/offer", "signal/restart":
				var p struct {
					SDP string `json:"sdp"`
				}
				_ = json.Unmarshal(l.Recv.Payload, &p)
				if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: p.SDP}); err != nil {
					emit(map[string]any{"event": "error", "code": "REMOTE_DESCRIPTION", "detail": err.Error()})
					continue
				}
				haveRemote = true
				for _, c := range early {
					_ = pc.AddICECandidate(c)
				}
				early = nil
				answer, err := pc.CreateAnswer(nil)
				if err != nil {
					continue
				}
				_ = pc.SetLocalDescription(answer)
				send(map[string]any{"send": map[string]any{"event": "signal/answer", "payload": map[string]any{"sdp": answer.SDP}}})
			case "signal/candidate":
				var c webrtc.ICECandidateInit
				if json.Unmarshal(l.Recv.Payload, &c) == nil && c.Candidate != "" {
					if haveRemote {
						_ = pc.AddICECandidate(c)
					} else {
						early = append(early, c)
					}
				}
			case "control/host":
				var p struct {
					HasHost bool   `json:"has_host"`
					HostID  string `json:"host_id"`
				}
				_ = json.Unmarshal(l.Recv.Payload, &p)
				mu.Lock()
				host = ""
				if p.HasHost {
					host = p.HostID
				}
				mu.Unlock()
				hostChanged <- struct{}{}
			}
		}
	}()
	send(map[string]any{"send": map[string]any{"event": "signal/request", "payload": map[string]any{"video": map[string]any{}, "audio": map[string]any{"disabled": true}}}})

	started := time.Now()
	select {
	case <-connected:
	case reason := <-closed:
		emit(map[string]any{"event": "report", "connected": false, "closed": reason, "transport": *transportName})
		return
	case <-time.After(time.Duration(*seconds) * time.Second):
		emit(map[string]any{"event": "report", "connected": false, "closed": "timeout", "transport": *transportName})
		send(map[string]any{"close": true})
		return
	}
	pair := map[string]any{}
	if sctp := pc.SCTP(); sctp != nil {
		if p, err := sctp.Transport().ICETransport().GetSelectedCandidatePair(); err == nil && p != nil {
			pair = map[string]any{"local": p.Local.Typ.String(), "local_protocol": p.Local.Protocol.String(),
				"local_address": p.Local.Address, "remote": p.Remote.Typ.String(), "remote_port": p.Remote.Port}
		}
	}
	emit(map[string]any{"event": "connected", "after_ms": time.Since(started).Milliseconds(), "pair": pair})

	sent := map[string]int{}
	if *control {
		select {
		case <-channelOpen:
		case <-time.After(10 * time.Second):
			fail("NO_DATA_CHANNEL", errors.New("data channel did not open"))
		}
		mu.Lock()
		dc, me := channel, session
		mu.Unlock()
		// Before control: Neko must ignore these (the counter proves it).
		for i := 0; i < 2; i++ {
			_ = dc.Send(frame(0x03, u32(0x62)))
			_ = dc.Send(frame(0x04, u32(0x62)))
		}
		_ = dc.Send(move(640, 400))
		_ = dc.Send(frame(0x05, u32(1)))
		_ = dc.Send(frame(0x06, u32(1)))
		emit(map[string]any{"event": "ready_for_control", "session_known": me != ""})
		stdin := bufio.NewScanner(os.Stdin)
		for stdin.Scan() && strings.TrimSpace(stdin.Text()) != "control" {
		}
		deadline := time.After(15 * time.Second)
	wait:
		for !*forceInput {
			mu.Lock()
			mine := host != "" && host == session
			mu.Unlock()
			if mine {
				break wait
			}
			select {
			case <-hostChanged:
			case <-deadline:
				fail("NOT_GIVEN_CONTROL", errors.New("Neko did not name this session as controller"))
			}
		}
		time.Sleep(300 * time.Millisecond)
		for i := 0; i < *keys; i++ {
			_ = dc.Send(frame(0x03, u32(0x61)))
			_ = dc.Send(frame(0x04, u32(0x61)))
			time.Sleep(20 * time.Millisecond)
		}
		_ = dc.Send(move(640, 400))
		_ = dc.Send(frame(0x05, u32(1)))
		_ = dc.Send(frame(0x06, u32(1)))
		_ = dc.Send(scroll(1))
		_ = dc.Send(scroll(1))
		sent = map[string]int{"key": *keys, "click": 1, "scroll": 2}
		emit(map[string]any{"event": "input_sent", "sent": sent, "before_control": map[string]int{"key": 2, "click": 1}})
		time.Sleep(500 * time.Millisecond)
	}
	remaining := time.Duration(*seconds)*time.Second - time.Since(connectedAt)
	if remaining > 0 {
		select {
		case <-time.After(remaining):
		case <-closed:
		}
	}
	mu.Lock()
	window := time.Since(firstPacket).Seconds()
	report := map[string]any{"event": "report", "connected": true, "transport": *transportName, "pair": pair,
		"frames": frames, "packets": packets, "bytes": bytes, "seconds": window, "input_sent": sent}
	if window > 0 {
		report["fps"] = float64(frames) / window
	}
	mu.Unlock()
	emit(report)
	send(map[string]any{"close": true})
}
