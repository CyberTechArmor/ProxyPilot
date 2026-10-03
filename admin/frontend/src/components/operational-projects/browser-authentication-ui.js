export const AUTHENTICATION_CONFIRMATION = 'I reviewed each selected request and confirm it was solely for sign-in or MFA. I independently observed this browser complete authentication. This confirms authentication only, and does not confirm other website changes.';

const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
// This bounds the private editor projection. Signed host validation and exact
// session authority remain server responsibilities at inventory and confirmation.
export function authenticationInventory(result, run) {
  const inventory = result?.inventory;
  if (!Number.isSafeInteger(result?.revision) || result.revision < 1 ||
      !sha(inventory?.inventory_sha256) || inventory.run_id !== run.id ||
      inventory.attempt_id !== run.attempt_id || inventory.fence !== run.fence ||
      !Array.isArray(inventory.requests) || inventory.requests.length > 64) {
    throw new Error('Authentication inventory does not match this browser attempt. Refresh it explicitly.');
  }
  const refs = new Set();
  for (const request of inventory.requests) {
    if (typeof request.request_ref !== 'string' || !request.request_ref || refs.has(request.request_ref) ||
        !sha(request.binding_sha256) || request.role !== 'authentication' || request.transport_complete !== true ||
        !sha(request.body_sha256) || !Number.isSafeInteger(request.body_bytes) || request.body_bytes < 0) {
      throw new Error('Authentication request evidence is incomplete. Refresh it explicitly.');
    }
    refs.add(request.request_ref);
  }
  return result;
}

export function authenticationPayload(result, selected, reviewed) {
  if (!reviewed) throw new Error('Review the authentication confirmation before submitting it.');
  const requests = result?.inventory?.requests;
  if (!Array.isArray(requests) || !Array.isArray(selected) || selected.length < 1 ||
      new Set(selected).size !== selected.length || selected.some(ref => !requests.some(request => request.request_ref === ref))) {
    throw new Error('Select and review each sign-in or MFA request from this inventory.');
  }
  return {revision:result.revision,inventory_sha256:result.inventory.inventory_sha256,
    request_refs:selected.map(ref => {const request=requests.find(value=>value.request_ref===ref);return {request_ref:ref,binding_sha256:request.binding_sha256};}),
    reviewed_statement:AUTHENTICATION_CONFIRMATION};
}
