import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

// Streaming xterm.js terminal backed by /api/terminal/* WebSocket.
//
//   <InteractiveTerminal wsPath="/api/terminal/lxc/my-container" />
//   <InteractiveTerminal wsPath="/api/terminal/host" />
//
// The component is self-contained: it spins up a Terminal, connects
// the WebSocket, wires input/output, handles resize via
// ResizeObserver, and tears everything down on unmount.

function buildWsUrl(wsPath) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${wsPath}`;
}

const STATUS_LABEL = {
  idle: 'Connecting…',
  connecting: 'Connecting…',
  open: 'Connected',
  closed: 'Disconnected',
  error: 'Connection error',
};

const STATUS_COLOR = {
  idle: 'bg-gray-500',
  connecting: 'bg-yellow-500',
  open: 'bg-green-500',
  closed: 'bg-gray-400',
  error: 'bg-red-500',
};

export default function InteractiveTerminal({ wsPath }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const observerRef = useRef(null);
  const [status, setStatus] = useState('connecting');
  const [closeReason, setCloseReason] = useState('');

  useEffect(() => {
    if (!containerRef.current || !wsPath) return undefined;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#000000',
        foreground: '#e5e7eb',
        cursor: '#22d3ee',
      },
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);

    term.open(containerRef.current);

    // Initial fit before opening the WS so the first resize message
    // carries the correct dimensions.
    try { fit.fit(); } catch { /* container not laid out yet */ }

    termRef.current = term;
    fitRef.current = fit;

    const ws = new WebSocket(buildWsUrl(wsPath));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    const sendResize = () => {
      if (!termRef.current || !fitRef.current) return;
      try { fitRef.current.fit(); } catch { return; }
      const { cols, rows } = termRef.current;
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        } catch { /* socket race */ }
      }
    };

    ws.addEventListener('open', () => {
      setStatus('open');
      sendResize();
      term.focus();
    });

    ws.addEventListener('message', (ev) => {
      const data = ev.data;
      if (typeof data === 'string') {
        // Server-side control envelope (e.g. {type:'closed', reason})
        // arrives as a text frame. Surface it on the status banner;
        // anything else falls through and gets written to the term.
        if (data.startsWith('{')) {
          try {
            const env = JSON.parse(data);
            if (env && typeof env === 'object') {
              if (env.type === 'closed') {
                setCloseReason(env.reason || '');
              } else if (env.type === 'error' && env.message) {
                setCloseReason(env.message);
              }
              return;
            }
          } catch { /* not JSON — fall through */ }
        }
        term.write(data);
      } else {
        // ArrayBuffer — write through to xterm
        term.write(new Uint8Array(data));
      }
    });

    ws.addEventListener('close', (ev) => {
      setStatus('closed');
      if (!closeReason) {
        setCloseReason(ev.reason || `code ${ev.code}`);
      }
    });

    ws.addEventListener('error', () => {
      setStatus('error');
    });

    const onDataDisp = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'input', data }));
        } catch { /* socket race */ }
      }
    });

    // Refit + notify backend when the container resizes
    const observer = new ResizeObserver(() => {
      sendResize();
    });
    observer.observe(containerRef.current);
    observerRef.current = observer;

    return () => {
      try { observer.disconnect(); } catch { /* ignore */ }
      try { onDataDisp.dispose(); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      try { term.dispose(); } catch { /* ignore */ }
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      observerRef.current = null;
    };
    // wsPath is the only meaningful identity; closeReason intentionally
    // omitted so it doesn't tear down the session on every status flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsPath]);

  return (
    <div className="flex flex-col h-full w-full bg-black rounded-lg border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-black/60 border-b border-border/40">
        <span className={`inline-block h-2 w-2 rounded-full ${STATUS_COLOR[status] || 'bg-gray-500'}`} />
        <span className="text-gray-300">{STATUS_LABEL[status] || status}</span>
        {closeReason && (
          <span className="text-gray-500 truncate">— {closeReason}</span>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 p-2" />
    </div>
  );
}
