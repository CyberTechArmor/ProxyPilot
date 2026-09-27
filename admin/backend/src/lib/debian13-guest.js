// New guests have one supported OS. The alias is an input constraint; the
// guest's own os-release is the post-creation proof.
export const NEW_GUEST_IMAGE = 'images:debian/13';

export function requireNewGuestImage(image = NEW_GUEST_IMAGE) {
  if (image !== NEW_GUEST_IMAGE) throw new Error(`New instances require ${NEW_GUEST_IMAGE}; received ${String(image)}`);
  return NEW_GUEST_IMAGE;
}

export function parseDebian13Release(content) {
  if (typeof content !== 'string' || content.length > 8192) return false;
  const fields = Object.create(null);
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(?:"([^"]*)"|'([^']*)'|([^\s#]*))$/.exec(line);
    if (match) fields[match[1]] = match[2] ?? match[3] ?? match[4];
  }
  return fields.ID === 'debian' && fields.VERSION_ID === '13';
}

export function guestReleaseArgv(name) {
  return ['incus', 'exec', name, '--', 'cat', '/etc/os-release'];
}

export async function verifyNewGuestRelease(name, host) {
  let result;
  try { result = await host(guestReleaseArgv(name)); }
  catch (error) { return { ok: false, reason: `Could not read ${name}:/etc/os-release (${String(error?.message || error).slice(0, 200)})` }; }
  if (result.code !== 0) return { ok: false, reason: `Could not read ${name}:/etc/os-release (${String(result.stderr || `exit ${result.code}`).trim().slice(0, 200)})` };
  if (!parseDebian13Release(result.stdout)) return { ok: false, reason: `${name}:/etc/os-release does not prove ID=debian and VERSION_ID=13` };
  return { ok: true };
}
