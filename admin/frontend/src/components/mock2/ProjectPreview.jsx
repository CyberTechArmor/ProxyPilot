// The project preview iframe + its empty-state placeholder.
//
// Extracted from ProjectDetail so both the pre-approval design layout and the
// post-approval build layout render the same live preview (the mockup before
// approval, the working app after). The mockup is served same-origin by the
// dashboard's /mockup-preview API route (CSP-sandboxed to an opaque origin),
// so it embeds cleanly regardless of the project app's own state or headers.
//
// MOBILE_FIRST: full-width, the Desktop/Mobile toggle labels collapse to icons.

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { RefreshCw, ExternalLink, Monitor, Smartphone, Loader2, Sparkles, CheckCircle2, Maximize2, Minimize2, MapPin, X, Send, Sparkle } from 'lucide-react';

const MAX_PREVIEW_PINS = 8;

// One-line human description of a bridge-reported element, for the build.
function describeEl(el) {
  if (!el) return null;
  const head = `<${el.tag || 'element'}>${el.text ? ` "${el.text}"` : ''}`;
  const meta = [];
  if (el.component) meta.push(`component ${el.component}`);
  if (el.label) meta.push(`label "${el.label}"`);
  if (el.id) meta.push(`#${el.id}`);
  if (el.source) meta.push(`source ${el.source}`);
  if (!el.component && !el.source && el.selector) meta.push(`selector ${el.selector}`);
  const loc = el.rect ? ` (around ${el.rect.x}%, ${el.rect.y}%)` : '';
  return `${head}${meta.length ? ` — ${meta.join(', ')}` : ''}${loc}`;
}

// Compose the Quick-update instruction from the dropped pins. When the in-app
// bridge resolved the tapped element (el), reference it by component/source so
// the build knows exactly what to change; otherwise fall back to % coordinates
// of the visible preview.
function composePreviewAnnotation(src, pins, { hasImage = false, elementAware = false } = {}) {
  const lines = pins
    .map((p, i) => {
      if (!p.note.trim()) return null;
      const target = p.el ? describeEl(p.el) : `at ${p.x}% from the left, ${p.y}% from the top of the visible preview`;
      return `${i + 1}. Pin ${i + 1} → ${target}: ${p.note.trim()}`;
    })
    .filter(Boolean);
  const how = elementAware
    ? 'each pin resolves to the actual element/component that was tapped'
    : 'pins are a percentage of the visible preview area';
  const img = hasImage ? ' A screenshot with the numbered pins burned in is attached.' : '';
  return `Annotated the live preview (${src}) — the numbered pins mark the exact spots on the screen currently shown in the preview (${how}).${img}\n${lines.join('\n')}\nApply exactly these changes at the marked spots; change nothing else.`;
}

// Capture the visible preview via the browser's tab-snapshot (getDisplayMedia),
// crop to the iframe, and burn the numbered pins in. The preview iframe is
// cross-origin, so this is the only way to get a real pixel image of the
// signed-in view. Returns { media_type, data, name } or null (unsupported /
// denied / failed — the caller proceeds without an image).
async function capturePreviewImage(iframeEl, pins) {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  if (!md || !md.getDisplayMedia || !iframeEl) return null;
  let stream = null;
  try {
    stream = await md.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true });
  } catch { return null; }
  try {
    const video = document.createElement('video');
    video.muted = true; video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 220)); // let a frame settle
    const rect = iframeEl.getBoundingClientRect();
    const scaleX = video.videoWidth / (window.innerWidth || 1);
    const scaleY = video.videoHeight / (window.innerHeight || 1);
    if (!video.videoWidth || !rect.width) return null;
    const sx = Math.max(0, rect.left * scaleX);
    const sy = Math.max(0, rect.top * scaleY);
    const sw = Math.min(video.videoWidth - sx, rect.width * scaleX);
    const sh = Math.min(video.videoHeight - sy, rect.height * scaleY);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const rad = Math.max(12, Math.round(canvas.width / 34));
    pins.forEach((p, i) => {
      const cx = (p.x / 100) * canvas.width;
      const cy = (p.y / 100) * canvas.height;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(220, 38, 38, 0.85)'; ctx.fill();
      ctx.lineWidth = Math.max(2, rad / 7); ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(rad * 1.1)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), cx, cy);
    });
    return { media_type: 'image/png', data: canvas.toDataURL('image/png').split(',')[1], name: 'preview-annotation.png' };
  } catch { return null; }
  finally { try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ } }
}

// onAnnotate (optional) — async ({ text, image }) => void. When provided, the
// toolbar shows an "Annotate" toggle: turning it on lets the operator drop pins
// on the LIVE embedded app. If the app carries the annotate bridge, each tap
// resolves to the real element/component (element-aware); otherwise it falls
// back to a coordinate overlay. Send optionally attaches a real screenshot of
// the signed-in view and routes it to the build as a Quick update. Omitted for
// the mockup preview (pre-build).
export function PreviewPanel({ src, title, approved, reloadKey = 0, fullHeight = false, onToggleFullHeight = null, onAnnotate = null }) {
  const [width, setWidth] = useState('desktop'); // 'desktop' | 'mobile'
  const [annotating, setAnnotating] = useState(false);
  const [pins, setPins] = useState([]); // { x, y, note, el? } — x/y in % of the visible preview
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState(0); // brief "sent" confirmation
  const [attachShot, setAttachShot] = useState(true); // attach a screenshot on send
  const [mode, setMode] = useState('probing'); // 'probing' | 'bridge' | 'overlay'
  const bridgeSeenRef = useRef(false); // the app announced the bridge at least once

  // Double-buffered preview: two stacked iframes. A reload loads the BACK buffer
  // while the FRONT stays painted, then we cross-fade — so live rebuilds refresh
  // WITHOUT the white flash a remount causes.
  const refA = useRef(null);
  const refB = useRef(null);
  const [frontId, setFrontId] = useState(0);
  const frontIdRef = useRef(0);
  useEffect(() => { frontIdRef.current = frontId; }, [frontId]);
  const frontIframe = () => (frontIdRef.current === 0 ? refA.current : refB.current);
  const [gens, setGens] = useState([0, 1]); // per-buffer remount keys
  const loadingRef = useRef(null); // the buffer currently loading a reload
  const lastReloadRef = useRef(reloadKey);
  const reloadBack = () => {
    const back = 1 - frontIdRef.current;
    loadingRef.current = back;
    setGens((g) => { const n = [...g]; n[back] += 2; return n; }); // remount the hidden buffer
  };
  const onBufLoad = (id) => { if (loadingRef.current === id) { loadingRef.current = null; setFrontId(id); } };

  // Auto-reload as the build progresses (reloadKey bumps), but NEVER while
  // annotating — the app must hold still under the operator's pins.
  useEffect(() => {
    if (annotating) return;
    if (lastReloadRef.current === reloadKey) return;
    lastReloadRef.current = reloadKey;
    reloadBack();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, annotating]);

  const appOrigin = (() => { try { return new URL(src).origin; } catch { return '*'; } })();
  const postToApp = (type) => {
    try { frontIframe()?.contentWindow?.postMessage({ __pp: 'annotate-host', type }, appOrigin); } catch { /* cross-origin race */ }
  };

  // Bridge handshake + pin stream. We listen whenever annotate is available so
  // we know the element-aware path exists; pins only flow while annotating.
  useEffect(() => {
    if (!onAnnotate) return undefined;
    const onMsg = (e) => {
      if (appOrigin !== '*' && e.origin !== appOrigin) return;
      const d = e.data;
      if (!d || d.__pp !== 'annotate-bridge') return;
      if (d.type === 'ready' || d.type === 'enabled') { bridgeSeenRef.current = true; setMode('bridge'); }
      else if (d.type === 'pin' && d.pin) {
        setPins((cur) => (cur.length >= MAX_PREVIEW_PINS ? cur : [...cur, {
          x: Number(d.pin.x) || 0, y: Number(d.pin.y) || 0, note: '', el: d.pin,
        }]));
      }
    };
    window.addEventListener('message', onMsg, false);
    return () => window.removeEventListener('message', onMsg, false);
  }, [onAnnotate, appOrigin]);

  // Entering/leaving annotate mode drives the bridge and the probe→overlay
  // fallback (if the app has no bridge, switch to the coordinate overlay).
  useEffect(() => {
    if (!annotating) { postToApp('disable'); return undefined; }
    setMode(bridgeSeenRef.current ? 'bridge' : 'probing');
    postToApp('ping'); postToApp('enable');
    const t = setTimeout(() => setMode((m) => (m === 'bridge' ? 'bridge' : 'overlay')), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotating]);

  const exitAnnotate = () => { postToApp('disable'); setAnnotating(false); setPins([]); };
  const addPin = (e) => {
    if (pins.length >= MAX_PREVIEW_PINS) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 10;
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 10;
    setPins((cur) => [...cur, { x, y, note: '' }]);
  };
  const setNote = (i, note) => setPins((cur) => cur.map((p, j) => (j === i ? { ...p, note } : p)));
  const removePin = (i) => setPins((cur) => cur.filter((_, j) => j !== i));
  const notedCount = pins.filter((p) => p.note.trim()).length;
  const elementAware = mode === 'bridge';

  const sendPins = async () => {
    if (!notedCount || !onAnnotate) return;
    setSending(true);
    try {
      let image = null;
      if (attachShot) {
        postToApp('disable'); // stop pin capture during the snapshot
        image = await capturePreviewImage(frontIframe(), pins.filter((p) => p.note.trim())).catch(() => null);
      }
      await onAnnotate({ text: composePreviewAnnotation(src, pins, { hasImage: !!image, elementAware }), image });
      exitAnnotate();
      setSentAt(Date.now());
    } finally { setSending(false); }
  };

  // In bridge mode the iframe must stay interactive so the bridge sees taps; in
  // overlay mode our overlay captures them, so the iframe is inert underneath.
  const overlayActive = annotating && mode === 'overlay';

  return (
    <div className="flex flex-col h-full min-h-0 rounded-lg border overflow-hidden bg-muted/20">
      <div className="flex items-center justify-between gap-2 border-b bg-background/60 px-3 py-2 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="hidden sm:flex items-center gap-1.5 shrink-0">
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
          </span>
          <span className="truncate text-xs font-mono text-muted-foreground">{src}</span>
          <Button
            variant="ghost" size="icon" className="h-7 w-7 shrink-0"
            onClick={reloadBack}
            aria-label="Reload preview" title="Reload preview"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <div className="flex rounded-md border p-0.5">
            <button
              type="button" aria-pressed={width === 'desktop'} onClick={() => setWidth('desktop')}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${width === 'desktop' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
            >
              <Monitor className="h-3.5 w-3.5" /><span className="hidden sm:inline">Desktop</span>
            </button>
            <button
              type="button" aria-pressed={width === 'mobile'} onClick={() => setWidth('mobile')}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${width === 'mobile' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
            >
              <Smartphone className="h-3.5 w-3.5" /><span className="hidden sm:inline">Mobile</span>
            </button>
          </div>
          {onAnnotate ? (
            <Button
              variant={annotating ? 'default' : 'outline'} size="sm" className="h-9 shrink-0"
              onClick={() => (annotating ? exitAnnotate() : setAnnotating(true))}
              aria-pressed={annotating}
              title={annotating ? 'Exit annotate mode' : 'Drop pins on the live preview and send them as a Quick update'}
            >
              <MapPin className="h-4 w-4" /><span className="ml-1 hidden sm:inline">{annotating ? 'Done' : 'Annotate'}</span>
            </Button>
          ) : null}
          <Button asChild variant="outline" size="sm" className="h-9 shrink-0">
            <a href={src} target="_blank" rel="noreferrer" aria-label="Open the app in a new tab">
              <ExternalLink className="h-4 w-4 mr-1" /> Open App
            </a>
          </Button>
          {onToggleFullHeight ? (
            <Button
              variant="outline" size="sm" className="h-9 shrink-0"
              onClick={onToggleFullHeight}
              aria-label={fullHeight ? 'Restore terminal' : 'Expand preview to full height'}
              title={fullHeight ? 'Restore the terminal below' : 'Full height (use the terminal’s space too)'}
            >
              {fullHeight ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              <span className="ml-1 hidden sm:inline">{fullHeight ? 'Restore' : 'Full height'}</span>
            </Button>
          ) : null}
        </div>
      </div>
      {annotating ? (
        <p className="flex items-center gap-1.5 border-b bg-primary/10 px-3 py-1.5 text-[11px] text-foreground shrink-0">
          {elementAware
            ? <><Sparkle className="h-3.5 w-3.5 text-primary shrink-0" /> Element-aware: tap the app and each pin captures the exact component. Write what should change, then send.</>
            : mode === 'probing'
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> Connecting to the app…</>
              : <><MapPin className="h-3.5 w-3.5 text-primary shrink-0" /> Tap the preview to drop a pin, then write what should change. (This app has no annotate bridge yet — rebuild to map pins to components.)</>}
        </p>
      ) : null}
      <div className="relative flex-1 min-h-0 overflow-hidden bg-background">
        {/* Two stacked buffers: the front is painted; a reload loads the back
            (hidden) then cross-fades in — no white flash. */}
        {[0, 1].map((id) => {
          const w = width === 'mobile' ? 390 : '100%';
          return (
            <iframe
              key={`${id}-${gens[id]}`}
              ref={id === 0 ? refA : refB}
              title={`${title || 'Project'} preview`}
              src={src}
              onLoad={() => onBufLoad(id)}
              className="absolute inset-y-0 border-0 bg-white"
              style={{
                width: w,
                maxWidth: '100%',
                left: width === 'mobile' ? '50%' : 0,
                marginLeft: width === 'mobile' ? -195 : 0,
                opacity: id === frontId ? 1 : 0,
                transition: 'opacity 200ms ease',
                pointerEvents: id === frontId && !overlayActive ? 'auto' : 'none',
              }}
              sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-modals"
            />
          );
        })}
        {/* Coordinate overlay — only in fallback (no bridge). In bridge mode the
            iframe stays interactive so the in-app bridge receives the taps. */}
        {overlayActive ? (
          <div
            className="absolute inset-0 cursor-crosshair"
            onClick={addPin}
            role="button"
            aria-label="Tap to add an annotation pin on the preview"
            tabIndex={0}
          />
        ) : null}
        {/* Pin badges — non-interactive, drawn over the app at their coordinates
            in BOTH modes (bridge pins come from the app; overlay pins from taps). */}
        {annotating ? (
          <div className="pointer-events-none absolute inset-0">
            {pins.map((p, i) => (
              <span
                key={i}
                className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white ring-2 ring-white shadow"
                style={{ left: `${p.x}%`, top: `${p.y}%` }}
              >
                {i + 1}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {annotating ? (
        <div className="max-h-[45%] shrink-0 space-y-2 overflow-y-auto border-t bg-background/95 p-3">
          {pins.length ? pins.map((p, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-600 text-[11px] font-bold text-white">{i + 1}</span>
              <div className="flex-1 min-w-0">
                {p.el ? (
                  <p className="mb-1 truncate text-[11px] text-muted-foreground" title={describeEl(p.el)}>
                    {p.el.component ? <span className="font-medium text-foreground">{p.el.component}</span> : `<${p.el.tag}>`}
                    {p.el.text ? ` · “${p.el.text}”` : ''}{p.el.source ? ` · ${p.el.source}` : ''}
                  </p>
                ) : null}
                <input
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={p.note}
                  onChange={(e) => setNote(i, e.target.value)}
                  placeholder="What should change here?"
                  aria-label={`Note for pin ${i + 1}`}
                />
              </div>
              <Button variant="ghost" size="icon" className="mt-0.5 h-9 w-9 shrink-0 text-red-500" onClick={() => removePin(i)} aria-label={`Remove pin ${i + 1}`}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          )) : (
            <p className="text-xs text-muted-foreground">No pins yet — tap the preview where something should change.</p>
          )}
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input type="checkbox" checked={attachShot} onChange={(e) => setAttachShot(e.target.checked)} className="h-3.5 w-3.5" />
            Attach a screenshot of the current view (asks the browser to snapshot this tab).
          </label>
          <div className="flex gap-2 pt-1">
            <Button className="min-h-[40px] flex-1" disabled={sending || !notedCount} onClick={sendPins}>
              {sending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
              Send {notedCount || ''} change{notedCount === 1 ? '' : 's'} as Quick update
            </Button>
            <Button variant="ghost" className="min-h-[40px]" disabled={sending} onClick={exitAnnotate}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {!annotating && sentAt ? (
        <p className="flex items-center gap-1.5 border-t bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-600 shrink-0">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Sent as a Quick update — watch the build chat.
        </p>
      ) : null}
      {!approved && !annotating ? (
        <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground shrink-0">
          Non-functional mockup preview — approve the design in the chat to build the working app.
        </p>
      ) : null}
    </div>
  );
}

// LiveAppBar — the build-mode stand-in for the preview iframe. The BUILT app
// sets its own frame-ancestors policy (constitution §5) and refuses to be
// embedded, so an iframe just shows "refused to connect". Instead we show a
// compact bar with the live URL and an open-in-new-tab button — the running app
// opens in a real tab where its own security headers apply.
//
// The button is LIVENESS-AWARE: it polls the app-live probe (does the REAL app
// answer its port?) and stays disabled, pulsing "Updating…", through the
// deploy window — where a click used to serve the placeholder, then a
// connection error, then finally the app. Solid "Open app" only when live.
export function LiveAppBar({ url, projectId, probeKey = '' }) {
  const [live, setLive] = useState(null); // null = unknown (first probe pending)
  useEffect(() => {
    if (!projectId || !url) return undefined;
    let stopped = false;
    let timer = null;
    const probe = async () => {
      let isLive = false;
      try { isLive = !!(await api.mock2AppLive(projectId)).live; } catch { isLive = false; }
      if (stopped) return;
      setLive(isLive);
      // Fast poll while updating (flip to solid the moment it serves); gentle
      // heartbeat once live so a later crash flips the button back honestly.
      timer = setTimeout(probe, isLive ? 12000 : 3000);
    };
    probe();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
    // probeKey re-probes IMMEDIATELY on build/deploy transitions (cycle status,
    // deploy sub-state, base-app deploy) — the button updates the moment a
    // deploy lands instead of waiting out the poll interval or a page refresh.
  }, [projectId, url, probeKey]);

  const ready = live === true;
  return (
    <div className="rounded-lg border bg-muted/20 overflow-hidden shrink-0">
      <div className="flex items-center justify-between gap-2 border-b bg-background/60 px-3 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="hidden sm:flex items-center gap-1.5 shrink-0">
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
          </span>
          {url && ready ? (
            <a href={url} target="_blank" rel="noreferrer" className="truncate text-xs font-mono text-primary hover:underline">{url}</a>
          ) : url ? (
            <span className="truncate text-xs font-mono text-muted-foreground">{url}</span>
          ) : (
            <span className="truncate text-xs font-mono text-muted-foreground">No live URL yet</span>
          )}
        </div>
        {url ? (
          ready ? (
            <Button asChild variant="outline" size="sm" className="h-9 shrink-0">
              <a href={url} target="_blank" rel="noreferrer" aria-label="Open the app in a new tab">
                <ExternalLink className="h-4 w-4 mr-1" /> Open app
              </a>
            </Button>
          ) : (
            <Button
              variant="outline" size="sm" className="h-9 shrink-0 animate-pulse" disabled
              title="The app is deploying or restarting — this goes solid the moment it answers"
            >
              <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Updating…
            </Button>
          )
        ) : null}
      </div>
      <p className="px-3 py-2.5 text-[11px] text-muted-foreground">
        {ready
          ? 'The running app opens in a new tab — it sets a frame policy that blocks being embedded here.'
          : 'The app is deploying or restarting — the button goes solid and clickable the moment the real app answers.'}
      </p>
    </div>
  );
}

// SetupProgress — the live provisioning step list, streamed into the Chat tab
// while the project is coming online. The most recent entry is "the current
// step" (highlighted with a spinner); earlier entries read as done. Failures in
// a step's message are tinted red. Fed from provStatus.progress.log
// ([{ phase, message }]).
export function SetupProgress({ log = [] }) {
  const steps = Array.isArray(log) ? log : [];
  const lastIdx = steps.length - 1;
  return (
    <ol className="mt-3 w-full max-w-md space-y-1.5 text-left">
      {steps.map((entry, i) => {
        const current = i === lastIdx;
        const failed = /failed|error|not found|unreachable/i.test(entry.message || '');
        return (
          <li key={i} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 shrink-0">
              {current
                ? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
            </span>
            <span className={`min-w-0 break-words ${current ? 'font-medium text-foreground' : failed ? 'text-red-500' : 'text-muted-foreground'}`}>
              {entry.phase ? <span className="font-mono text-muted-foreground/70">[{entry.phase}] </span> : null}
              {entry.message}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Shown when there is no preview yet (no mockup, or the project is still
// provisioning). Keeps the chat as the focus while explaining what will appear.
// While provisioning, streams the live setup step log (SetupProgress).
export function PreviewPlaceholder({ project, provLog = null, provMessage = null }) {
  const building = project.lifecycle === 'provisioning';
  const hasLog = building && Array.isArray(provLog) && provLog.length > 0;
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-muted/10 px-6 py-10 text-center">
      {building
        ? <Loader2 className="mb-3 h-6 w-6 animate-spin text-muted-foreground" />
        : <Sparkles className="mb-3 h-6 w-6 text-muted-foreground" />}
      <p className="text-sm font-medium">
        {building ? (provMessage || 'Setting up your project…') : 'Your live preview will appear here'}
      </p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        {building
          ? 'The container, repository, and URL are being provisioned.'
          : 'Describe your app in the chat below. As soon as a mockup is generated it shows up here — and once you approve the design and build, the working app replaces it.'}
      </p>
      {hasLog ? <SetupProgress log={provLog} /> : null}
    </div>
  );
}
