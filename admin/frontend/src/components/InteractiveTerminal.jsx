import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

// InteractiveTerminal — xterm.js + WebSocket front-end for the
// streaming-terminal route. Mounts a Terminal into a sized container,
// dials the upgrade endpoint via cookie auth (browser sends pp_token
// automatically), and pipes stdin/stdout in both directions.
//
// Props:
//   wsPath     — path under the same origin, e.g. `/api/terminal/lxc/foo`
//                or `/api/terminal/host`. The component derives the
//                ws[s]:// URL from window.location.
//   initialCwd — optional absolute path. When set, the component appends
//                `?cwd=<encoded>` to wsPath; the backend uses node-pty's
//                `cwd` option (translating container→host paths for
//                host-kind PTYs) so bash starts directly in that
//                directory. Falsy/empty → no-op (PTY starts in HOME).
//
// Lifecycle:
//   - mount   : create Terminal, FitAddon, WebLinksAddon. Open ws.
//   - data    : term.onData → ws.send {type:'input',data}.
//   - resize  : ResizeObserver on the container → fit.fit() →
//               ws.send {type:'resize',cols,rows}.
//   - message : binary or string PTY output → term.write.
//   - close   : ws.close(), term.dispose(), observer.disconnect().
const InteractiveTerminal = forwardRef(function InteractiveTerminal({ wsPath, initialCwd }, ref) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const [status, setStatus] = useState('connecting');
  const [errorText, setErrorText] = useState('');
  // Bumping reconnectNonce re-runs the WebSocket-creation effect,
  // which tears down the dead socket + xterm and reopens. Letting
  // the effect own the lifecycle keeps the cleanup path
  // single-source-of-truth — no extra reconnect helper needed.
  const [reconnectNonce, setReconnectNonce] = useState(0);

  // Imperative handle: parent can call .sendInput(text) to push bytes
  // into the PTY (e.g. a "Run install script" button). Returns true
  // when the WebSocket is open and the data was queued.
  useImperativeHandle(ref, () => ({
    sendInput(text) {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || typeof text !== 'string') return false;
      try {
        ws.send(JSON.stringify({ type: 'input', data: text }));
        return true;
      } catch {
        return false;
      }
    },
    isConnected() {
      return wsRef.current?.readyState === WebSocket.OPEN;
    },
  }), []);

  useEffect(() => {
    if (!containerRef.current || !wsPath) return undefined;
    // Reset transient banner state at the top of each (re)connect so
    // the banner doesn't briefly show stale "WebSocket closed" text
    // when the operator clicks Reconnect.
    setStatus('connecting');
    setErrorText('');

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#0b0b0b',
        foreground: '#e5e7eb',
        cursor: '#22d3ee',
        selectionBackground: '#334155',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(containerRef.current);
    try { fit.fit(); } catch { /* container may not be sized yet */ }
    termRef.current = term;
    fitRef.current = fit;

    const wsBase = `${window.location.origin.replace(/^http/, 'ws')}${wsPath}`;
    const wsUrl = initialCwd
      ? `${wsBase}${wsPath.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(initialCwd)}`
      : wsBase;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    const sendResize = () => {
      if (!fit || !term || ws.readyState !== WebSocket.OPEN) return;
      try { fit.fit(); } catch { return; }
      const cols = term.cols;
      const rows = term.rows;
      // Skip a degenerate size: when the terminal is kept mounted but HIDDEN (a
      // tab switch — the session stays alive), the container measures 0×0 and a
      // fit would shrink the PTY to 1 row, wrecking a full-screen app like nano.
      // Ignore it; the refit fires again with the real size when it's shown.
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return;
      try {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      } catch { /* socket closing */ }
    };

    // Refit again after layout settles. On first open (and when returning to the
    // tab) the container's final height isn't known on the synchronous frame, so
    // the initial fit can undercount rows — which is why nano/vim would only use
    // part of the screen. Two rAFs + a short timeout capture the settled layout.
    let refitRaf1 = 0;
    let refitRaf2 = 0;
    let refitTimer = 0;
    const scheduleSettledRefit = () => {
      refitRaf1 = requestAnimationFrame(() => {
        refitRaf2 = requestAnimationFrame(sendResize);
      });
      refitTimer = setTimeout(sendResize, 250);
    };

    ws.onopen = () => {
      setStatus('connected');
      setErrorText('');
      sendResize();
      scheduleSettledRefit();
      term.focus();
    };

    ws.onmessage = (ev) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        term.write(new Uint8Array(data));
        return;
      }
      if (typeof data === 'string') {
        // Server may send `{type:'closed',reason:'idle'}` JSON envelopes
        // alongside raw bytes; surface the reason in the status banner
        // when we recognise one.
        if (data.length > 0 && data.charCodeAt(0) === 0x7b /* { */) {
          try {
            const msg = JSON.parse(data);
            if (msg && msg.type === 'closed') {
              setStatus(msg.reason === 'idle' ? 'idle-closed' : 'closed');
              setErrorText(msg.reason || '');
              return;
            }
          } catch { /* fall through and write as text */ }
        }
        term.write(data);
      }
    };

    ws.onerror = () => {
      setStatus('error');
      setErrorText('WebSocket error');
    };

    ws.onclose = (ev) => {
      setStatus((s) => (s === 'idle-closed' ? s : 'closed'));
      if (ev && ev.code !== 1000 && ev.code !== 1005) {
        // 4xx / 5xx mapped onto WS close codes by the server's
        // rejectUpgrade() reach the client as 1006 with no reason.
        // Surface what we have.
        setErrorText((t) => t || ev.reason || `WebSocket closed (code ${ev.code})`);
      }
    };

    const onDataDisp = term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'input', data }));
      } catch { /* socket closing */ }
    });

    let resizeRaf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(sendResize);
    });
    ro.observe(containerRef.current);

    return () => {
      try { ro.disconnect(); } catch { /* ignore */ }
      cancelAnimationFrame(resizeRaf);
      cancelAnimationFrame(refitRaf1);
      cancelAnimationFrame(refitRaf2);
      clearTimeout(refitTimer);
      try { onDataDisp.dispose(); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      try { term.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [wsPath, initialCwd, reconnectNonce]);

  const isDisconnected = status === 'closed' || status === 'idle-closed' || status === 'error';
  const onReconnect = isDisconnected ? () => setReconnectNonce((n) => n + 1) : null;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <StatusBanner status={status} errorText={errorText} onReconnect={onReconnect} />
      {/* Padding wrapper, so xterm's parent reports an unpadded
          clientHeight to FitAddon. With padding on the same element
          that holds the xterm, the fit calc rounds rows up and the
          bottom line gets clipped. */}
      <div className="flex-1 min-h-0 overflow-hidden bg-black rounded-b-lg p-1.5">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
});

function StatusBanner({ status, errorText, onReconnect }) {
  const map = {
    connecting: { label: 'Connecting…', cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
    connected: { label: 'Connected', cls: 'bg-green-500/15 text-green-400 border-green-500/30' },
    'idle-closed': { label: 'Closed (idle)', cls: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
    closed: { label: 'Disconnected', cls: 'bg-gray-500/15 text-gray-300 border-gray-500/30' },
    error: { label: 'Error', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
  };
  const info = map[status] || map.closed;
  return (
    <div className={`flex items-center text-[11px] font-mono px-2 py-1 border rounded-t-lg ${info.cls}`}>
      <span>{info.label}</span>
      {errorText ? <span className="ml-2 opacity-80">— {errorText}</span> : null}
      {onReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          className="ml-auto px-2 py-0.5 text-[11px] font-mono rounded border border-current/40 hover:bg-current/10 cursor-pointer"
          title="Re-establish the WebSocket connection"
        >
          Reconnect
        </button>
      )}
    </div>
  );
}

export default InteractiveTerminal;
