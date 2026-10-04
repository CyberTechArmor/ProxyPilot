// Navigation advice only. The server's readiness and approval controls remain
// authoritative; these hints never enable a run or change a project's scope.
export const PILOT_ORIGIN = 'https://demo.fractionate.ai';

// Presentation labels never replace the saved section or API identities.
export const DEMO_RUNS_LABEL = 'Historical runs';
export const operationSectionLabel = section => section === 'Agent runs' ? DEMO_RUNS_LABEL : section;
export const operationsToggleLabel = toggle => toggle.name === 'agent_runs' ? DEMO_RUNS_LABEL : toggle.label;

export function websiteReviewAvailable(capabilities) {
  return capabilities?.website_review_enabled === true &&
    capabilities.website_review_contract === 'website-review.v1' &&
    capabilities.website_review_strategy === 'http_extract_v1';
}

export function readinessNextStep(reason) {
  if (/Only https:\/\/demo\.fractionate\.ai/.test(reason)) return {
    text: 'This browser pilot supports synthetic sign-in on the demo site. A research task on another site cannot run here.',
    section: 'Access', label: 'Review project site',
  };
  if (/project site is not set|project site changed|proposed origins/i.test(reason)) return {
    text: 'The owner sets the project site in Access. Check the profile origins, then assign the guide again after a site change.',
    section: 'Access', label: 'Review site and limits',
  };
  if (/No guide is assigned|current approved version|guide.*rules|rules.*guide/i.test(reason)) return {
    text: 'Save an approved guide with the supported workflow rules, then assign its current version in Agents.',
    section: 'Guide', label: 'Open guide',
  };
  if (/No active credential binding/i.test(reason)) return {
    text: 'Ask the host operator to bind the synthetic demo account to this profile. Browser bindings have no dashboard enrollment control.',
  };
  if (/consented|consent/i.test(reason)) return {
    text: 'The project owner can review the provider statement and give consent for this profile.',
    section: 'Agents', label: 'Review profile consent',
  };
  if (/ACTION_NOT_CONFIGURED|proposed actions|not configured/i.test(reason)) return {
    text: 'Review the actions proposed for this synthetic sign-in profile. The enforced allowlist still applies.',
    section: 'Agents', label: 'Review profile',
  };
  if (/CPU|memory|MiB|resource|limits|budget/i.test(reason)) return {
    text: 'The project owner can review the required worker resources and run limits.',
    section: 'Access', label: 'Review run limits',
  };
  return null;
}

export const operationSectionUrl = (projectId, section) =>
  `/operational-projects/${encodeURIComponent(projectId)}?section=${encodeURIComponent(section)}`;

export function matchesPinnedGuide(version, run) {
  return !!version && version.id === run.guide_version_id && version.content_hash === run.guide_hash;
}
