// Application storage: the fixed category list, item statuses, kinds and
// actions. Plain labels; the frontend mirrors them in its text file
// (components/app-storage/app-storage-text.js). Order is the display order.

export const CATEGORIES = Object.freeze([
  { key: 'running_app', label: 'Running application', typical: 'protected' },
  { key: 'dependencies', label: 'Dependencies', typical: 'protected' },
  { key: 'data', label: 'Application data (database, uploads, models, settings)', typical: 'protected' },
  { key: 'releases', label: 'Releases', typical: 'mixed' },
  { key: 'workspaces', label: 'Build workspaces', typical: 'mixed' },
  { key: 'archives', label: 'Source and transfer archives', typical: 'mixed' },
  { key: 'caches', label: 'Caches', typical: 'eligible' },
  { key: 'test_reports', label: 'Test reports', typical: 'mixed' },
  { key: 'temp', label: 'Temporary files', typical: 'mixed' },
  { key: 'logs', label: 'Logs', typical: 'mixed' },
  { key: 'history', label: 'Execution history', typical: 'mixed' },
  { key: 'snapshots', label: 'Snapshots (restore points)', typical: 'separate' },
  { key: 'exports', label: 'Exports (downloadable copies)', typical: 'separate' },
  { key: 'other', label: 'Other or unclassified', typical: 'investigate' },
].map(Object.freeze));

export const CATEGORY_KEYS = Object.freeze(CATEGORIES.map((c) => c.key));
const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));
export const categoryLabel = (key) => BY_KEY.get(key)?.label || key;
export const isCategory = (key) => BY_KEY.has(key);

/** Categories that are selected on their own, never by "All eligible items". */
export const SEPARATE_CATEGORIES = Object.freeze(['snapshots', 'exports']);

export const STATUSES = Object.freeze(['protected', 'eligible', 'investigate']);
export const STATUS_LABELS = Object.freeze({
  protected: 'Protected',
  eligible: 'Can be cleaned up',
  investigate: 'Needs a look',
});

export const ITEM_KINDS = Object.freeze(['directory', 'file', 'group', 'release', 'journal', 'snapshot', 'export', 'pseudo', 'link', 'other']);
export const ACTIONS = Object.freeze(['remove', 'remove-release', 'vacuum-journal', 'delete-snapshot', 'delete-export']);
export const PRECISIONS = Object.freeze(['exact', 'at-least', 'estimate']);

/** The worse of two precisions (exact < at-least < estimate). */
export function worsePrecision(a, b) {
  const rank = (p) => Math.max(0, PRECISIONS.indexOf(p || 'exact'));
  return rank(a) >= rank(b) ? (a || 'exact') : b;
}

/**
 * The order a cleanup works in: data-farthest first (temp, caches, logs,
 * history, test reports, archives, workspaces, releases). Snapshots and
 * exports come last and are always separate.
 */
export const CLEANUP_ORDER = Object.freeze(['temp', 'caches', 'logs', 'history', 'test_reports', 'archives', 'workspaces', 'releases', 'other', 'snapshots', 'exports']);
