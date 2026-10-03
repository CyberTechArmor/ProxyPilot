export const prettyConfiguration = value => JSON.stringify(value, null, 2);
export const browserConfigurationActions = ['navigate','read','click','scroll','type','wait','download','copy','paste','screenshot','upload','submit'];
export const browserConfigurationBudgets = [
  ['max_seconds','Maximum seconds',1,3600],['max_actions','Maximum actions',1,200],
  ['max_model_calls','Maximum model calls',1,100],['max_tokens','Maximum tokens',1,200000],
  ['max_usd','Maximum spend (USD)',0.001,20],['max_requests','Maximum requests',1,2000],
  ['max_response_bytes','Maximum response bytes',1,268435456],['max_artifact_bytes','Maximum artifact bytes',1,67108864],
  ['cpu','CPU limit',1,8],['memory_mib','Memory (MiB)',1024,8192],['temporary_disk_mib','Temporary disk (MiB)',64,2048],
];
export function parseBrowserConfiguration(text) {
  if (new TextEncoder().encode(text).length > 200000) throw new Error('JSON exceeds 200,000 UTF-8 bytes.');
  let input;
  try { input = JSON.parse(text); } catch { throw new Error('Enter valid JSON. Your input is retained.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter a browser configuration object.');
  const wrapped = Object.hasOwn(input, 'configuration');
  if (wrapped && (Object.keys(input).some(k => !['configuration','source_text'].includes(k)) ||
      Object.hasOwn(input, 'source_text') && typeof input.source_text !== 'string')) throw new Error('The wrapper accepts configuration and optional source_text only.');
  const configuration = wrapped ? input.configuration : input;
  if (configuration?.schema !== 'proxypilot.browser-agent.proposal.v1' || configuration?.workflow !== 'selected_browser_v1')
    throw new Error('Use the selected-browser v1 configuration schema.');
  return { configuration, ...(wrapped && Object.hasOwn(input,'source_text') ? { source_text: input.source_text } : {}) };
}
export function editableConfiguration(c) {
  const strings = a => Array.isArray(a) && a.every(v => typeof v === 'string');
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  return !!c && typeof c.name === 'string' && typeof c.work?.instructions === 'string' && strings(c.work.success_criteria) &&
    strings(c.destinations?.entry_urls) && Array.isArray(c.destinations.allowed_origins) &&
    c.destinations.allowed_origins.every(d => object(d) && typeof d.id === 'string' && typeof d.origin === 'string' && strings(d.roles) && typeof d.session_headers === 'string') &&
    strings(c.permissions?.actions) && object(c.budgets) && object(c.model) && object(c.artifacts);
}
export const draftIssueText = {
  BROWSER_DRAFT_TOO_LARGE: 'The configuration and original source together exceed the draft byte limit.',
  BROWSER_DESTINATION_DUPLICATE: 'Destination IDs and exact origins must be unique.',
  BROWSER_DESTINATION_INVALID: 'Use an exact canonical HTTP or HTTPS origin, including a non-default port when needed.',
  BROWSER_ENTRY_OUTSIDE_ALLOWLIST: 'Every entry URL must use a selected navigation origin, without credentials in its address.',
  BROWSER_INSECURE_SESSION_DESTINATION: 'HTTP destinations must omit session headers and cannot have an authentication role.',
  BROWSER_RESOURCE_SESSION_HEADERS_DENIED: 'A resource-only origin must omit session headers.',
  BROWSER_REQUEST_DESTINATION_UNKNOWN: 'A request rule refers to a destination ID that is not selected.',
  BROWSER_READ_METHOD_REVIEW_REQUIRED: 'A read rule may use GET, HEAD or OPTIONS only.',
  BROWSER_ASSET_PIN_CONFLICT: 'An input and upload reference to the same file have different pins.',
  BROWSER_ARTIFACT_BUDGET_CONFLICT: 'Upload and download limits must fit the artifact budget and selected file sizes.',
};
export const readinessText = {
  GUIDE_CURRENT: 'The current approved guide is pinned.', GUIDE_REQUIRED: 'No approved guide is selected.', GUIDE_STALE: 'The pinned guide is no longer current.',
  EXPLICIT_DESTINATIONS_SELECTED: 'Exact destination origins are entered.', PER_ACTION_APPROVAL_SELECTED: 'Consequential changes require separate per-action approval.',
  EXACT_DESTINATION_PURPOSE_APPROVAL_SELECTED: 'Off-list contact requires approval of an exact destination and purpose for one attempt.',
  RUNNER_REACHABILITY_UNVERIFIED: 'Network reachability has not been verified. No destination was contacted.',
  EXACT_TARGET_NETWORK_POLICY_UNVERIFIED: 'The requested network boundary has not been verified.', SELECTED_SITE_POLICY_UNVERIFIED: 'Selected-site policy review is unfinished.',
  ASSET_RESOLUTION_UNAVAILABLE: 'File references are stored as unresolved metadata.', NO_ASSET_INPUTS: 'No private file references are selected.',
  OWNER_MODEL_CONSENT_REQUIRED: 'Model disclosure consent has not been granted.', SELECTED_BROWSER_RUNTIME_NOT_IMPLEMENTED: 'Selected-site browser execution is unavailable.',
  PROJECT_ARCHIVED: 'The project is archived.', PROJECT_ACTIVE: 'The project is active.',
};
