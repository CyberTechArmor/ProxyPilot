// useTypingTracker — measure ACTIVE typing time in a chat composer and flush it
// to the backend as accumulated seconds (project time tracking).
//
// "Active typing" = the wall-clock spent between consecutive keystrokes that are
// close together. Each keystroke that lands within IDLE_GAP of the previous one
// adds that gap to the accumulator; a longer pause (thinking, reading, away) does
// not count. The accumulator is flushed every FLUSH_MS and on unmount so a closed
// tab doesn't lose the tail.
//
// Returns `onActivity` — call it from the composer's onChange/onKeyDown.

import { useCallback, useEffect, useRef } from 'react';
import { api } from '@/lib/api';

const IDLE_GAP_MS = 4000;  // a gap longer than this is a pause, not typing
const FLUSH_MS = 15000;    // push accumulated seconds at most this often

export function useTypingTracker(projectId, enabled = true) {
  const lastRef = useRef(0);
  const accMsRef = useRef(0);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  const flush = useCallback(() => {
    const secs = Math.floor(accMsRef.current / 1000);
    if (secs < 1 || !projectRef.current) return;
    accMsRef.current -= secs * 1000; // keep the sub-second remainder
    api.mock2AddTyping(projectRef.current, secs).catch(() => { /* best effort */ });
  }, []);

  const onActivity = useCallback(() => {
    if (!enabled) return;
    const now = Date.now();
    const gap = now - lastRef.current;
    if (lastRef.current !== 0 && gap > 0 && gap <= IDLE_GAP_MS) {
      accMsRef.current += gap;
    }
    lastRef.current = now;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const t = setInterval(flush, FLUSH_MS);
    return () => { clearInterval(t); flush(); };
  }, [enabled, flush]);

  return onActivity;
}
