'use strict';
const store = require('./store');
const { uuid } = require('./util');

// Records an immutable-ish audit event. Never store plaintext secrets here.
function record(event) {
  const db = store.get();
  const entry = {
    id: uuid(),
    ts: new Date().toISOString(),
    action: event.action,
    actorId: event.actorId || null,
    actorLabel: event.actorLabel || null,
    targetId: event.targetId || null,
    targetLabel: event.targetLabel || null,
    provider: event.provider || null,
    reason: event.reason || null,
    outcome: event.outcome || null,
    ip: event.ip || null,
    userAgent: event.userAgent ? String(event.userAgent).slice(0, 256) : null,
    meta: event.meta || null
  };
  db.audit.push(entry);
  // The in-memory list is a recent WINDOW for list(); the audit table is the
  // permanent archive. Trimming here must never delete history, so the row is
  // appended directly rather than by rewriting the section from memory.
  if (db.audit.length > 5000) db.audit.splice(0, db.audit.length - 5000);
  store.appendAudit(entry);
  return entry;
}

function list(filter = {}, limit = 200) {
  const db = store.get();
  let rows = db.audit.slice().reverse();
  if (filter.action) rows = rows.filter(r => r.action === filter.action);
  if (filter.targetId) rows = rows.filter(r => r.targetId === filter.targetId);
  if (filter.actorId) rows = rows.filter(r => r.actorId === filter.actorId);
  return rows.slice(0, limit);
}

module.exports = { record, list };
