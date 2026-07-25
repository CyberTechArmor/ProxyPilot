'use strict';
// Securely (re)set the LDAP service-account bind password.
// The password is read from a hidden terminal prompt, encrypted with the current
// master key (data/secret.key or APP_MASTER_KEY), stored in data/db.json, and the
// connection is verified. The secret is never echoed, logged, or passed as an arg.
//
// Usage:  node scripts/set-ldap-password.js
const readline = require('readline');
const store = require('../lib/store');
const crypto = require('../lib/crypto');
const ldap = require('../lib/ldap');

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      char = String(char);
      if (char === '\n' || char === '\r' || char === '\u0004') {
        process.stdin.removeListener('data', onData);
      } else {
        // rewrite the prompt line without revealing typed characters
        process.stdout.clearLine(0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(question);
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (value) => { rl.close(); process.stdout.write('\n'); resolve(value); });
  });
}

(async () => {
  const db = store.get();
  if (!db.ldapConfig || !db.ldapConfig.host) {
    console.error('No LDAP config present. Configure host/baseDN/bindDN first (admin UI) before setting the password.');
    process.exit(1);
  }
  console.log('LDAP host   :', db.ldapConfig.host + ':' + (db.ldapConfig.port || (db.ldapConfig.useTLS ? 636 : 389)));
  console.log('Bind DN     :', db.ldapConfig.bindDN);
  const pw = await promptHidden('Enter LDAP bind password (input hidden): ');
  if (!pw) { console.error('No password entered. Aborted.'); process.exit(1); }

  db.ldapConfig.bindPassword = crypto.encryptSecret(pw);
  db.ldapConfig.enabled = true;
  db.ldapConfig.updatedAt = new Date().toISOString();
  await store.save();
  console.log('Stored encrypted bind password. Verifying connection...');

  const result = await ldap.connectionTest(db.ldapConfig);
  console.log('Connection test:', JSON.stringify(result, null, 2));
  process.exit(result.status === 'ok' ? 0 : 2);
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
