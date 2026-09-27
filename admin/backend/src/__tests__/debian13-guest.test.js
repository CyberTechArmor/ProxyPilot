import test from 'node:test';
import assert from 'node:assert/strict';
import { NEW_GUEST_IMAGE, requireNewGuestImage, parseDebian13Release, verifyNewGuestRelease } from '../lib/debian13-guest.js';

test('new guest image is fixed and guest release must independently prove Debian 13', async () => {
  assert.equal(requireNewGuestImage(), NEW_GUEST_IMAGE);
  assert.throws(() => requireNewGuestImage('images:debian/12'), /require images:debian\/13/);
  assert.equal(parseDebian13Release('ID=debian\nVERSION_ID="13"\n'), true);
  for (const release of ['ID=debian\nVERSION_ID=12\n', 'ID=ubuntu\nVERSION_ID=13\n', 'PRETTY_NAME="Debian 13"\n'])
    assert.equal(parseDebian13Release(release), false);
  assert.equal((await verifyNewGuestRelease('pp-new', async () => ({ code: 0, stdout: 'ID=debian\nVERSION_ID=13\n' }))).ok, true);
  assert.equal((await verifyNewGuestRelease('pp-new', async () => ({ code: 1, stderr: 'agent unavailable' }))).ok, false);
});
