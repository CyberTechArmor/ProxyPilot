// Application storage: every sentence the pages show, in plain language.
// The status and category labels mirror the backend's
// lib/app-storage/categories.js (DESIGN §2.3); the all-eligible scope sentence
// and the snapshot warning are worded exactly as the design requires. Pure
// data and small text helpers only — app-storage-model.mjs imports it and the
// backend suite loads both under Node.
//
// Words to avoid on screen: "eligible", "dedupe", "inode", "allocated",
// "logical", "tmpfs". Say "Can be cleaned up", "counted once", "on disk",
// "file sizes", "uses memory, not disk".

export const STATUS_LABELS = {
  protected: 'Protected',
  eligible: 'Can be cleaned up',
  investigate: 'Needs a look',
};

// A category's overall status (DESIGN §2.4 per-category `status`).
export const CATEGORY_STATUS_LABELS = {
  protected: 'Protected',
  eligible: 'Can be cleaned up',
  mixed: 'Some can be cleaned up',
  investigate: 'Needs a look',
  empty: 'Nothing here',
};

export const CATEGORY_ORDER = [
  'running_app', 'dependencies', 'data', 'releases', 'workspaces', 'archives', 'caches',
  'test_reports', 'temp', 'logs', 'history', 'snapshots', 'exports', 'other',
];

export const CATEGORY_LABELS = {
  running_app: 'Running application',
  dependencies: 'Dependencies',
  data: 'Application data (database, uploads, models, settings)',
  releases: 'Releases',
  workspaces: 'Build workspaces',
  archives: 'Source and transfer archives',
  caches: 'Caches',
  test_reports: 'Test reports',
  temp: 'Temporary files',
  logs: 'Logs',
  history: 'Execution history',
  snapshots: 'Snapshots (restore points)',
  exports: 'Exports (downloadable copies)',
  other: 'Other or unclassified',
};

export const CATEGORY_DESCRIPTIONS = {
  running_app: 'The release or working copy the application runs from now.',
  dependencies: 'The operating system and installed packages.',
  data: 'Databases, uploads, models and settings. Never cleaned up here.',
  releases: 'Sealed copies of earlier versions of the application.',
  workspaces: 'Folders builds use while they run.',
  archives: 'Copies of the source made to move it between places.',
  caches: 'Downloaded files that are fetched again when needed.',
  test_reports: 'Results and screenshots from test runs.',
  temp: 'Short-lived files programs leave behind.',
  logs: 'Records of what the system and the application did.',
  history: 'Copies of databases and settings taken before changes.',
  snapshots: 'Restore points of the whole container.',
  exports: 'Downloadable copies of the whole container.',
  other: 'Files no rule recognises. Look at them before deciding.',
};

export const KIND_LABELS = {
  application: 'Application',
  project: 'Dev Studio project',
};

// Exact wording required by DESIGN §3.1.
export const ALL_ELIGIBLE_SCOPE = 'Every item marked "Can be cleaned up" in this check, in every category except Snapshots and Exports.';
export const SNAPSHOT_WARNING = 'Deleting a snapshot removes the option to restore to that point. This cannot be undone.';
export const SNAPSHOT_ACK = 'I understand that the selected snapshots will be deleted for good.';
export const NOTHING_SELECTED = 'Nothing was selected, so nothing was changed.';
export const ACK_REQUIRED = 'Confirm that you understand the selected snapshots will be deleted.';

export const TEXT = {
  pageTitle: 'Application storage',
  pageDescription: 'See what uses storage in each application and Dev Studio project, clean up what is no longer needed, and set rules and alerts. Checking only reads; nothing is removed until you review and approve a cleanup.',
  refresh: 'Refresh',
  backToOverview: 'All applications',
  breadcrumb: 'Breadcrumb',
  loading: 'Loading…',
  loadFailed: 'Could not load application storage.',
  tryAgain: 'Try again',
  overviewEmptyTitle: 'No applications or projects yet',
  overviewEmptyHint: 'Registered applications and Dev Studio projects with a container appear here.',
  colApplication: 'Application',
  colUsedNow: 'Used now',
  colLastCheck: 'Last check',
  colAlerts: 'Alerts',
  colRules: 'Rules',
  noAlerts: 'None',
  neverChecked: 'Not checked yet',
  open: 'Open',
  openDetails: 'Show storage',
  requestCheck: 'Request storage check',
  checking: 'Checking…',
  checkRunningHint: 'The check reads the container’s files and can take a minute.',
  checkReused: 'A check was already running; showing that one.',
  checkFinished: 'Storage check finished.',
  checkFailed: 'The storage check did not finish.',
  containerStopped: 'The container is stopped, so its files cannot be measured. Start it, then check again.',
  usageUnknown: 'Unknown',

  // Detail header
  checkedAt: 'Checked',
  noCheckTitle: 'No storage check yet',
  noCheckHint: 'A storage check reads what uses space in this container. It does not change anything.',
  checkPartial: 'Part of this check could not finish, so some sizes are at least what is shown.',
  checkStale: 'This check is more than an hour old. Run a new check before you clean up.',
  used: 'Used',
  available: 'Available',
  limit: 'Limit',
  noLimit: 'No limit set',
  onDisk: 'On disk',
  fileSizes: 'File sizes before compression',
  onDiskHint: 'Space the files take on disk, after compression.',
  snapshotsHold: 'Held by snapshots',
  snapshotsHoldHint: 'Deleting files does not return this space while snapshots still contain them.',
  memoryBacked: (mount, size) => `${mount} uses memory, not disk: ${size}. It is emptied when the container restarts.`,
  notMeasuredTitle: 'Not measured',
  notesTitle: 'Notes',
  newCheckRunning: 'A new check is running. Your selection will be cleared when it finishes.',

  // Categories and items
  whatUsesStorage: 'What uses storage',
  restorePointsTitle: 'Restore points and copies',
  restorePointsDescription: 'Snapshots and exports are selected separately from files.',
  emptyCategories: (labels) => `Nothing found in: ${labels.join(', ')}.`,
  items: (n) => `${n} ${n === 1 ? 'item' : 'items'}`,
  files: (n) => `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}`,
  lastModified: 'Last changed',
  created: 'Created',
  canBeCleaned: (n) => `${n} can be cleaned up`,
  selectCategory: 'Select all in this category',
  selectCategoryShort: 'Select all',
  deselectCategoryShort: 'Clear',
  usesMemory: 'Uses memory, not disk',
  atLeast: 'at least',
  about: 'about',
  fileSizesAddUp: (size) => `files add up to ${size}`,
  insideRelease: 'Inside this release',
  showMembers: (shown, total) => `Show ${shown === total ? 'all' : `${shown} of`} ${total} folders`,
  hideMembers: 'Hide folders',
  membersMore: (n) => `${n.toLocaleString()} more not shown. They are cleaned up together with the ones shown.`,
  selectItem: (label) => `Select ${label}`,
  host: 'On the host',
  noSnapshots: 'No snapshots or exports.',
  selectAllSnapshots: 'Select all snapshots',

  // Selection bar
  selected: (n) => `${n} selected`,
  canBeRecovered: (estimate) => `${estimate} can be recovered`,
  selectAllEligible: 'Select everything that can be cleaned up',
  clear: 'Clear',
  reviewCleanup: 'Review cleanup',
  selectionBarLabel: 'Cleanup selection',

  // Review dialog
  reviewTitle: 'Review cleanup',
  reviewDescription: 'Only the items listed here are removed. Everything else stays as it is. Before each item is removed it is checked again; anything that changed or became protected is skipped.',
  removeFromCleanup: (label) => `Remove ${label} from the cleanup`,
  estimateTitle: 'Space that can be recovered',
  cancel: 'Cancel',
  close: 'Close',
  cleanUp: (n) => `Clean up ${n} ${n === 1 ? 'item' : 'items'}`,
  starting: 'Starting…',
  reviewEmpty: 'Nothing is selected. Close this window and choose what to clean up.',
  notEligibleTitle: 'Some items can no longer be cleaned up',
  runNewCheck: 'Run a new check',

  // Progress and result
  progressTitle: 'Cleaning up',
  queued: 'Waiting to start…',
  running: 'Cleaning up… This can take a few minutes. You can close this window; the cleanup keeps running.',
  resultTitle: 'Cleanup result',
  resultStatus: {
    succeeded: 'Cleanup finished.',
    partial: 'Cleanup finished, but some items were skipped or failed.',
    failed: 'Cleanup did not finish.',
    refused: 'Cleanup was refused. Nothing was removed.',
    cancelled: 'Cleanup was cancelled.',
  },
  removed: 'Removed',
  skipped: 'Skipped',
  failed: 'Failed',
  noneRemoved: 'Nothing was removed.',
  health: 'Health check',
  healthText: {
    passed: 'The application is running and answered its health check.',
    failed: 'The application did not pass its health check after the cleanup. Nothing was rolled back; look at it now.',
    'not-checked': 'The health check did not run.',
  },
  remaining: 'Storage now',
  reclaimed: 'Space reclaimed (measured)',
  estimated: 'Estimated before',
  settling: 'The filesystem may still be releasing space, or snapshots still hold it; check again in a few minutes.',
  recentEvents: 'What happened',
  pastCleanups: 'Past cleanups',
  noPastCleanups: 'No cleanups yet.',
  viewResult: 'View result',
  origin: { user: 'By an administrator', policy: 'By a cleanup rule', cleanup: 'After a cleanup', mcp: 'Through MCP' },
  cleanupStatus: { queued: 'Waiting', running: 'Running', succeeded: 'Finished', partial: 'Finished with skips', failed: 'Failed', refused: 'Refused', cancelled: 'Cancelled' },

  // Tabs
  tabStorage: 'Storage',
  tabRules: 'Rules and alerts',
  tabHistory: 'Past cleanups',

  // Overview extras
  colActions: 'Actions',
  usedSize: (size) => `${size} used`,
  cleanableSize: (size) => `${size} can be cleaned up`,
  forName: (name) => ` for ${name}`,
  ofName: (name) => ` of ${name}`,
  policyChip: {
    'defaults-existing': 'Rules proposed — none running',
    'defaults-new': 'Default rules on',
    edited: 'Rules changed by an administrator',
  },

  // Detail extras
  partialChip: 'Partly measured',
  failedChip: 'Check did not finish',
  onDiskShort: 'on disk',
  recoverable: (size) => `about ${size} can be recovered`,
  whatUsesStorageHint: 'Open a category to see its items. Only items marked "Can be cleaned up" have a checkbox, and none is selected until you choose.',
  inCategory: (label) => `in ${label}`,
  ackPending: 'Confirm the snapshot warning to continue.',

  // Review extras
  cleanupRefused: 'The cleanup was not started',
  approvalCancelled: 'Approval was cancelled. Nothing was changed.',
  removeRefused: 'Remove these from the cleanup',

  // Result extras
  cleaningUpShort: 'Cleaning up…',
  usedOfAvailable: (used, available) => `${used} used, ${available} available`,
  removedCount: (n) => `${n} removed`,
  skippedCount: (n) => `${n} skipped`,
  failedCount: (n) => `${n} failed`,
  reclaimedShort: (size) => `${size} reclaimed`,

  // Links from other pages
  storageLink: 'Storage',
  storageLinkHint: 'See what uses this project’s storage and clean up what is no longer needed.',
  storageLinkApplicationHint: 'See what uses this application’s storage and clean up what is no longer needed.',
};

// Estimate notes (DESIGN §2.4).
export const ESTIMATE_NOTES = {
  snapshotsHold: 'Space held by snapshots is only returned after those snapshots are deleted.',
  memory: (size) => `Some selected items use memory, not disk. Removing them frees about ${size} of memory.`,
  partial: 'Some sizes are at least what is shown, because not every folder could be measured.',
  journal: 'System logs are reduced to the size limit; the space recovered is an estimate.',
  allSnapshots: 'All snapshots are selected, so the space they hold together is counted.',
  counted: 'Files linked from several places are counted once.',
};

/* ------------------------------ retention ------------------------------ */

export const RULE_STATE_LABELS = { on: 'On', proposed: 'Proposed', off: 'Off' };
// `when` is the rule's RULE_TEXT[...].when phrase.
export const RULE_STATE_HINTS = {
  on: (when) => `On: it runs ${when}.`,
  proposed: (when) => `Suggested. Nothing runs until you turn it on; then it runs ${when}.`,
  off: (when) => `Turned off. Nothing runs. Once on, it runs ${when}.`,
};

export const POLICY_SOURCE_LABELS = {
  'defaults-new': () => 'Defaults for new applications',
  'defaults-existing': () => 'Proposed for this existing application — nothing runs until you turn it on',
  preserved: (name) => `Kept from ${name || 'this application'}'s existing settings`,
  edited: () => 'Changed by an administrator',
};

export const RULE_TEXT = {
  releases: {
    title: 'Old releases',
    description: 'Keeps the running release and the newest older releases, up to the number you choose. The release you can roll back to, a release waiting to be deployed and folders that hold shared data are always kept.',
    when: 'during each release build',
    fields: { keepReleases: 'Releases to keep (2 to 20)' },
    trimBeforeSeal: 'Removed from a new release before it is sealed',
    projectNote: 'Dev Studio projects have no sealed releases, so this rule has no effect here.',
  },
  snapshots: {
    title: 'Snapshots (restore points)',
    description: 'Keeps the newest snapshots and deletes older ones whenever a new snapshot is taken.',
    when: 'whenever a snapshot is taken',
    fields: { keep: 'Snapshots to keep (1 to 1000)' },
  },
  workspaces: {
    title: 'Abandoned build workspaces',
    description: 'Removes build workspaces and transfer copies left behind by builds that have ended.',
    when: 'during builds and every 6 hours',
    fields: { abandonedAfterHours: 'Remove when unused for (hours)' },
  },
  caches: {
    title: 'Caches',
    description: 'Removes downloaded files that are fetched again when needed, such as package and browser downloads, once they have not changed for a while.',
    when: 'every 6 hours',
    fields: { maxAgeDays: 'Remove when unchanged for (days)' },
  },
  tempFiles: {
    title: 'Temporary files',
    description: 'Removes temporary files that nothing is using and that have not changed for a while.',
    when: 'every 6 hours',
    fields: { maxAgeDays: 'Remove when unchanged for (days)' },
  },
  testArtifacts: {
    title: 'Test reports',
    description: 'Removes old test results and reports that are not part of the source.',
    when: 'every 6 hours',
    fields: { maxAgeDays: 'Remove when older than (days)' },
  },
  logs: {
    title: 'Logs',
    description: 'Removes old rotated log files and keeps the system logs under a size limit.',
    when: 'every 6 hours',
    fields: { rotatedMaxAgeDays: 'Remove rotated logs older than (days)', journalMaxMB: 'System log size limit (MB)' },
  },
  history: {
    title: 'Execution history',
    description: 'Removes old database and settings copies taken before changes, always keeping the newest ones.',
    when: 'every 6 hours',
    fields: { keepNewest: 'Always keep the newest', maxAgeDays: 'Remove when older than (days)' },
  },
};

export const ALERT_TEXT = {
  title: 'Storage alerts',
  description: 'Sends a notification through your notification channels when this application uses more storage than the warning level, or grows quickly. Alerts only notify; they never block anything.',
  enabled: 'Send storage alerts',
  warnGb: 'Warning level (GB)',
  growthGb: 'Growth alert (GB)',
  growthWindowHours: 'Within (hours)',
  summary: (warn, growth, hours) => `Warns above ${warn}, or when it grows by ${growth} within ${hours} ${hours === 1 ? 'hour' : 'hours'}.`,
  off: 'Alerts are off.',
};

export const POLICY_TEXT = {
  title: 'Cleanup rules',
  description: 'Rules clean up automatically once you turn them on. A proposed rule only shows what it would do.',
  turnOn: 'Turn on',
  turnOff: 'Turn off',
  save: 'Save',
  saved: 'Saved.',
  effectsTitle: 'If it ran now',
  effectsForSaved: 'Shown for the saved settings. Save to see the effect of your changes.',
  effect: (items, size) => (items ? `Would remove ${items} ${items === 1 ? 'item' : 'items'}, ${size}, now.` : 'Nothing would be removed now.'),
  effectExamples: (examples) => `For example: ${examples.join(', ')}.`,
  effectUnknown: 'Run a storage check to see what this rule would do.',
  invalid: 'Check the highlighted values.',
  range: (min, max) => (max == null ? `Enter a whole number of at least ${min}.` : `Enter a whole number from ${min} to ${max}.`),
  positive: 'Enter a number greater than 0.',
  revisionConflict: 'Someone else changed these rules. The latest version is shown; make your change again.',
  loadFailed: 'Could not load the rules.',
  loading: 'Loading the rules…',
};
