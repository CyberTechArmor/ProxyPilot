// Mock2 chat-image storage — the filesystem half (the pure validation/shaping
// lives in chat-image-logic.js). Images pasted/dropped into a chat are stored
// ONCE on the host disk, content-addressed:
//
//   ${MOCK2_DATA_DIR}/chat-images/<projectId>/<sha256>.<ext>
//
// so the DB carries only small descriptors ({id, bytes, name} in
// attachments_json), a re-pasted image dedupes to the same file, and serving
// bytes to the browser is a sendFile with immutable caching — never a base64
// round-trip through SQLite. Images never enter the project container (they
// are model-call context, like the framework constitution).
//
// Terminology (risk R7): nothing here is named "agent".

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  extForMediaType, mediaTypeForExt, isChatImageId,
  planTranscriptImages, parseAttachmentsJson, attachmentPlaceholder,
} from './chat-image-logic.js';

// Same resolution as provision.js — duplicated (like firewall.js does) so this
// module stays importable without the native DB stack behind provision.js.
const MOCK2_DATA_DIR = process.env.MOCK2_DATA_DIR || '/var/lib/proxypilot/mock2';

export function chatImagesDir(projectId) {
  return path.join(MOCK2_DATA_DIR, 'chat-images', String(Number(projectId)));
}

// Absolute path for a stored image — null unless the id matches the strict
// content-addressed shape (the only traversal defense needed: no user input
// beyond a validated "<sha256>.<ext>" ever reaches path.join).
export function chatImagePath(projectId, id) {
  if (!isChatImageId(id)) return null;
  return path.join(chatImagesDir(projectId), id);
}

// saveChatImages — persist validated images (chat-image-logic.validateChatImages
// output) for a project. Content-addressed write: an image already on disk is
// not rewritten. Returns descriptor list [{ id, media_type, bytes, name }].
export function saveChatImages(projectId, images = []) {
  if (!images.length) return [];
  const dir = chatImagesDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const img of images) {
    const buf = Buffer.from(img.data, 'base64');
    const ext = extForMediaType(img.media_type) || 'jpg';
    const id = `${crypto.createHash('sha256').update(buf).digest('hex')}.${ext}`;
    const file = path.join(dir, id);
    if (!fs.existsSync(file)) {
      // Write via a temp name + rename so a crash never leaves a torn file
      // behind a content hash that claims integrity.
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
    }
    out.push({ id, media_type: img.media_type, bytes: buf.length, name: img.name || null });
  }
  return out;
}

// readChatImage — bytes for one stored image. Returns { media_type, buffer }
// or null (missing / invalid id).
export function readChatImage(projectId, id) {
  const file = chatImagePath(projectId, id);
  if (!file) return null;
  try {
    const buffer = fs.readFileSync(file);
    return { media_type: mediaTypeForExt(id.split('.').pop()) || 'application/octet-stream', buffer };
  } catch { return null; }
}

// hydrateAttachments — descriptor list → model-call image list
// [{ media_type, data(base64) }]. Missing files drop out silently (a deleted
// project dir must not fail an unrelated model call).
export function hydrateAttachments(projectId, attachments = []) {
  const out = [];
  for (const a of attachments || []) {
    const img = readChatImage(projectId, a?.id);
    if (img) out.push({ media_type: img.media_type, data: img.buffer.toString('base64') });
  }
  return out;
}

// hydrateChatMessagesForModel — prepare chat rows for buildConceptTranscript:
// user rows with attachments gain `images` (real bytes) for the attachments in
// the hydration window (the MAX_TRANSCRIPT_IMAGES most recent — efficiency:
// old screenshots stop riding every request) and `imagePlaceholders` (a stable
// text note) for the rest. Non-mutating.
export function hydrateChatMessagesForModel(projectId, messages = []) {
  const plan = planTranscriptImages(messages);
  if (plan.size === 0 && !(messages || []).some((m) => m?.attachments_json)) return messages;
  return (messages || []).map((m) => {
    if (!m || m.kind !== 'user' || !m.attachments_json) return m;
    const atts = parseAttachmentsJson(m.attachments_json);
    if (!atts.length) return m;
    const images = [];
    const placeholders = [];
    for (const a of atts) {
      if (plan.has(`${m.id}:${a.id}`)) {
        const img = readChatImage(projectId, a.id);
        if (img) { images.push({ media_type: img.media_type, data: img.buffer.toString('base64') }); continue; }
      }
      placeholders.push(attachmentPlaceholder(a));
    }
    return { ...m, images, imagePlaceholders: placeholders.length ? placeholders.join('\n') : null };
  });
}
