'use strict';
const fs = require('fs');
const path = require('path');

// APP_DATA_DIR lets tests (or alternate deployments) isolate persistence so they
// never touch the production data directory. Defaults to ../data.
const DATA_DIR = process.env.APP_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  meta: { version: 1, initialized: false },
  users: [],
  roles: [],
  permissions: [],          // catalog: [{key,label,group}]
  defaultRolePerms: [],      // [{roleKey, permKey, allowed}]
  permOverrides: [],         // [{roleKey, permKey, allowed}]
  ldapConfig: null,          // {host,port,baseDN,bindDN,bindPassword(enc),userFilter,useTLS,tlsVerify,enabled}
  smtpConfig: null,          // {enabled,provider,host,port,secure,username,password(enc),fromEmail,fromName,tlsVerify}
  catalog: null,             // provider documents: {sections:[{id,title,order,items:[...]}]}
  internalCatalog: null,     // employee/team documents; same shape, managed separately
  passwordResets: [],        // [{tokenHash, userId, expiresAt, usedAt}]
  sessions: [],              // refresh session records
  audit: []
};

let db = null;
let writeChain = Promise.resolve();

function load() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = Object.assign(JSON.parse(JSON.stringify(DEFAULT_DB)), JSON.parse(raw));
  } catch (_) {
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  return db;
}

// Atomic, serialized persistence.
function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeChain = writeChain.then(() => new Promise((resolve) => {
    const tmp = DB_FILE + '.' + process.pid + '.tmp';
    fs.writeFile(tmp, snapshot, (err) => {
      if (err) { console.error('persist write error', err.message); return resolve(); }
      fs.rename(tmp, DB_FILE, (err2) => {
        if (err2) console.error('persist rename error', err2.message);
        resolve();
      });
    });
  }));
  return writeChain;
}

function get() { return load(); }
function save() { load(); return persist(); }

module.exports = { get, save, DB_FILE, DATA_DIR, DEFAULT_DB };
