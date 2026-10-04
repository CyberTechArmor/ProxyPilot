import template from './browser-configuration-example.json';

// Reuse schema and finite policy defaults only. No sample work, origin, guide,
// credential, asset or consent is copied into a user's local draft.
export function newBrowserConfiguration({ website, objective, expected, rules = '' }) {
  let url;
  try { url = new URL(website.trim()); } catch { throw new Error('Enter a complete HTTP or HTTPS website address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP or HTTPS address without embedded credentials.');
  if (!objective.trim() || !expected.trim()) throw new Error('Enter an objective and expected result.');
  const configuration = structuredClone(template);
  configuration.name = 'Browser task';
  configuration.work = { instructions: [objective, rules.trim() ? `Additional task rules:\n${rules}` : ''].filter(Boolean).join('\n\n'), success_criteria: expected.split(/\r?\n/).map(v=>v.trim()).filter(Boolean), guide_ref: null, source_inputs: [] };
  configuration.destinations.entry_urls = [url.href];
  configuration.destinations.allowed_origins = [{ id: 'site-1', origin: url.origin, roles: ['navigation','resource'], session_headers:'omit' }];
  configuration.permissions.actions = ['navigate','read','scroll','wait'];
  configuration.artifacts.upload_asset_refs = [];
  return configuration;
}
