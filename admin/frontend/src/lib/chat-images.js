// Client-side image preparation for the multi-modal chat (paste / drag / +).
//
// THE efficiency lever lives here: the browser downscales every image to at
// most MAX_EDGE px on the long edge BEFORE upload — 1568px is the vision
// models' sweet spot (~1.1–1.6k tokens per image; anything larger costs up to
// ~3× the tokens for little quality gain) — and re-encodes to WebP (JPEG
// fallback), so a 12MB phone photo leaves the browser as ~150–400KB. The
// server re-validates (type allowlist, ≤4 per message, 2.5MB decoded cap) but
// in the normal path never sees a heavyweight payload.

export const MAX_CHAT_IMAGES = 4;          // keep in sync with the backend cap
export const MAX_INPUT_FILE_BYTES = 20 * 1024 * 1024; // refuse absurd originals outright
const MAX_EDGE = 1568;                      // long-edge target (token sweet spot)
const QUALITY = 0.85;

const ACCEPTED_INPUT = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function canvasEncode(canvas, type, quality) {
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob((b) => resolve(b), type, quality);
    else resolve(null);
  });
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function decodeToBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  // Fallback decode path (older browsers): object URL + <img>.
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not decode the image')); };
    img.src = url;
  });
}

// prepareChatImage(file) → { media_type, data (bare base64), name, width,
// height, bytes, previewUrl }. Throws with a user-facing message on an
// unusable file. Animated GIFs are passed through untouched below the size cap
// (re-encoding would drop the animation); everything else is downscaled +
// re-encoded.
export async function prepareChatImage(file) {
  if (!file || !ACCEPTED_INPUT.includes(file.type)) {
    throw new Error('Only JPEG, PNG, WebP, or GIF images can be attached.');
  }
  if (file.size > MAX_INPUT_FILE_BYTES) {
    throw new Error(`That image is too large (${Math.round(file.size / 1024 / 1024)}MB — max ${MAX_INPUT_FILE_BYTES / 1024 / 1024}MB).`);
  }

  // GIF: preserve animation by passing through when already small enough.
  if (file.type === 'image/gif' && file.size <= 2_000_000) {
    const data = await blobToBase64(file);
    return {
      media_type: 'image/gif', data, name: file.name || null,
      bytes: file.size, previewUrl: URL.createObjectURL(file),
    };
  }

  const bmp = await decodeToBitmap(file);
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  if (!w || !h) throw new Error('Could not read the image dimensions.');
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, outW, outH);
  if (bmp.close) bmp.close();

  // WebP first (best size at equal quality; every supported provider accepts
  // it); JPEG fallback when the browser can't encode WebP. PNG stays PNG only
  // when it's ALREADY smaller than the lossy re-encode (pixel art, diagrams).
  let blob = await canvasEncode(canvas, 'image/webp', QUALITY);
  let mediaType = 'image/webp';
  if (!blob || blob.type !== 'image/webp') {
    blob = await canvasEncode(canvas, 'image/jpeg', QUALITY);
    mediaType = 'image/jpeg';
  }
  if (!blob) throw new Error('Could not encode the image.');
  if (file.type === 'image/png' && scale === 1 && file.size < blob.size) {
    blob = file;
    mediaType = 'image/png';
  }

  const data = await blobToBase64(blob);
  return {
    media_type: mediaType, data, name: file.name || null,
    width: outW, height: outH, bytes: blob.size,
    previewUrl: URL.createObjectURL(blob),
  };
}

// Extract image files from a paste or drop event (ignores everything else).
export function imageFilesFromDataTransfer(dt) {
  const files = [];
  const list = dt?.files ? Array.from(dt.files) : [];
  for (const f of list) if (ACCEPTED_INPUT.includes(f.type)) files.push(f);
  if (!files.length && dt?.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f && ACCEPTED_INPUT.includes(f.type)) files.push(f);
      }
    }
  }
  return files;
}

// The wire shape the API expects ({media_type, data, name} only).
export function toWireImages(images) {
  return (images || []).map((i) => ({ media_type: i.media_type, data: i.data, ...(i.name ? { name: i.name } : {}) }));
}

// URL for a stored attachment (chat bubbles).
export function chatImageUrl(projectId, attachmentId) {
  return `/api/mock2/projects/${projectId}/chat-images/${attachmentId}`;
}
