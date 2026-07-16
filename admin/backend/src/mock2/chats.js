// Mock2 chat data access (mock2_chats + mock2_chat_messages, in mock2.db) —
// Phase M7. One chat row per project (UNIQUE project_id, migration 502); messages
// are append-only with a `kind` (user/assistant/system/… — the concept stage
// uses user/assistant/system) and carry `acting_as_admin` when an admin writes
// inside a project they don't belong to (ADR-007). The chat is the first place a
// project is written to through conversation rather than a canned API call.
//
// The pure decisions (transcript assembly, message shaping) live in
// concept-logic.js so they unit-test without better-sqlite3 (stub-first, risk
// R9); this module is the thin native half. Native (getMock2Db) — reached only
// on an enabled host through the gated router.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';

const nowIso = () => new Date().toISOString();

// The one chat row for a project (may not exist yet).
export function getChat(projectId) {
  return getMock2Db().prepare(`SELECT * FROM mock2_chats WHERE project_id = ?`).get(Number(projectId));
}

// Get the project's chat, creating it on first use (one per project — the UNIQUE
// index makes a concurrent double-create collapse to the existing row).
export function getOrCreateChat(projectId) {
  const db = getMock2Db();
  const existing = getChat(projectId);
  if (existing) return existing;
  try {
    const info = db.prepare(`INSERT INTO mock2_chats (project_id, created_at) VALUES (?, ?)`).run(Number(projectId), nowIso());
    return db.prepare(`SELECT * FROM mock2_chats WHERE id = ?`).get(info.lastInsertRowid);
  } catch {
    // Lost a create race — the row now exists.
    return getChat(projectId);
  }
}

// All messages for a project's chat, oldest first (the poll returns the whole
// list; the frontend does whole-message updates, mirroring the rest of the app).
export function listMessages(projectId, { limit = 500 } = {}) {
  const chat = getChat(projectId);
  if (!chat) return [];
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_chat_messages WHERE chat_id = ? ORDER BY id ASC LIMIT ?`)
    .all(chat.id, Number(limit));
}

export function getMessage(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_chat_messages WHERE id = ?`).get(Number(id));
}

// Append a message. author_user_id is NULL for system/model messages; a human
// message carries the author and (for an admin acting outside their membership)
// acting_as_admin=1 (ADR-007). Creates the chat row on first write.
// `attachments` (migration 526) is the image descriptor list from
// chat-images.saveChatImages — small refs only, bytes live on disk.
// `costCents`/`tokens` (migration 527) stamp what an assistant response cost.
export function insertMessage({ projectId, chatId = null, authorUserId = null, actingAsAdmin = 0, kind, body, questionId = null, cycleId = null, attachments = null, costCents = null, tokens = null }) {
  const db = getMock2Db();
  const cid = chatId != null ? Number(chatId) : getOrCreateChat(projectId).id;
  const info = db
    .prepare(
      `INSERT INTO mock2_chat_messages
         (chat_id, author_user_id, acting_as_admin, kind, body, question_id, cycle_id, created_at, attachments_json, cost_cents, tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(cid, authorUserId, actingAsAdmin ? 1 : 0, kind, String(body ?? ''), questionId, cycleId, nowIso(),
      Array.isArray(attachments) && attachments.length ? JSON.stringify(attachments) : null,
      costCents == null ? null : Number(costCents), tokens == null ? null : Math.round(Number(tokens)));
  return db.prepare(`SELECT * FROM mock2_chat_messages WHERE id = ?`).get(info.lastInsertRowid);
}

export function countMessages(projectId) {
  const chat = getChat(projectId);
  if (!chat) return 0;
  return getMock2Db().prepare(`SELECT COUNT(*) AS n FROM mock2_chat_messages WHERE chat_id = ?`).get(chat.id).n;
}
