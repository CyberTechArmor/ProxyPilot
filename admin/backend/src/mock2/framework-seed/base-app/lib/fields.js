'use strict';
// Persistence for non-document input fields (Name, DOB, address, …) that
// physicians or staff fill in. Values are stored per (ownerId, docKey) in the
// JSON store, with per-field authorship so anyone referencing the record can
// see who last wrote each value.
const store = require('./store');

function index() {
  const db = store.get();
  if (!Array.isArray(db.fieldValues)) db.fieldValues = [];
  return db.fieldValues;
}

function get(ownerId, docKey) {
  return index().find(r => r.ownerId === ownerId && r.docKey === docKey) || null;
}

function toRecord(r) {
  return { docKey: r.docKey, values: r.values || {}, meta: r.meta || {}, updatedAt: r.updatedAt || null };
}

// All saved field records for a given user (physician), used to hydrate their
// checklist in /api/my/files and /api/physicians.
function listByOwner(ownerId) {
  return index().filter(r => r.ownerId === ownerId).map(toRecord);
}

// Merge incoming field values for one document. `editor` = { id, name }.
// Authorship (`by`) is derived: the owner writing => 'physician', anyone else
// (credentialing staff filling in on their behalf) => 'team'.
function setValues(ownerId, docKey, values, editor) {
  docKey = String(docKey).slice(0, 64);
  let rec = get(ownerId, docKey);
  if (!rec) { rec = { ownerId, docKey, values: {}, meta: {}, updatedAt: null }; index().push(rec); }
  if (!rec.values) rec.values = {};
  if (!rec.meta) rec.meta = {};
  const by = (editor && editor.id === ownerId) ? 'physician' : 'team';
  const now = new Date().toISOString();
  const incoming = (values && typeof values === 'object') ? values : {};
  for (const k of Object.keys(incoming)) {
    const key = String(k).slice(0, 64);
    const v = incoming[k] == null ? '' : String(incoming[k]).slice(0, 4000);
    if (String(rec.values[key] || '') !== v) {
      rec.values[key] = v;
      rec.meta[key] = { by, name: (editor && editor.name) || '', byId: (editor && editor.id) || '', at: now };
    }
  }
  rec.updatedAt = now;
  store.save();
  return toRecord(rec);
}

module.exports = { get, listByOwner, setValues };
