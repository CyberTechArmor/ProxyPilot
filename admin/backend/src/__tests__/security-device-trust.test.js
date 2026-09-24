import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup } from './helpers/sso-fixture.js';

test('legacy header fingerprints and caller-chosen device IDs cannot skip MFA', async () => {
  const f = await setup();
  try {
    const credentials = f.db.prepare("SELECT password_hash,totp_secret FROM users WHERE id='admin'").get();
    const fingerprint = createHash('sha256').update('||').digest('hex').slice(0,32);
    for (const [id,hash] of [['headers',fingerprint],['caller','chosen-by-client']])
      f.db.prepare('INSERT INTO authenticated_devices(id,user_id,device_fingerprint) VALUES(?,?,?)').run(id,'admin',hash);
    for (const deviceFingerprint of [undefined,fingerprint,'chosen-by-client']) {
      const reply = await f.request('/api/auth/login',{body:{username:'admin',password:'local-password-fixture',deviceFingerprint,registerDevice:true},csrf:false});
      assert.equal(reply.status,401); assert.equal(reply.data.totpRequired,true);
      assert.equal(reply.data.token,undefined);
      assert(!reply.headers.getSetCookie().some(s=>s.startsWith('pp_token=')));
    }
    const reply = await f.request('/api/auth/login',{body:{username:'admin',password:'local-password-fixture',totpCode:f.totp(),deviceFingerprint:'new-fingerprint',registerDevice:true},csrf:false});
    assert.equal(reply.status,200); assert(reply.data.token);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM authenticated_devices').get().n,2,'login must not create new device trust');
    assert.deepEqual(f.db.prepare("SELECT password_hash,totp_secret FROM users WHERE id='admin'").get(),credentials);
    const again = await f.request('/api/auth/login',{body:{username:'admin',password:'local-password-fixture',deviceFingerprint:'new-fingerprint'},csrf:false});
    assert.equal(again.status,401); assert.equal(again.data.totpRequired,true);
  } finally { await f.close(); }
});
