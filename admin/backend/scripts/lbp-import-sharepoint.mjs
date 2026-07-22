#!/usr/bin/env node
// Lean BEAF Pro — one-shot SharePoint list import (retires the old list).
//
// Usage:
//   node scripts/lbp-import-sharepoint.mjs path/to/export.csv [--dry-run]
//
// Expected CSV columns (header names matched case-insensitively; extras are
// ignored): Title, Note|Notes|Description, Assigned To|AssignedTo|Assignees
// (emails or usernames separated by ; or ,). Due dates are DELIBERATELY not
// imported — deadlines were removed from the design; the rollout stage and
// meeting-to-meeting movement are the only axes.
//
// Every row lands at stage Idea for triage (locked decision). Assignees are
// matched against ProxyPilot usernames: exact match first, then the email's
// local part (jane@x.org → jane). Unmatched names are reported, not fatal.
//
// Run from admin/backend/ with DATABASE_PATH pointing at the live DB (or
// let it default like the server does).

import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
if (!csvPath) {
  console.error('Usage: node scripts/lbp-import-sharepoint.mjs <export.csv> [--dry-run]');
  process.exit(1);
}

// Minimal RFC-4180 CSV parser (quotes, embedded commas/newlines).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f.trim() !== '')) rows.push(row); }
  return rows;
}

const text = readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
const rows = parseCsv(text);
if (rows.length < 2) {
  console.error('CSV has no data rows.');
  process.exit(1);
}

const header = rows[0].map((h) => h.trim().toLowerCase());
const colIndex = (...names) => header.findIndex((h) => names.includes(h));
const iTitle = colIndex('title', 'name', 'project');
const iNote = colIndex('note', 'notes', 'description');
const iAssigned = colIndex('assigned to', 'assignedto', 'assignees', 'assigned users');
if (iTitle === -1) {
  console.error(`No Title column found. Header: ${header.join(', ')}`);
  process.exit(1);
}

const { initDatabase } = await import('../src/db.js');
initDatabase();
const store = await import('../src/lib/lean-beaf-store.js');

const users = store.listWorkspaceUsers();
const byName = new Map(users.map((u) => [u.username.toLowerCase(), u]));
const matchUser = (raw) => {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  return byName.get(s) || byName.get(s.split('@')[0]) || null;
};

let imported = 0;
const unmatched = new Set();
for (const row of rows.slice(1)) {
  const name = String(row[iTitle] || '').trim();
  if (!name) continue;
  const description = iNote >= 0 ? String(row[iNote] || '').trim() || null : null;
  const assigneeIds = [];
  if (iAssigned >= 0) {
    for (const part of String(row[iAssigned] || '').split(/[;,]/)) {
      const u = matchUser(part);
      if (u) assigneeIds.push(String(u.id));
      else if (part.trim()) unmatched.add(part.trim());
    }
  }
  if (dryRun) {
    console.log(`[dry-run] would import "${name}" (assignees: ${assigneeIds.length})`);
  } else {
    store.createProject({ name, description, stage: 'Idea', assigneeIds, createdBy: null });
    console.log(`imported "${name}" (assignees: ${assigneeIds.length})`);
  }
  imported++;
}

console.log(`\n${dryRun ? 'Would import' : 'Imported'} ${imported} project(s), all at stage Idea for triage.`);
if (unmatched.size) {
  console.log(`Unmatched assignees (no ProxyPilot user): ${[...unmatched].join(', ')}`);
}
