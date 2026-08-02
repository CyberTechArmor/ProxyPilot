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

// A tiny composer-preview thumbnail as a data: URL. The admin app's CSP is
// img-src 'self' data: — blob: object URLs are BLOCKED and render as a broken
// image, so previews must be data URLs. At ~112px a JPEG thumb is a few KB;
// transparency is flattened onto white (it's a 56px preview, not the payload).
const THUMB_EDGE = 112;
function thumbDataUrl(bmp, w, h) {
  const scale = Math.min(1, THUMB_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
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

  // GIF: preserve animation by passing through when already small enough. The
  // preview thumb is the (static) first frame; if that decode fails, fall back
  // to the full image as a data URL (CSP allows data:, not blob:).
  if (file.type === 'image/gif' && file.size <= 2_000_000) {
    const data = await blobToBase64(file);
    let previewUrl = `data:image/gif;base64,${data}`;
    try {
      const gifBmp = await decodeToBitmap(file);
      const gw = gifBmp.width || gifBmp.naturalWidth;
      const gh = gifBmp.height || gifBmp.naturalHeight;
      if (gw && gh) previewUrl = thumbDataUrl(gifBmp, gw, gh);
      if (gifBmp.close) gifBmp.close();
    } catch { /* keep the full-image data URL */ }
    return {
      media_type: 'image/gif', data, name: file.name || null,
      bytes: file.size, previewUrl,
    };
  }

  const bmp = await decodeToBitmap(file);
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  if (!w || !h) throw new Error('Could not read the image dimensions.');
  const previewUrl = thumbDataUrl(bmp, w, h);
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
    // The original bytes are kept only when they really are the PNG file.type
    // claims: browsers hand over pasted/re-saved files whose declared type
    // lies (WebP bytes labeled image/png), and the model provider rejects the
    // whole request on the mismatch — check the magic bytes before trusting it.
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
      blob = file;
      mediaType = 'image/png';
    }
  }

  const data = await blobToBase64(blob);
  return {
    media_type: mediaType, data, name: file.name || null,
    width: outW, height: outH, bytes: blob.size,
    previewUrl,
  };
}

// True when this file goes down the chat-image pipeline (vs. the reference
// document / zip path).
export function isChatImageFile(f) {
  return !!f && ACCEPTED_INPUT.includes(f.type);
}

// Split the files of a paste/drop into chat-attachable images and everything
// else (text files and zips headed for the project asset library).
export function partitionFilesFromDataTransfer(dt) {
  const all = [];
  const list = dt?.files ? Array.from(dt.files) : [];
  for (const f of list) all.push(f);
  if (!all.length && dt?.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) all.push(f);
      }
    }
  }
  const images = [];
  const others = [];
  for (const f of all) (isChatImageFile(f) ? images : others).push(f);
  return { images, others };
}

// The wire shape the API expects ({media_type, data, name} only).
export function toWireImages(images) {
  return (images || []).map((i) => ({ media_type: i.media_type, data: i.data, ...(i.name ? { name: i.name } : {}) }));
}

// URL for a stored attachment (chat bubbles).
export function chatImageUrl(projectId, attachmentId) {
  return `/api/mock2/projects/${projectId}/chat-images/${attachmentId}`;
}
