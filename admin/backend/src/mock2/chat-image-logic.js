// Mock2 chat-image PURE decision layer — validation and shaping for the
// multi-modal chat (images pasted/dropped/picked into the concept chat, the
// build composer, and the ask lane). Native-free, unit-tested stub-first
// (risk R9): no fs, no network, no DB.
//
// Efficiency is designed in end to end:
//   * The BROWSER downscales before upload (lib/chat-images.js): max 1568px on
//     the long edge — the vision models' token sweet spot (~1.1–1.6k tokens per
//     image; larger costs up to ~3× for little gain) — re-encoded WebP/JPEG.
//   * The server accepts at most MAX_CHAT_IMAGES per message and
//     MAX_CHAT_IMAGE_BYTES per image (a decoded cap, not a base64 cap), so a
//     bypassed client still can't stuff megabytes into a model call.
//   * Bytes are stored ON DISK once (sha256-addressed, deduped) — never base64
//     in SQLite; chat rows carry only small attachment descriptors.
//   * Model transcripts replay at most MAX_TRANSCRIPT_IMAGES most-recent images
//     (older turns keep a stable text placeholder), and the Anthropic prompt
//     cache makes replayed images ~0.1× after the first turn.
//
// Terminology (risk R7): nothing here is named "agent".

// Media types every supported vision provider accepts (Anthropic / OpenAI /
// Gemini all take jpeg, png, webp, gif).
export const CHAT_IMAGE_MEDIA_TYPES = Object.freeze([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

export const MAX_CHAT_IMAGES = 4;            // per message
export const MAX_CHAT_IMAGE_BYTES = 2_500_000; // decoded bytes per image (the client sends ~100–500KB after downscale)
export const MAX_TRANSCRIPT_IMAGES = 6;      // most-recent images replayed to the model in a chat history

const EXT_BY_MEDIA_TYPE = Object.freeze({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
});
const MEDIA_TYPE_BY_EXT = Object.freeze({
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
});

export function extForMediaType(mediaType) {
  return EXT_BY_MEDIA_TYPE[String(mediaType || '').toLowerCase()] || null;
}
export function mediaTypeForExt(ext) {
  return MEDIA_TYPE_BY_EXT[String(ext || '').toLowerCase()] || null;
}

// An attachment id is content-addressed: "<sha256 hex>.<ext>". Everything that
// serves or reads an image validates against this exact shape (no traversal).
const IMAGE_ID_RE = /^[a-f0-9]{64}\.(jpg|png|webp|gif)$/;
export function isChatImageId(id) {
  return typeof id === 'string' && IMAGE_ID_RE.test(id);
}

// Rough decoded size of a base64 string without decoding it.
export function base64DecodedBytes(b64) {
  const s = String(b64 || '');
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - padding);
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// validateChatImages — the request-side gate. `images` is the raw array from
// the client: [{ media_type, data (bare base64, NO data: prefix), name? }].
// Returns { ok, images:[{ media_type, data, name }], error }.
export function validateChatImages(images) {
  if (images == null) return { ok: true, images: [] };
  if (!Array.isArray(images)) return { ok: false, error: 'images must be an array' };
  if (images.length === 0) return { ok: true, images: [] };
  if (images.length > MAX_CHAT_IMAGES) {
    return { ok: false, error: `too many images — at most ${MAX_CHAT_IMAGES} per message` };
  }
  const out = [];
  for (const [i, img] of images.entries()) {
    if (!img || typeof img !== 'object') return { ok: false, error: `image ${i + 1}: not an object` };
    const mediaType = String(img.media_type || '').toLowerCase();
    if (!CHAT_IMAGE_MEDIA_TYPES.includes(mediaType)) {
      return { ok: false, error: `image ${i + 1}: unsupported type "${mediaType.slice(0, 40)}" (use JPEG, PNG, WebP, or GIF)` };
    }
    let data = String(img.data || '');
    // Tolerate a data: URL from a naive client — strip to the bare base64.
    const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
    if (comma >= 0) data = data.slice(comma + 1);
    data = data.replace(/\s+/g, '');
    if (!data) return { ok: false, error: `image ${i + 1}: empty` };
    if (!BASE64_RE.test(data)) return { ok: false, error: `image ${i + 1}: not valid base64` };
    const bytes = base64DecodedBytes(data);
    if (bytes > MAX_CHAT_IMAGE_BYTES) {
      return { ok: false, error: `image ${i + 1}: too large (${Math.round(bytes / 1024)}KB > ${Math.round(MAX_CHAT_IMAGE_BYTES / 1024)}KB) — the app resizes images before upload; try re-attaching` };
    }
    out.push({ media_type: mediaType, data, name: img.name ? String(img.name).slice(0, 120) : null });
  }
  return { ok: true, images: out };
}

// ---- attachment descriptors (what chat rows / request rows carry) ----

// parseAttachmentsJson — attachments_json column → validated descriptor list
// [{ id, media_type, bytes, name }]. Never throws; unknown shapes drop out.
export function parseAttachmentsJson(json) {
  let doc;
  try { doc = JSON.parse(json || 'null'); } catch { return []; }
  if (!Array.isArray(doc)) return [];
  return doc
    .filter((a) => a && typeof a === 'object' && isChatImageId(a.id))
    .map((a) => ({
      id: a.id,
      media_type: mediaTypeForExt(a.id.split('.').pop()) || 'image/jpeg',
      bytes: Number(a.bytes) || 0,
      name: a.name ? String(a.name).slice(0, 120) : null,
    }));
}

// Client-safe attachment shape (the frontend builds the image URL from the id).
export function publicAttachmentShape(a) {
  if (!a || !isChatImageId(a.id)) return null;
  return { id: a.id, media_type: a.media_type, name: a.name || null };
}

// ---- transcript hydration planning (which history images replay) ----
//
// Given chat messages oldest-first, decide which attachments are replayed to
// the model as real image blocks vs a stable placeholder. Only the most recent
// MAX_TRANSCRIPT_IMAGES ride along — older ones would grow every request for
// diminishing relevance. Returns a Set of "messageId:attachmentId" keys to
// hydrate; the caller reads bytes for exactly those.
export function planTranscriptImages(messages = [], { max = MAX_TRANSCRIPT_IMAGES } = {}) {
  const keys = [];
  for (const m of messages || []) {
    if (!m || m.kind !== 'user') continue;
    for (const a of parseAttachmentsJson(m.attachments_json)) keys.push(`${m.id}:${a.id}`);
  }
  return new Set(keys.slice(-Math.max(0, max)));
}

// The stable placeholder used for a NOT-hydrated attachment. Deterministic per
// attachment (cache-friendly: the same turn renders byte-identically until the
// hydration window moves past it).
export function attachmentPlaceholder(a) {
  return `[image attachment ${a?.name ? `"${a.name}" ` : ''}(${a?.id ? a.id.slice(0, 12) : 'unknown'}…) — not included in this context]`;
}
