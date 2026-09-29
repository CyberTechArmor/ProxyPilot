// A7 live view: what the dashboard's own Neko client sends over the WebRTC data
// channel while its viewer holds control (user decision 1c). Pure, no React, so
// admin/backend's node:test covers it (agent-live-input.test.js). The format is
// Neko's own (server/internal/webrtc/payload, pinned commit 3f4f9408): a header
// of one byte (the op) and a big-endian uint16 payload length, then the payload.
// Neko applies input only from the session it has given control to; the input
// never passes through the backend, and only the count of keys, clicks and
// scrolls is ever recorded (by the runner in the VM), never what was typed.
export const OP = Object.freeze({ MOVE: 0x01, SCROLL: 0x02, KEY_DOWN: 0x03, KEY_UP: 0x04, BTN_DOWN: 0x05, BTN_UP: 0x06 });

function frame(op, length, write) {
  const buffer = new ArrayBuffer(3 + length);
  const view = new DataView(buffer);
  view.setUint8(0, op);
  view.setUint16(1, length);
  write(view);
  return buffer;
}
const clampU16 = n => Math.max(0, Math.min(0xffff, Math.round(n)));
const clampI16 = n => Math.max(-0x8000, Math.min(0x7fff, Math.round(n)));

export const encodeMove = (x, y) => frame(OP.MOVE, 4, v => { v.setUint16(3, clampU16(x)); v.setUint16(5, clampU16(y)); });
// Neko's current scroll payload: deltaX, deltaY (int16) and the control key.
export const encodeScroll = (dx, dy, control = false) => frame(OP.SCROLL, 5, v => {
  v.setInt16(3, clampI16(dx)); v.setInt16(5, clampI16(dy)); v.setUint8(7, control ? 1 : 0);
});
export const encodeKey = (down, keysym) => frame(down ? OP.KEY_DOWN : OP.KEY_UP, 4, v => v.setUint32(3, keysym >>> 0));
// X buttons: 1 left, 2 middle, 3 right (a DOM MouseEvent.button is 0, 1, 2).
export const encodeButton = (down, domButton) => frame(down ? OP.BTN_DOWN : OP.BTN_UP, 4,
  v => v.setUint32(3, ({ 0: 1, 1: 2, 2: 3 })[domButton] ?? 1));

// A point on the shown video, in the remote screen's pixels. The video is shown
// with object-contain, so the letterbox bands around it map to nothing (null).
export function screenPoint(clientX, clientY, rect, screen) {
  if (!rect?.width || !rect?.height || !screen?.width || !screen?.height) return null;
  const scale = Math.min(rect.width / screen.width, rect.height / screen.height);
  const shownW = screen.width * scale, shownH = screen.height * scale;
  const left = rect.left + (rect.width - shownW) / 2, top = rect.top + (rect.height - shownH) / 2;
  const x = (clientX - left) / scale, y = (clientY - top) / scale;
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return null;
  return { x: Math.floor(x), y: Math.floor(y) };
}

// Wheel deltas arrive in pixels, lines or pages; Neko scrolls in steps.
export function scrollSteps(event) {
  const unit = event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? 10 : 1 / 40;
  const step = d => (d === 0 ? 0 : Math.sign(d) * Math.max(1, Math.min(10, Math.round(Math.abs(d * unit)))));
  return { dx: step(event.deltaX), dy: step(event.deltaY) };
}

// X keysyms for DOM KeyboardEvent.key. Named keys come from the table; a
// printable character is its Latin-1 code (keysyms 0x20-0xff equal Unicode) or
// 0x01000000 + its code point. Anything else is not sent (null).
const NAMED = Object.freeze({
  Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff, Home: 0xff50, ArrowLeft: 0xff51,
  ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, PageUp: 0xff55, PageDown: 0xff56, End: 0xff57,
  Insert: 0xff63, CapsLock: 0xffe5, NumLock: 0xff7f, ContextMenu: 0xff67,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3, F7: 0xffc4, F8: 0xffc5, F9: 0xffc6,
  F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
});
const SIDED = Object.freeze({ Shift: [0xffe1, 0xffe2], Control: [0xffe3, 0xffe4], Alt: [0xffe9, 0xffea],
  Meta: [0xffeb, 0xffec], AltGraph: [0xfe03, 0xfe03] });
export function keysymFor(event) {
  const key = event?.key;
  if (typeof key !== 'string' || !key || key === 'Unidentified' || key === 'Dead' || key === 'Process') return null;
  if (NAMED[key]) return NAMED[key];
  if (SIDED[key]) return SIDED[key][event.location === 2 ? 1 : 0];
  const chars = [...key];
  if (chars.length !== 1) return null;
  const code = chars[0].codePointAt(0);
  if (code < 0x20 || code === 0x7f) return null;
  return code <= 0xff ? code : 0x01000000 + code;
}
