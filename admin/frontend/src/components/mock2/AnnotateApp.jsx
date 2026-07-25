// AnnotateApp — tap-to-pin feedback on live screenshots of the deployed app.
//
// Reviewing from a phone, typing "the third card on the dashboard is
// misaligned" is friction; tapping the card and writing three words is not.
// The dialog loads a real screenshot of the running app (backend Playwright
// shot, same login the browser checks use), the user taps to drop numbered
// pins and writes a short note per pin, and Send composes a precise Quick
// update: the annotated image(s) (pins burned in) + a numbered instruction
// list with percent coordinates.
//
// MULTI-PAGE. Pins survive navigation: capture /, pin it, type /settings,
// capture that, pin it too, send once. Each pin remembers the shot it was
// dropped on, and Send burns one annotated image per shot that has pins. The
// previous version called setPins([]) on every load, so a second page silently
// destroyed the first page's work — you could only ever report one screen.
//
// SCROLL-SAFE. A full-page screenshot is taller than the phone, so reaching a
// pin site means dragging on the very surface that drops pins. A raw onClick
// turns each scroll into a stray pin (and MAX_PINS fills up with junk). Pins
// are committed on pointerup only when the pointer barely moved — a drag
// scrolls and drops nothing.
//
// MOBILE_FIRST: full-screen dialog below sm; 44px touch targets; the
// screenshot itself is the tap surface.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, RefreshCw, MapPin, X, Send, ImagePlus, Trash2 } from 'lucide-react';

const MAX_PINS = 12;          // across every page, not per page
const MAX_SHOTS = 6;
// A tap is a press that barely moves. Anything further is a scroll gesture and
// must not leave a pin behind. 10px ≈ the slop a thumb has on a moving list.
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 800;

let shotSeq = 0;

export default function AnnotateApp({ projectId, open, onOpenChange, onSend, attachImage = null, onApply = null }) {
  const [path, setPath] = useState('/');
  // Captured screens, in capture order. Each: { key, path, url, source,
  // signedOut, revoke } — `revoke` marks an object URL we own and must free.
  const [shots, setShots] = useState([]);
  const [activeKey, setActiveKey] = useState(null);
  // Pins across ALL shots: { id, shotKey, x, y, note }. x/y in % of the image.
  const [pins, setPins] = useState([]);
  const [imgState, setImgState] = useState('idle'); // idle | loading | ready | error
  const [stageMsg, setStageMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');
  // App account for the capture to sign in with (kept in component state
  // only — sent with the start request, never stored anywhere).
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef(null);
  const imgRef = useRef(null);

  const activeShot = useMemo(() => shots.find((s) => s.key === activeKey) || null, [shots, activeKey]);
  const activePins = useMemo(() => pins.filter((p) => p.shotKey === activeKey), [pins, activeKey]);
  const notedCount = pins.filter((p) => p.note.trim()).length;
  // Stable display numbers: a pin's number is its position in the whole list,
  // so pin 4 is pin 4 in the note list, on the image, and in the sent text.
  const numberOf = useCallback((id) => pins.findIndex((p) => p.id === id) + 1, [pins]);

  const addShot = useCallback((shot) => {
    setShots((cur) => {
      // Re-capturing a path replaces that shot in place (and keeps its pins,
      // which still describe the same screen) rather than stacking duplicates.
      const i = cur.findIndex((s) => s.key === shot.key);
      if (i >= 0) {
        const old = cur[i];
        if (old.revoke && old.url !== shot.url) URL.revokeObjectURL(old.url);
        const next = [...cur];
        next[i] = shot;
        return next;
      }
      return [...cur, shot].slice(-MAX_SHOTS);
    });
    setActiveKey(shot.key);
  }, []);

  const useOwnImage = useCallback((file) => {
    if (!file || !String(file.type || '').startsWith('image/')) return;
    setErrMsg('');
    shotSeq += 1;
    addShot({
      key: `upload:${shotSeq}`,
      path: file.name || `uploaded image ${shotSeq}`,
      url: URL.createObjectURL(file),
      source: 'upload',
      signedOut: false,
      revoke: true,
    });
    setImgState('ready');
  }, [addShot]);

  const onPaste = useCallback((e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type?.startsWith('image/'));
    if (item) { e.preventDefault(); useOwnImage(item.getAsFile()); }
  }, [useOwnImage]);

  const load = useCallback(async (p) => {
    // NOTE: pins are deliberately NOT cleared here — navigating to another
    // page is how you report a second screen in one message.
    setImgState('loading');
    setErrMsg('');
    setStageMsg('starting…');
    try {
      // Job pattern: start answers instantly (proves the backend is alive),
      // then we poll the LIVE capture stage — a wedge shows on screen at the
      // exact stage it happens instead of an eternal spinner.
      try {
        await Promise.race([
          api.mock2AppScreenshotStart(projectId, {
            path: p,
            ...(loginEmail.trim() && loginPassword ? { login: { email: loginEmail.trim(), password: loginPassword } } : {}),
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('no acknowledgment within 10s')), 10000)),
        ]);
      } catch (e) {
        const msg = String(e?.message || '');
        setErrMsg(/404|No such|not found|acknowledgment/i.test(msg)
          ? `the backend did not acknowledge the screenshot job (${msg}) — it is likely running an older version or needs a restart: rerun update.sh and restart the backend service`
          : msg || 'network error');
        setImgState('error');
        return;
      }
      const t0 = Date.now();
      while (Date.now() - t0 < 130000) {
        let st;
        try {
          st = await api.mock2AppScreenshotStatus(projectId);
        } catch (e) {
          setErrMsg(`lost the backend while polling: ${e?.message || 'network error'}`);
          setImgState('error');
          return;
        }
        if (st.state === 'error') { setErrMsg(st.error || 'screenshot failed'); setImgState('error'); return; }
        if (st.state === 'done') {
          const res = await fetch(api.mock2AppScreenshotImageUrl(projectId), { credentials: 'same-origin' });
          if (!res.ok) { setErrMsg(`the server answered ${res.status} for the finished image`); setImgState('error'); return; }
          const ctype = res.headers.get('content-type') || '';
          if (!ctype.startsWith('image/')) {
            const text = await res.text().catch(() => '');
            setErrMsg(`the image endpoint returned ${ctype || 'no content-type'}${text ? `: ${text.slice(0, 200)}` : ''}`);
            setImgState('error');
            return;
          }
          const blob = await res.blob();
          addShot({ key: `live:${p}`, path: p, url: URL.createObjectURL(blob), source: 'live', signedOut: !!st.signed_out, revoke: true });
          setImgState('ready');
          return;
        }
        setStageMsg(st.stage ? `${st.stage} · ${Math.round((st.elapsed_ms || 0) / 1000)}s` : 'working…');
        await new Promise((r) => setTimeout(r, 1200));
      }
      setErrMsg('the capture never finished — the backend log has the "[mock2] screenshot" stage trail');
      setImgState('error');
    } catch (e) {
      setErrMsg(e?.message || 'network error');
      setImgState('error');
    }
  }, [projectId, loginEmail, loginPassword, addShot]);

  const reload = useCallback(() => load(path), [load, path]);
  // "Add this page" — capture `path` and keep everything already pinned.
  const capturePath = useCallback(() => load(path), [load, path]);

  // Shoot when the dialog OPENS (not on mount — the server spins up a real
  // browser). The ref gates to the open TRANSITION so an error can't retry-loop.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      // Every open starts with a clean slate: pins and shots from a previous
      // session describe a build that has since moved on.
      setPins([]);
      setErrMsg('');
      setShots((cur) => { cur.forEach((s) => { if (s.revoke) URL.revokeObjectURL(s.url); }); return []; });
      if (attachImage?.url) {
        // Attach mode: the image came from the chat composer — load it
        // directly, never fire the live capture.
        shotSeq += 1;
        const key = `attach:${shotSeq}`;
        setShots([{ key, path: attachImage.name || 'attached image', url: attachImage.url, source: 'attach', signedOut: false, revoke: false }]);
        setActiveKey(key);
        setImgState('ready');
      } else {
        setActiveKey(null);
        setImgState('idle');
        load(path);
      }
    }
    wasOpen.current = open;
  }, [open, load, path, attachImage]);

  // Free every object URL we created when the dialog unmounts.
  useEffect(() => () => { shots.forEach((s) => { if (s.revoke) URL.revokeObjectURL(s.url); }); }, [shots]);

  /* ---------------------------- tap vs. scroll ----------------------------
     A full-page screenshot is taller than the phone, so the pin surface IS the
     scroll surface. Committing on pointerup — and only when the pointer barely
     moved — lets a drag scroll the dialog without leaving a pin behind. */
  const press = useRef(null);
  const onPointerDown = (e) => {
    if (imgState !== 'ready' || !activeShot) return;
    press.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onPointerUp = (e) => {
    const p = press.current;
    press.current = null;
    if (!p || imgState !== 'ready' || !activeShot) return;
    if (Math.abs(e.clientX - p.x) > TAP_SLOP_PX || Math.abs(e.clientY - p.y) > TAP_SLOP_PX) return; // a scroll
    if (Date.now() - p.t > TAP_MAX_MS) return;                                                     // a long press
    if (pins.length >= MAX_PINS) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    if (x < 0 || x > 100 || y < 0 || y > 100) return;
    shotSeq += 1;
    setPins((cur) => [...cur, {
      id: `pin:${shotSeq}`,
      shotKey: activeShot.key,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      note: '',
    }]);
  };
  const onPointerCancel = () => { press.current = null; };

  const setNote = (id, note) => setPins((cur) => cur.map((p) => (p.id === id ? { ...p, note } : p)));
  const removePin = (id) => setPins((cur) => cur.filter((p) => p.id !== id));
  const removeShot = (key) => {
    setPins((cur) => cur.filter((p) => p.shotKey !== key));
    setShots((cur) => {
      const gone = cur.find((s) => s.key === key);
      if (gone?.revoke) URL.revokeObjectURL(gone.url);
      const next = cur.filter((s) => s.key !== key);
      setActiveKey((k) => (k === key ? (next[next.length - 1]?.key ?? null) : k));
      return next;
    });
  };

  // Burn a shot's pins into it (canvas at the image's natural size) so the
  // build sees exactly what was marked. Loads the URL into a detached Image so
  // it works for shots that are not the one currently on screen.
  const annotatedImage = (shot, shotPins) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const r = Math.max(14, Math.round(img.naturalWidth / 28));
      shotPins.forEach((p) => {
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
        ctx.fillText(String(numberOf(p.id)), cx, cy);
      });
      const dataUrl = canvas.toDataURL('image/png');
      const safe = String(shot.path || 'screen').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'screen';
      resolve({ media_type: 'image/png', data: dataUrl.split(',')[1], name: `annotated-${safe}.png` });
    };
    img.onerror = () => resolve(null);
    img.src = shot.url;
  });

  // One image per screen that has noted pins, plus the numbered instruction
  // list grouped the same way — so "3." in the text is "3" on the right image.
  const composeAll = async () => {
    const images = [];
    const blocks = [];
    for (const shot of shots) {
      const mine = pins.filter((p) => p.shotKey === shot.key && p.note.trim());
      if (!mine.length) continue;
      const image = await annotatedImage(shot, pins.filter((p) => p.shotKey === shot.key));
      if (image) images.push(image);
      const where = shot.source === 'live' ? shot.path : `the screenshot "${shot.path}"`;
      blocks.push(`On ${where}:\n${mine.map((p) => `${numberOf(p.id)}. At pin ${numberOf(p.id)} (${p.x}% from the left, ${p.y}% from the top): ${p.note.trim()}`).join('\n')}`);
    }
    return { images, blocks };
  };

  const send = async () => {
    if (!notedCount) return;
    setSending(true);
    try {
      const { images, blocks } = await composeAll();
      if (!images.length) return;

      // Attach mode: hand the annotated image + pin notes back to the composer
      // (the operator finishes the message and picks Ask / Quick update).
      if (onApply && attachImage) {
        onApply({
          text: `Annotated the attached image — the numbered red pins mark the exact spots:\n${blocks.join('\n\n')}`,
          image: images[0],
          images,
        });
        setPins([]);
        onOpenChange(false);
        return;
      }
      const plural = images.length > 1;
      const text = `Annotated screenshot${plural ? 's' : ''} of ${plural ? `${images.length} screens` : (shots.find((s) => pins.some((p) => p.shotKey === s.key && p.note.trim()))?.path || 'the app')} attached — the numbered red pins mark the exact spots.\n\n${blocks.join('\n\n')}\n\nApply exactly these changes at the marked spots; change nothing else.`;
      await onSend({ text, image: images[0], images });
      setPins([]);
      onOpenChange(false);
    } finally { setSending(false); }
  };

  const signedOut = !!activeShot?.signedOut;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!sending) onOpenChange(o); }}>
      <DialogContent onPaste={onPaste} className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><MapPin className="h-4 w-4" /> Annotate the app</DialogTitle>
          <DialogDescription>
            Tap the screenshot to drop a pin and write what should change there. You can capture
            several pages and pin each one — everything sends as a single Quick update.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {attachImage ? null : (
          <>
            <div className="flex gap-2">
              <Input
                className="h-11 sm:h-10 flex-1 font-mono text-xs"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') capturePath(); }}
                placeholder="/ (page path to screenshot)"
                aria-label="Page path to screenshot"
              />
              <Button variant="outline" className="h-11 sm:h-10 shrink-0" onClick={capturePath} disabled={imgState === 'loading'} aria-label="Capture this page">
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                className="h-11 sm:h-10 shrink-0"
                onClick={() => fileInputRef.current?.click()}
                disabled={imgState === 'loading'}
                title="Use your own screenshot — navigate the app yourself, screenshot it, then upload or paste (Ctrl+V) here"
                aria-label="Upload your own screenshot to annotate"
              >
                <ImagePlus className="h-4 w-4" />
              </Button>
              <input
                ref={fileInputRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { useOwnImage(e.target.files?.[0]); e.target.value = ''; }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Type another path and press Enter to add a second screen — your existing pins are kept.
              You can also screenshot the app yourself and paste it here with Ctrl+V.
            </p>
          </>
          )}

          {/* Captured screens. Only shown once there is a choice to make. */}
          {shots.length > 1 ? (
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Captured screens">
              {shots.map((s) => {
                const count = pins.filter((p) => p.shotKey === s.key).length;
                const on = s.key === activeKey;
                return (
                  <div key={s.key} className={`flex items-center rounded-md border ${on ? 'border-primary bg-primary/10' : 'bg-background'}`}>
                    <button
                      type="button" role="tab" aria-selected={on}
                      onClick={() => setActiveKey(s.key)}
                      className="min-h-[44px] px-2.5 text-xs max-w-[160px] truncate"
                      title={s.path}
                    >
                      {s.path}{count ? <span className="ml-1 text-[10px] text-muted-foreground">({count})</span> : null}
                    </button>
                    <button
                      type="button" onClick={() => removeShot(s.key)}
                      aria-label={`Remove ${s.path} and its pins`}
                      className="min-h-[44px] w-9 flex items-center justify-center text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="relative rounded-md border overflow-hidden bg-muted/30">
            {/* The tap surface. Pins commit on pointerUP after a near-stationary
                press, so dragging here scrolls the dialog instead of pinning —
                which is the only way to reach the bottom of a full-page shot on
                a phone. touch-action:pan-y keeps that scroll native. */}
            <div
              className={`relative ${imgState === 'ready' ? 'cursor-crosshair' : ''}`}
              style={{ touchAction: 'pan-y' }}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              role="button"
              aria-label="Tap to add an annotation pin"
              tabIndex={0}
            >
              {activeShot ? (
                <img
                  ref={imgRef}
                  src={activeShot.url}
                  alt={`Screenshot of ${activeShot.path}`}
                  draggable={false}
                  className={`block w-full select-none ${imgState === 'ready' ? '' : 'min-h-[140px] opacity-0'}`}
                />
              ) : <div className="min-h-[140px]" />}
              {imgState === 'ready' ? activePins.map((p) => (
                <span
                  key={p.id}
                  className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white ring-2 ring-white shadow"
                  style={{ left: `${p.x}%`, top: `${p.y}%` }}
                >
                  {numberOf(p.id)}
                </span>
              )) : null}
            </div>
            {imgState === 'loading' ? (
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/70 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Taking a live screenshot…
                {stageMsg ? <span className="block w-full text-center text-[11px] text-muted-foreground">{stageMsg}</span> : null}
              </div>
            ) : null}
            {imgState === 'error' && !activeShot ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-6 text-center text-sm text-muted-foreground">
                <span>Couldn&apos;t screenshot the app{errMsg ? ':' : ' — it may be offline or mid-deploy.'}</span>
                {errMsg ? <span className="text-xs break-words max-w-full">{errMsg}</span> : null}
                <span className="text-xs">Try again in a moment.</span>
              </div>
            ) : null}
          </div>
          {/* A failed capture must not hide the pins already collected on other
              screens — show the error above the work, never instead of it. */}
          {imgState === 'error' && activeShot && errMsg ? (
            <p className="text-xs text-destructive break-words">Couldn&apos;t capture that page: {errMsg}</p>
          ) : null}

          {pins.length ? (
            <div className="space-y-2">
              {pins.map((p) => {
                const shot = shots.find((s) => s.key === p.shotKey);
                return (
                  <div key={p.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveKey(p.shotKey)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-600 text-[11px] font-bold text-white"
                      title={shot ? `Pin ${numberOf(p.id)} on ${shot.path} — show that screen` : undefined}
                      aria-label={`Show the screen for pin ${numberOf(p.id)}`}
                    >
                      {numberOf(p.id)}
                    </button>
                    <div className="flex-1 min-w-0">
                      <Input
                        className="h-11 sm:h-10"
                        value={p.note}
                        onChange={(e) => setNote(p.id, e.target.value)}
                        placeholder="What should change here?"
                        aria-label={`Note for pin ${numberOf(p.id)}`}
                      />
                      {shots.length > 1 && shot ? (
                        <span className="block text-[10px] text-muted-foreground mt-0.5 truncate">{shot.path}</span>
                      ) : null}
                    </div>
                    <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0 text-red-500" onClick={() => removePin(p.id)} aria-label={`Remove pin ${numberOf(p.id)}`}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
              {pins.length >= MAX_PINS ? (
                <p className="text-[11px] text-muted-foreground">That&apos;s the maximum of {MAX_PINS} pins — remove one to add another.</p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No pins yet — tap the screenshot where something should change. Drag to scroll without pinning.</p>
          )}

          {imgState === 'ready' && signedOut && (
            <div className="space-y-2">
              <p className="text-xs text-amber-500">
                {loginEmail.trim()
                  ? 'The sign-in didn’t take (check the email/password — or the app may use a non-standard login flow). Easiest alternative: sign in to the app yourself, screenshot the screen you want, and paste (Ctrl+V) or upload it here — pins work the same.'
                  : 'The app asked for a sign-in, so this shows its sign-in page. Enter your app account below to retake the screenshot signed in (used once for the capture, never stored), annotate the sign-in page as-is, or paste/upload your own screenshot of any screen. Full builds create fixture logins that sign screenshots in automatically.'}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  className="h-11 sm:h-10 flex-1" type="email" value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="app account email"
                  aria-label="App account email for the screenshot sign-in"
                />
                <Input
                  className="h-11 sm:h-10 flex-1" type="password" value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="password"
                  aria-label="App account password for the screenshot sign-in"
                />
                <Button
                  variant="outline" className="h-11 sm:h-10 shrink-0"
                  disabled={!loginEmail.trim() || !loginPassword || imgState === 'loading'}
                  onClick={reload}
                >
                  Retake signed in
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="min-h-[44px] flex-1" disabled={sending || !notedCount} onClick={send}>
              {sending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
              {onApply && attachImage
                ? `Apply ${notedCount || ''} pin${notedCount === 1 ? '' : 's'} to the message`
                : `Send ${notedCount || ''} change${notedCount === 1 ? '' : 's'} as Quick update`}
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
