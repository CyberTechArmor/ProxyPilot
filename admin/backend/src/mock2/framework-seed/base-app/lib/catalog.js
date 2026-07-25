'use strict';
// Document catalog: sections + documents that make up the credentialing
// checklist. Persisted in the store so admins can add sections/documents and
// set per-document expiry behaviour. Seeded once from DEFAULT_SECTIONS.
const store = require('./store');
const { uuid } = require('./util');

// expiry modes:
//   'expires' — must be renewed by a date (licenses, certs, insurance, health)
//   'annual'  — no hard expiry but must be re-checked yearly
//   'none'    — informational, no expiry
function item(key, name, hint, type, expiry) {
  return { key, name, hint: hint || '', type: type || 'doc', expiry: expiry || 'none' };
}

const DEFAULT_SECTIONS = [
  { title: 'Pre-LOI Documents', items: [
    item('preloi_lives', 'Past 12 Months Attributed Life Count (Unique Patients)', '', 'doc', 'annual'),
    item('preloi_visits', '12 Month Visit Count', '', 'doc', 'annual'),
    item('preloi_pnl', 'P&L Information', '', 'doc', 'annual'),
    item('preloi_payor', 'Payor Mix Documentation', '', 'doc', 'annual'),
  ]},
  { title: 'Personal Information', items: [
    item('personal', 'Full Name, DOB, Address, Phone, Personal Email', 'Core identity details', 'info', 'none'),
    item('birthplace', 'City, State & Country of Birth', '', 'info', 'none'),
    item('dl', "Driver's License", 'Color copy', 'doc', 'expires'),
    item('ssn', 'Social Security Card / SSN', 'Copy of card or number', 'doc', 'none'),
    item('headshot', 'Color Headshot', 'Digital, passport-size', 'doc', 'none'),
    item('citizenship', 'Proof of Citizenship', 'Passport or birth certificate', 'doc', 'expires'),
    item('npi', 'NPI #', 'National Provider Identifier', 'info', 'none'),
    item('languages', 'Languages Spoken Fluently', '', 'info', 'none'),
  ]},
  { title: 'Education & Training', items: [
    item('diploma', 'Medical / Practitioner Diploma', "Bachelor & Master's if applicable", 'doc', 'none'),
    item('internship', 'Internship', 'Certificate of completion', 'doc', 'none'),
    item('fellowship', 'Fellowship', 'Certificate of completion', 'doc', 'none'),
    item('residency', 'Residency', 'Certificate of completion', 'doc', 'none'),
    item('ecfmg', 'ECFMG Certificate', 'If applicable', 'doc', 'none'),
    item('usmle', 'USMLE Number & Exam Date', 'If applicable', 'info', 'none'),
  ]},
  { title: 'Work History', items: [
    item('cv', 'Updated CV', 'Gap-free, dates & addresses in MM/DD/YYYY', 'doc', 'annual'),
    item('epic_pc', 'EPIC Primary Care Employment', 'Include start date', 'info', 'none'),
    item('gaps', 'Employment Gaps > 3 Months', 'List any gaps over 3 months', 'info', 'none'),
    item('other_loc', 'Other Practice Locations', 'EPIC-approved locations, if applicable', 'info', 'none'),
    item('archived_loc', 'Archived / Rejected Locations', '', 'info', 'none'),
  ]},
  { title: 'Licenses & Certificates', items: [
    item('mi_license', 'Michigan Physician/Practitioner License', 'State of Michigan', 'doc', 'expires'),
    item('mi_cds', 'Michigan Controlled Substance Registration (CDS)', 'MD, DO, PA', 'doc', 'expires'),
    item('cds_deleg', 'Delegation of CDS Letter', 'NP / PA', 'doc', 'expires'),
    item('dea', 'DEA License', '', 'doc', 'expires'),
    item('bls_acls', 'BLS / ACLS Certificates', 'If applicable', 'doc', 'expires'),
    item('board', 'Board Certification', 'Board name & certification date', 'doc', 'expires'),
    item('secondary', 'Secondary Specialty', 'If applicable', 'info', 'none'),
    item('cme', 'CMEs', 'Credits & MM/YY completed', 'info', 'annual'),
    item('skills', 'Special Skills & Training', 'Populations, conditions, methods, tools', 'info', 'none'),
    item('other_cert', 'Other Certifications', 'QASP, CPR, ALSO, CoreC, ATLS, NALS, NRP, PALS', 'doc', 'expires'),
  ]},
  { title: 'Malpractice / Liability Insurance', items: [
    item('liability', 'Current & Previous Liability Insurance', 'Include tail coverage if applicable', 'doc', 'expires'),
    item('claims', 'Malpractice Claims Information', 'If applicable', 'info', 'none'),
  ]},
  { title: 'Peer References', items: [
    item('references', '4 Peer References', '≥3 in your specialty, not in our practice', 'doc', 'none'),
  ]},
  { title: 'User IDs & Passwords', items: [
    item('caqh', 'CAQH', '888-599-1771', 'info', 'annual'),
    item('pecos', 'PECOS (Medicare)', '866-484-8049', 'info', 'annual'),
    item('nppes', 'NPPES', '', 'info', 'annual'),
    item('champs', 'CHAMPS (Medicaid)', '', 'info', 'annual'),
  ]},
  { title: 'Medical Documentation', items: [
    item('flu', 'Proof of Current Flu Vaccination', 'Can be scheduled at our office', 'doc', 'expires'),
    item('tb', 'Proof of Current TB Test', 'Can be scheduled at our office', 'doc', 'expires'),
    item('immun', 'Immunizations', '', 'doc', 'annual'),
  ]},
  { title: 'Facility / Hospital Affiliations', items: [
    item('affiliations', 'Affiliations (Current & Prior)', '', 'info', 'none'),
    item('denied_aff', 'Denied Affiliations', '', 'info', 'none'),
  ]},
  { title: 'Physician Web Access', items: [
    item('sjh', 'SJH — St. John Hospital', '', 'access', 'none'),
    item('dmc', 'DMC — Detroit Medical Center', '', 'access', 'none'),
    item('wbh', 'WBH — William Beaumont Hospital', '', 'access', 'none'),
    item('hfh', 'HFH — Henry Ford Hospital', '', 'access', 'none'),
    item('maps', 'MAPS — MI Automated Prescription System', '', 'access', 'none'),
    item('uptodate', 'UpToDate', '', 'access', 'none'),
  ]},
  { title: 'Digital Signature', items: [
    item('signature', 'Digital Signature Document', 'Sign a blank sheet & email to HR/Credentialing', 'doc', 'none'),
  ]},
  { title: 'Practice Location & Hours', items: [
    item('practice', 'Practice Location & Hours', '', 'info', 'none'),
  ]},
  { title: 'Advanced Practitioners Only', items: [
    item('supervising', 'Supervising Provider Information', 'Name, title, phone, email', 'info', 'none'),
    item('collab', 'Collaborative Agreement', '', 'doc', 'expires'),
  ]},
];

const EXPIRY_MODES = ['expires', 'annual', 'none'];
const TYPES = ['doc', 'info', 'access'];
// Field input types an admin can add to a checklist item (for non-document data).
const FIELD_TYPES = ['text', 'textarea', 'date', 'number', 'email', 'phone', 'select', 'upload'];

// Normalize an array of custom field definitions: [{key,label,type,options}].
function sanitizeFields(fields) {
  if (!Array.isArray(fields)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of fields) {
    if (!raw || typeof raw !== 'object') continue;
    const label = String(raw.label || '').trim();
    if (!label) continue;
    const type = FIELD_TYPES.includes(raw.type) ? raw.type : 'text';
    let base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
    let key = raw.key && /^[a-z0-9_]+$/.test(raw.key) ? raw.key : base, n = 2;
    while (seen.has(key)) key = base + '_' + (n++);
    seen.add(key);
    const field = { key, label: label.slice(0, 120), type };
    if (type === 'select') {
      field.options = String(raw.options || '').split(',').map(o => o.trim()).filter(Boolean).slice(0, 40);
    }
    out.push(field);
    if (out.length >= 40) break;
  }
  return out;
}

// A section "gate" hides every section that follows it from the physician until
// this section is complete (all items approved) or a team member acknowledges it.
// Defaults on for the Pre-LOI section so providers focus there first.
function gateDefault(title) { return /pre[\s-]?loi/i.test(String(title || '')); }

function normalizeScope(scope) { return scope === 'internal' ? 'internal' : 'provider'; }
function catalogKey(scope) { return normalizeScope(scope) === 'internal' ? 'internalCatalog' : 'catalog'; }
function cloneDefaultSections(scope) {
  const internal = normalizeScope(scope) === 'internal';
  return DEFAULT_SECTIONS.map((s, i) => ({
    id: uuid(), title: s.title, order: i, gate: gateDefault(s.title),
    items: s.items.map(it => Object.assign({}, it, internal ? { key: 'int_' + it.key } : {}))
  }));
}

function seed(scope) {
  const db = store.get();
  const scopes = scope ? [normalizeScope(scope)] : ['provider', 'internal'];
  let created = false;
  for (const sc of scopes) {
    const key = catalogKey(sc);
    if (!db[key]) { db[key] = { sections: cloneDefaultSections(sc) }; created = true; }
  }
  if (created) store.save();
  // Upgrade-safe migration: every document-type item carries a "Document upload"
  // field so uploads are represented as a field like everything else.
  let changed = false;
  for (const sc of scopes) {
    const cat = db[catalogKey(sc)];
    for (const s of cat.sections) {
      if (typeof s.gate !== 'boolean') { s.gate = gateDefault(s.title); changed = true; }
      for (const it of s.items) {
        if (!Array.isArray(it.fields)) it.fields = [];
        if (it.type === 'doc' && !it.fields.some(f => f.type === 'upload')) {
          it.fields.unshift({ key: 'document', label: 'Document', type: 'upload' });
          changed = true;
        }
      }
    }
  }
  if (changed) store.save();
  return db[catalogKey(scope)];
}

function get(scope) { return seed(scope); }

// Public shape used by the portal renderer: ordered sections with numbers.
function publicCatalog(scope) {
  const cat = get(scope);
  const sections = cat.sections.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  return { sections: sections.map((s, i) => ({ id: s.id, n: i + 1, title: s.title, gate: !!s.gate, items: s.items.map(it => ({ ...it })) })) };
}

function allKeys(scope) {
  const set = new Set();
  for (const s of get(scope).sections) for (const it of s.items) set.add(it.key);
  return [...set];
}
function findItem(key, scope) {
  for (const s of get(scope).sections) { const it = s.items.find(i => i.key === key); if (it) return { section: s, item: it }; }
  return null;
}

/* ---------- admin mutations ---------- */
function addSection(title, scope) {
  const cat = get(scope);
  const order = cat.sections.reduce((m, s) => Math.max(m, s.order || 0), 0) + 1;
  const section = { id: uuid(), title: String(title || 'Untitled section').trim(), order, items: [] };
  cat.sections.push(section);
  store.save();
  return section;
}
function updateSection(id, patch, scope) {
  const s = get(scope).sections.find(x => x.id === id);
  if (!s) return null;
  if (patch.title != null) s.title = String(patch.title).trim();
  if (patch.order != null) s.order = +patch.order;
  if (patch.gate != null) s.gate = !!patch.gate;
  store.save();
  return s;
}
function deleteSection(id, scope) {
  const cat = get(scope);
  const idx = cat.sections.findIndex(x => x.id === id);
  if (idx === -1) return false;
  cat.sections.splice(idx, 1);
  store.save();
  return true;
}
// Move a section one step earlier ('up') or later ('down') in the checklist and
// re-normalize the order values. Applies to every provider's checklist.
function moveSection(id, dir, scope) {
  const cat = get(scope);
  const sorted = cat.sections.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const idx = sorted.findIndex(s => s.id === id);
  if (idx === -1) return false;
  const swap = dir === 'up' ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= sorted.length) return false;
  [sorted[idx], sorted[swap]] = [sorted[swap], sorted[idx]];
  sorted.forEach((s, i) => { s.order = i; });
  store.save();
  return true;
}
// Reorder sections to match an explicit list of section ids (drag-and-drop).
// Any sections not named keep their relative order after the listed ones.
function reorderSections(orderIds, scope) {
  if (!Array.isArray(orderIds)) return false;
  const cat = get(scope);
  const pos = new Map(orderIds.map((id, i) => [id, i]));
  const fallback = cat.sections.length;
  cat.sections
    .slice()
    .sort((a, b) => {
      const pa = pos.has(a.id) ? pos.get(a.id) : fallback + (a.order || 0);
      const pb = pos.has(b.id) ? pos.get(b.id) : fallback + (b.order || 0);
      return pa - pb;
    })
    .forEach((s, i) => { s.order = i; });
  store.save();
  return true;
}
function slugKey(name, scope) {
  let base = String(name || 'doc').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'doc';
  if (normalizeScope(scope) === 'internal' && !base.startsWith('int_')) base = 'int_' + base;
  let key = base, n = 2;
  const existing = new Set(allKeys(scope));
  while (existing.has(key)) key = base + '_' + (n++);
  return key;
}
function addItem(sectionId, data, scope) {
  const s = get(scope).sections.find(x => x.id === sectionId);
  if (!s) return null;
  const type = TYPES.includes(data.type) ? data.type : 'doc';
  const expiry = EXPIRY_MODES.includes(data.expiry) ? data.expiry : 'none';
  const cleanKey = data.key && normalizeScope(scope) === 'internal' && !String(data.key).startsWith('int_') ? 'int_' + data.key : data.key;
  const key = (cleanKey && !allKeys(scope).includes(cleanKey)) ? cleanKey : slugKey(data.name, scope);
  const it = item(key, String(data.name || 'Untitled document').trim(), data.hint || '', type, expiry);
  if (data.expiryDate) it.expiryDate = data.expiryDate;
  if (data.fields !== undefined) it.fields = sanitizeFields(data.fields);
  s.items.push(it);
  store.save();
  return it;
}
function updateItem(key, patch, scope) {
  const found = findItem(key, scope);
  if (!found) return null;
  const it = found.item;
  if (patch.name != null) it.name = String(patch.name).trim();
  if (patch.hint != null) it.hint = String(patch.hint);
  if (patch.type != null && TYPES.includes(patch.type)) it.type = patch.type;
  if (patch.expiry != null && EXPIRY_MODES.includes(patch.expiry)) it.expiry = patch.expiry;
  if (patch.expiryDate !== undefined) { if (patch.expiryDate) it.expiryDate = patch.expiryDate; else delete it.expiryDate; }
  if (patch.fields !== undefined) it.fields = sanitizeFields(patch.fields);
  store.save();
  return it;
}
function deleteItem(key, scope) {
  for (const s of get(scope).sections) {
    const idx = s.items.findIndex(i => i.key === key);
    if (idx !== -1) { s.items.splice(idx, 1); store.save(); return true; }
  }
  return false;
}
// Move a document one step earlier/later within its own section.
function moveItem(key, dir, scope) {
  for (const s of get(scope).sections) {
    const idx = s.items.findIndex(i => i.key === key);
    if (idx === -1) continue;
    const swap = dir === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= s.items.length) return false;
    [s.items[idx], s.items[swap]] = [s.items[swap], s.items[idx]];
    store.save();
    return true;
  }
  return false;
}
// Reorder the documents within one section to match an explicit list of keys.
function reorderItems(sectionId, orderKeys, scope) {
  if (!Array.isArray(orderKeys)) return false;
  const s = get(scope).sections.find(x => x.id === sectionId);
  if (!s) return false;
  const pos = new Map(orderKeys.map((k, i) => [k, i]));
  const fallback = s.items.length;
  s.items.sort((a, b) => {
    const pa = pos.has(a.key) ? pos.get(a.key) : fallback;
    const pb = pos.has(b.key) ? pos.get(b.key) : fallback;
    return pa - pb;
  });
  store.save();
  return true;
}

module.exports = {
  seed, get, publicCatalog, allKeys, findItem, EXPIRY_MODES, TYPES, FIELD_TYPES,
  addSection, updateSection, deleteSection, moveSection, reorderSections,
  addItem, updateItem, deleteItem, moveItem, reorderItems, DEFAULT_SECTIONS
};
