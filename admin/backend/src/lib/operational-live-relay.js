// A7 live relay, backend side: what may cross between a dashboard viewer and
// the Neko instance inside the proof VM. It repeats the runner's own allowlists
// (scripts/a3-worker-guest.py LIVE_FROM_VIEWER / LIVE_TO_VIEWER) so that
// neither side depends on the other to filter: only WebRTC signalling crosses.
// Input never travels this way (Neko takes it over the WebRTC data channel, and
// only from the viewer it has given control to); chat, clipboard, members,
// screen changes and admin events never cross in either direction.
export const FROM_VIEWER = Object.freeze(['client/heartbeat', 'signal/request', 'signal/answer', 'signal/candidate',
  'signal/restart', 'signal/video']);
export const TO_VIEWER = Object.freeze(['system/init', 'system/disconnect', 'system/heartbeat', 'signal/provide',
  'signal/offer', 'signal/answer', 'signal/candidate', 'signal/restart', 'signal/close', 'signal/video',
  'control/host', 'control/release', 'screen/updated']);
// An SDP is a few kB; a candidate far less. Anything bigger is not signalling.
export const MAX_MESSAGE_BYTES = 64 * 1024;
// Per viewer, per second, from the browser (the supervisor allows 60).
export const MAX_VIEWER_RATE = 40;
const INIT_FIELDS = ['session_id', 'control_host', 'screen_size', 'webrtc'];

// One relayed message, or null: an allowed event with an absent or object
// payload, within the size bound. The viewer's system/init names only its own
// session, the control holder and the screen; a provide carries no ICE servers
// (the dashboard gives each viewer its own short-lived TURN credential).
export function filterMessage(message, allowed) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (Object.keys(message).some(key => key !== 'event' && key !== 'payload')) return null;
  if (!allowed.includes(message.event)) return null;
  const payload = message.payload;
  if (payload !== undefined && payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) return null;
  const out = { event: message.event };
  if (payload && typeof payload === 'object') {
    let copy = { ...payload };
    if (message.event === 'system/init') copy = Object.fromEntries(INIT_FIELDS.filter(k => k in copy).map(k => [k, copy[k]]));
    else if (message.event === 'signal/provide') delete copy.iceservers;
    out.payload = copy;
  }
  let size;
  try { size = Buffer.byteLength(JSON.stringify(out)); } catch { return null; }
  return size <= MAX_MESSAGE_BYTES ? out : null;
}
export const fromViewer = message => filterMessage(message, FROM_VIEWER);
export const toViewer = message => filterMessage(message, TO_VIEWER);
