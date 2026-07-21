// AnnotateApp — tap-to-pin feedback on a live screenshot of the deployed app.
//
// Reviewing from a phone, typing "the third card on the dashboard is
// misaligned" is friction; tapping the card and writing three words is not.
// The dialog loads a real screenshot of the running app (backend Playwright
// shot, same login the browser checks use), the user taps to drop numbered
// pins and writes a short note per pin, and Send composes a precise Quick
// update: the annotated image (pins burned in) + a numbered instruction list
// with percent coordinates.
//
// MOBILE_FIRST: full-screen dialog below sm; 44px touch targets; the
// screenshot itself is the tap surface.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, RefreshCw, MapPin, X, Send } from 'lucide-react';

const MAX_PINS = 8;

export default function AnnotateApp({ projectId, open, onOpenChange, onSend }) {
  const [path, setPath] = useState('/');
  // The screenshot is FETCHED (not <img src>): an <img> error is mute, but the
  // route's failure body says exactly why ("playwright not installed", "app
  // offline", a browser error) — show that instead of a generic guess.
  const [imgUrl, setImgUrl] = useState(null); // object URL of the fetched PNG
  const [imgState, setImgState] = useState('idle'); // idle | loading | ready | error
  const [signedOut, setSignedOut] = useState(false); // the shot is the app's sign-in page
  const [errMsg, setErrMsg] = useState('');
  const [pins, setPins] = useState([]); // { x, y, note } — x/y in % of the image
  const [sending, setSending] = useState(false);
  const imgRef = useRef(null);

  const load = useCallback(async (p) => {
    setPins([]);
    setImgState('loading');
    setErrMsg('');
    setSignedOut(false);
    // The server hard-caps a capture at ~60s; this abort is the belt on top so
    // the dialog can never sit on the spinner forever (user report).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 75000);
    try {
      const res = await fetch(api.mock2AppScreenshotUrl(projectId, { path: p }), { credentials: 'same-origin', signal: ctrl.signal });
      if (!res.ok) {
        let msg = `the server answered ${res.status}`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep status */ }
        setErrMsg(msg);
        setImgState('error');
        return;
      }
      setSignedOut(res.headers.get('X-Screenshot-Signed-Out') === '1');
      const blob = await res.blob();
      setImgUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      setImgState('ready');
    } catch (e) {
      setErrMsg(e?.name === 'AbortError'
        ? 'the screenshot timed out — the app or backend may be busy; try Refresh in a moment'
        : (e?.message || 'network error'));
      setImgState('error');
    } finally {
      clearTimeout(timer);
    }
  }, [projectId]);
  const reload = useCallback(() => load(path), [load, path]);
  // Shoot when the dialog OPENS (not on mount — the server spins up a real
  // browser). Re-shoot on reopen after a failure; a ready shot is kept until
  // the user hits Refresh. The ref gates to the open TRANSITION so an error
  // can't retry-loop.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current && imgState !== 'ready') load(path);
    wasOpen.current = open;
  }, [open, imgState, load, path]);

  const addPin = (e) => {
    if (pins.length >= MAX_PINS || imgState !== 'ready') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setPins((cur) => [...cur, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, note: '' }]);
  };

  const setNote = (i, note) => setPins((cur) => cur.map((p, j) => (j === i ? { ...p, note } : p)));
  const removePin = (i) => setPins((cur) => cur.filter((_, j) => j !== i));

  // Burn the pins into the screenshot (canvas at the image's natural size) so
  // the build sees exactly what the user marked.
  const annotatedImage = () => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const r = Math.max(14, Math.round(img.naturalWidth / 28));
    pins.forEach((p, i) => {
      const cx = (p.x / 100) * canvas.width;
      const cy = (p.y / 100) * canvas.height;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(220, 38, 38, 0.85)';
      ctx.fill();
      ctx.lineWidth = Math.max(2, r / 7);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(r * 1.1)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), cx, cy);
    });
    const dataUrl = canvas.toDataURL('image/png');
    return { media_type: 'image/png', data: dataUrl.split(',')[1], name: 'annotated-screenshot.png' };
  };

  const send = async () => {
    const noted = pins.filter((p) => p.note.trim());
    if (!noted.length) return;
    const image = annotatedImage();
    if (!image) return;
    const lines = pins
      .map((p, i) => (p.note.trim() ? `${i + 1}. At pin ${i + 1} (${p.x}% from the left, ${p.y}% from the top of ${path}): ${p.note.trim()}` : null))
      .filter(Boolean);
    const text = `Annotated screenshot of ${path} attached — the numbered red pins mark the exact spots.\n${lines.join('\n')}\nApply exactly these changes at the marked spots; change nothing else.`;
    setSending(true);
    try {
      await onSend({ text, image });
      setPins([]);
      onOpenChange(false);
    } finally { setSending(false); }
  };

  const notedCount = pins.filter((p) => p.note.trim()).length;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!sending) onOpenChange(o); }}>
      <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><MapPin className="h-4 w-4" /> Annotate the app</DialogTitle>
          <DialogDescription>
            Tap the screenshot to drop a pin, write what should change there, and send — it becomes a
            Quick update with the marked image attached.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              className="h-11 sm:h-10 flex-1 font-mono text-xs"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') reload(); }}
              placeholder="/ (page path to screenshot)"
              aria-label="Page path to screenshot"
            />
            <Button variant="outline" className="h-11 sm:h-10 shrink-0" onClick={reload} disabled={imgState === 'loading'} aria-label="Refresh the screenshot">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <div className="relative rounded-md border overflow-hidden bg-muted/30">
            {/* The tap surface — the img stays mounted so onLoad/onError fire;
                a spinner/error overlay covers it until it's ready. Same-origin
                authed request, so no crossOrigin needed for the canvas. */}
            <div
              className={`relative ${imgState === 'ready' ? 'cursor-crosshair' : ''}`}
              onClick={addPin}
              role="button"
              aria-label="Tap to add an annotation pin"
              tabIndex={0}
            >
              {imgUrl ? (
                <img
                  ref={imgRef}
                  src={imgUrl}
                  alt={`Screenshot of ${path}`}
                  className={`block w-full ${imgState === 'ready' ? '' : 'min-h-[140px] opacity-0'}`}
                />
              ) : <div className="min-h-[140px]" />}
              {imgState === 'ready' ? pins.map((p, i) => (
                <span
                  key={i}
                  className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white ring-2 ring-white shadow"
                  style={{ left: `${p.x}%`, top: `${p.y}%` }}
                >
                  {i + 1}
                </span>
              )) : null}
            </div>
            {imgState === 'loading' ? (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Taking a live screenshot…
              </div>
            ) : null}
            {imgState === 'error' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-6 text-center text-sm text-muted-foreground">
                <span>Couldn&apos;t screenshot the app{errMsg ? ':' : ' — it may be offline or mid-deploy.'}</span>
                {errMsg ? <span className="text-xs break-words max-w-full">{errMsg}</span> : null}
                <span className="text-xs">Try Refresh in a moment.</span>
              </div>
            ) : null}
          </div>
          {pins.length ? (
            <div className="space-y-2">
              {pins.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-600 text-[11px] font-bold text-white">{i + 1}</span>
                  <Input
                    className="h-11 sm:h-10 flex-1"
                    value={p.note}
                    onChange={(e) => setNote(i, e.target.value)}
                    placeholder="What should change here?"
                    aria-label={`Note for pin ${i + 1}`}
                  />
                  <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-red-500" onClick={() => removePin(i)} aria-label={`Remove pin ${i + 1}`}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No pins yet — tap the screenshot where something should change.</p>
          )}
          {imgState === 'ready' && signedOut && (
            <p className="text-xs text-amber-500">
              The app asked for a sign-in, so this shows its sign-in page. Screenshots sign in automatically once a
              full build has created fixture logins (state/ui-checks.json) — until then, annotate the sign-in page or
              run a Full build first.
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="min-h-[44px] flex-1" disabled={sending || !notedCount} onClick={send}>
              {sending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
              Send {notedCount || ''} change{notedCount === 1 ? '' : 's'} as Quick update
            </Button>
            <Button variant="ghost" className="min-h-[44px]" disabled={sending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
