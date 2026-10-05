import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { Action } from './shared';
import { LIVE_TEXT } from './agent-run-text';
import { createLiveClient, liveUrl } from './live-client';
import { encodeButton, encodeKey, encodeMove, encodeScroll, keysymFor, screenPoint, scrollSteps } from './live-input';

// A7 live view in the run deck's Browser pane: the running browser as video
// (Neko over WebRTC through the TURN relay), watched by anyone with run access.
// While this view holds control (a takeover the server handed to it), the
// pointer, wheel and keyboard over the video go to that browser over Neko's
// data channel, and nothing else: no clipboard, no files, no chat. What is
// typed never leaves this page except as key events to that browser; only the
// count of keys, clicks and scrolls is recorded (by the runner in the VM).
export function LiveBrowser({ base, runId, endpoint, expanded = false, onState, onControl, onViewer }) {
  const box = useRef(null), video = useRef(null), typing = useRef(null), client = useRef(null);
  const [state, setState] = useState('connecting'), [control, setControl] = useState({ hasHost: false, mine: false });
  const screen = useRef({ width: 1280, height: 800 }), pressed = useRef(new Set()), moving = useRef(null);
  const report = useRef({ onState, onControl, onViewer }), videoReady = useRef(null);
  useEffect(() => { report.current = { onState, onControl, onViewer }; }, [onState, onControl, onViewer]);

  useEffect(() => {
    // A client closed by this effect's own cleanup (leaving the page, or
    // React's development double mount) reports nothing: only a connection
    // that ended by itself makes the page fall back to still frames.
    let disposed = false, playing = false;
    // A connected peer is not proof that video is visible. Keep the fallback
    // deadline until the video element decodes a frame, including stuck peers.
    const deadline = setTimeout(() => {
      if (disposed || playing) return;
      live.close(); setState('failed'); report.current.onState?.('failed', { reason: 'video_frame_timeout' }); report.current.onViewer?.(null);
    }, 20000);
    const live = createLiveClient({
      url: endpoint ?? liveUrl(base, runId),
      onState: (name, detail) => {
        if (disposed) return;
        if (name === 'live' && !playing) return;
        if (['failed', 'unavailable', 'closed'].includes(name)) clearTimeout(deadline);
        setState(name);
        report.current.onState?.(name, detail);
        report.current.onViewer?.(name === 'live' ? live.viewer : null);
      },
      onStream: (stream, track) => {
        if (disposed || !video.current) return;
        video.current.srcObject = stream ?? new MediaStream([track]);
        video.current.play?.().catch(() => {});
      },
      onControl: (next) => { if (!disposed) { setControl(next); report.current.onControl?.(next); } },
      onScreen: (size) => { screen.current = { width: size.width, height: size.height }; },
    });
    videoReady.current = () => {
      if (disposed || playing || !video.current || video.current.readyState < 2 || !video.current.videoWidth) return;
      playing = true; clearTimeout(deadline); setState('live'); report.current.onState?.('live', { reason: 'decoded_video' }); report.current.onViewer?.(live.viewer);
    };
    client.current = live;
    live.start();
    return () => { disposed = true; clearTimeout(deadline); videoReady.current = null; live.close(); client.current = null; };
  }, [base, runId, endpoint]);

  const send = useCallback(buffer => client.current?.input(buffer) ?? false, []);
  const point = useCallback((event) => {
    const rect = video.current?.getBoundingClientRect();
    return rect ? screenPoint(event.clientX, event.clientY, rect, screen.current) : null;
  }, []);
  // Keys still held when focus leaves are released, so none stays stuck.
  const releaseAll = useCallback(() => {
    for (const keysym of pressed.current) send(encodeKey(false, keysym));
    pressed.current.clear();
  }, [send]);
  useEffect(() => { if (!control.mine) releaseAll(); else box.current?.focus(); }, [control.mine, releaseAll]);

  // The wheel needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = box.current;
    if (!el || !control.mine) return undefined;
    const wheel = (event) => {
      event.preventDefault();
      const { dx, dy } = scrollSteps(event);
      if (dx || dy) send(encodeScroll(dx, dy, event.ctrlKey));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [control.mine, send]);

  const handlers = control.mine ? {
    onPointerMove: (event) => {
      const at = point(event);
      if (!at) return;
      moving.current = at;
      requestAnimationFrame(() => { if (moving.current) { send(encodeMove(moving.current.x, moving.current.y)); moving.current = null; } });
    },
    onPointerDown: (event) => {
      const at = point(event);
      if (!at) return;
      event.preventDefault();
      box.current?.focus();
      send(encodeMove(at.x, at.y));
      send(encodeButton(true, event.button));
    },
    onPointerUp: (event) => { if (point(event)) send(encodeButton(false, event.button)); },
    onContextMenu: event => event.preventDefault(),
    onKeyDown: (event) => {
      const keysym = keysymFor(event);
      if (keysym === null) return;
      event.preventDefault();
      pressed.current.add(keysym);
      send(encodeKey(true, keysym));
    },
    onKeyUp: (event) => {
      const keysym = keysymFor(event);
      if (keysym === null) return;
      event.preventDefault();
      pressed.current.delete(keysym);
      send(encodeKey(false, keysym));
    },
    onBlur: releaseAll,
  } : {};

  // A phone's on-screen keyboard: what it types arrives as input events on a
  // hidden field, sent as key presses and cleared at once (never kept).
  const onTyped = (event) => {
    const { inputType, data } = event.nativeEvent;
    if (inputType === 'deleteContentBackward') { send(encodeKey(true, 0xff08)); send(encodeKey(false, 0xff08)); }
    else if (inputType === 'insertLineBreak') { send(encodeKey(true, 0xff0d)); send(encodeKey(false, 0xff0d)); }
    else for (const char of data ?? '') {
      const keysym = keysymFor({ key: char });
      if (keysym !== null) { send(encodeKey(true, keysym)); send(encodeKey(false, keysym)); }
    }
    event.target.value = '';
  };

  return <div className={expanded ? 'flex min-h-0 flex-1 flex-col gap-2' : 'space-y-2'}>
    <div ref={box} tabIndex={control.mine ? 0 : -1} {...handlers}
      aria-label={control.mine ? LIVE_TEXT.controlArea : LIVE_TEXT.videoArea} role={control.mine ? 'application' : undefined}
      className={`relative w-full ${expanded ? 'min-h-0 flex-1' : 'aspect-[16/10] shrink-0'} overflow-hidden rounded-md bg-zinc-950 focus-visible:outline-none ${control.mine ? 'touch-none ring-2 ring-emerald-500 cursor-default' : 'touch-pan-y'}`}
      data-testid="live-browser" data-live-state={state} data-control={control.mine ? 'mine' : control.hasHost ? 'held' : 'none'}>
      <video ref={video} onPlaying={() => videoReady.current?.()} muted playsInline autoPlay aria-label={LIVE_TEXT.videoLabel}
        className="absolute inset-0 h-full w-full object-contain pointer-events-none"/>
      {state !== 'live' && <p role="status" className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-zinc-300">
        {LIVE_TEXT.state[state] ?? LIVE_TEXT.state.connecting}</p>}
    </div>
    {control.mine && <div className="flex flex-wrap items-center gap-2">
      <Action variant="outline" className="gap-2 sm:hidden" onClick={() => typing.current?.focus()}>
        <Keyboard aria-hidden="true" className="h-4 w-4"/>{LIVE_TEXT.keyboard}</Action>
      <input ref={typing} aria-label={LIVE_TEXT.keyboardField} autoComplete="off" autoCapitalize="none" autoCorrect="off"
        spellCheck={false} onInput={onTyped} className="sr-only"/>
      <p className="text-sm text-muted-foreground">{LIVE_TEXT.controlHint}</p>
    </div>}
  </div>;
}
