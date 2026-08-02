// Multi-modal chat — the pure image layer (chat-image-logic.js): request
// validation (type allowlist, count/size caps, base64 integrity), attachment
// descriptor parsing, and the transcript hydration plan (which history images
// replay vs placeholder).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_IMAGE_MEDIA_TYPES, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, MAX_TRANSCRIPT_IMAGES,
  extForMediaType, mediaTypeForExt, isChatImageId, base64DecodedBytes,
  validateChatImages, parseAttachmentsJson, publicAttachmentShape,
  planTranscriptImages, attachmentPlaceholder, sniffImageMediaType,
} from '../mock2/chat-image-logic.js';

const PNG_B64 = Buffer.from('fake png bytes').toString('base64');
const HASH = 'a'.repeat(64);

// ---- ids and types ----

test('media type ↔ extension mapping round-trips', () => {
  for (const mt of CHAT_IMAGE_MEDIA_TYPES) {
    const ext = extForMediaType(mt);
    assert.ok(ext, mt);
    assert.equal(mediaTypeForExt(ext), mt);
  }
  assert.equal(extForMediaType('image/svg+xml'), null); // SVG is NOT accepted (scriptable)
  assert.equal(mediaTypeForExt('exe'), null);
});

test('isChatImageId: strict content-addressed shape only', () => {
  assert.equal(isChatImageId(`${HASH}.png`), true);
  assert.equal(isChatImageId(`${HASH}.webp`), true);
  assert.equal(isChatImageId(`${HASH}.svg`), false);
  assert.equal(isChatImageId(`../../etc/passwd`), false);
  assert.equal(isChatImageId(`${'A'.repeat(64)}.png`), false); // uppercase hex rejected
  assert.equal(isChatImageId(null), false);
});

test('base64DecodedBytes: accounts for padding', () => {
  assert.equal(base64DecodedBytes(Buffer.from('abc').toString('base64')), 3);
  assert.equal(base64DecodedBytes(Buffer.from('abcd').toString('base64')), 4);
  assert.equal(base64DecodedBytes(''), 0);
});

// ---- request validation ----

test('validateChatImages: accepts a clean payload, strips a data: prefix', () => {
  const r = validateChatImages([
    { media_type: 'image/png', data: PNG_B64, name: 'shot.png' },
    { media_type: 'image/jpeg', data: `data:image/jpeg;base64,${PNG_B64}` },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.images.length, 2);
  assert.equal(r.images[1].data, PNG_B64); // prefix stripped
  assert.equal(r.images[0].name, 'shot.png');
});

test('validateChatImages: null/empty are fine (no images)', () => {
  assert.deepEqual(validateChatImages(null), { ok: true, images: [] });
  assert.deepEqual(validateChatImages([]), { ok: true, images: [] });
});

test('validateChatImages: rejects bad type, bad base64, oversize, too many', () => {
  assert.equal(validateChatImages([{ media_type: 'image/svg+xml', data: PNG_B64 }]).ok, false);
  assert.equal(validateChatImages([{ media_type: 'image/png', data: 'not base64!!!' }]).ok, false);
  const big = 'A'.repeat(Math.ceil((MAX_CHAT_IMAGE_BYTES + 1024) * 4 / 3 / 4) * 4);
  assert.match(validateChatImages([{ media_type: 'image/png', data: big }]).error, /too large/);
  const many = Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => ({ media_type: 'image/png', data: PNG_B64 }));
  assert.match(validateChatImages(many).error, /too many/);
});

// ---- attachment descriptors ----

test('parseAttachmentsJson: valid rows survive, junk drops, never throws', () => {
  const json = JSON.stringify([
    { id: `${HASH}.webp`, bytes: 1234, name: 'ref.webp' },
    { id: '../evil', bytes: 1 },
    'garbage',
  ]);
  const atts = parseAttachmentsJson(json);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].media_type, 'image/webp');
  assert.deepEqual(parseAttachmentsJson('not json'), []);
  assert.deepEqual(parseAttachmentsJson(null), []);
});

test('publicAttachmentShape: id + media_type + name only', () => {
  const s = publicAttachmentShape({ id: `${HASH}.jpg`, media_type: 'image/jpeg', bytes: 99, name: 'x' });
  assert.deepEqual(s, { id: `${HASH}.jpg`, media_type: 'image/jpeg', name: 'x' });
  assert.equal(publicAttachmentShape({ id: 'bogus' }), null);
});

// ---- transcript hydration plan ----

test('planTranscriptImages: keeps only the most recent images across turns', () => {
  // 3 turns × 3 images = 9 attachments; only the last MAX_TRANSCRIPT_IMAGES stay.
  const messages = [];
  for (let t = 0; t < 3; t += 1) {
    const atts = Array.from({ length: 3 }, (_, i) => ({ id: `${String(t).repeat(32)}${String(i).repeat(32)}.png`, bytes: 1 }));
    messages.push({ id: t + 1, kind: 'user', attachments_json: JSON.stringify(atts) });
  }
  const plan = planTranscriptImages(messages);
  assert.equal(plan.size, MAX_TRANSCRIPT_IMAGES);
  // The newest turn's images are all in the plan; the oldest turn's are not.
  const newest = parseAttachmentsJson(messages[2].attachments_json);
  for (const a of newest) assert.ok(plan.has(`3:${a.id}`));
  const oldest = parseAttachmentsJson(messages[0].attachments_json);
  assert.ok(oldest.some((a) => !plan.has(`1:${a.id}`)));
});

test('planTranscriptImages: assistant/system rows never hydrate', () => {
  const plan = planTranscriptImages([
    { id: 1, kind: 'assistant', attachments_json: JSON.stringify([{ id: `${HASH}.png`, bytes: 1 }]) },
  ]);
  assert.equal(plan.size, 0);
});

test('attachmentPlaceholder: stable and readable', () => {
  const a = { id: `${HASH}.png`, name: 'design.png' };
  const p1 = attachmentPlaceholder(a);
  assert.equal(p1, attachmentPlaceholder(a)); // deterministic (cache-friendly)
  assert.match(p1, /design\.png/);
  assert.match(attachmentPlaceholder(null), /unknown/);
});

// ---- magic-byte sniffing (the browser's declared type can lie) ----

// Real file headers, padded so the base64 head decodes cleanly.
const REAL_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]).toString('base64');
const REAL_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24)]).toString('base64');
const REAL_GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(24)]).toString('base64');
const REAL_WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(20)]).toString('base64');

test('sniffImageMediaType: identifies each supported format from its magic bytes', () => {
  assert.equal(sniffImageMediaType(REAL_PNG), 'image/png');
  assert.equal(sniffImageMediaType(REAL_JPEG), 'image/jpeg');
  assert.equal(sniffImageMediaType(REAL_GIF), 'image/gif');
  assert.equal(sniffImageMediaType(REAL_WEBP), 'image/webp');
  // Unknown bytes → null (caller keeps the declared type).
  assert.equal(sniffImageMediaType(Buffer.from('not an image at all').toString('base64')), null);
  assert.equal(sniffImageMediaType(''), null);
  assert.equal(sniffImageMediaType(null), null);
});

test('validateChatImages: the bytes win over a lying declared type', () => {
  // The reported failure: WebP bytes declared image/png (a browser clipboard
  // paste) — Anthropic 400s the whole model call on the mismatch.
  const r = validateChatImages([{ media_type: 'image/png', data: REAL_WEBP }]);
  assert.equal(r.ok, true);
  assert.equal(r.images[0].media_type, 'image/webp');
  // A truthful declaration is kept as-is.
  const r2 = validateChatImages([{ media_type: 'image/png', data: REAL_PNG }]);
  assert.equal(r2.images[0].media_type, 'image/png');
  // Unsniffable bytes keep the declared type (existing behaviour).
  const r3 = validateChatImages([{ media_type: 'image/jpeg', data: PNG_B64 }]);
  assert.equal(r3.images[0].media_type, 'image/jpeg');
});
