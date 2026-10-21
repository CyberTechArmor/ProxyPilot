// Pure model of the Application storage pages (WS3): selection state, the
// all-eligible scope, snapshot acknowledgement, the explicit request body, the
// estimate and formatting. Imports the frontend module like
// application-release-ui-model.test.js does, and the shared Nodus-like
// fixture the browser journey uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySelection, selectionFor, selectItem, deselectItem, toggleItem, selectMany, isSelected, selectedCount,
  selectCategory, deselectCategory, categoryIds, categorySelectionState, allEligibleIds, selectAllEligible,
  allSnapshotIds, selectAllSnapshots, clearSelection, acknowledgeSnapshots, needsAcknowledgement,
  cleanupRequest, selectionScope, reviewGroups, estimateSelection, estimateText, selectionSummary,
  canSelect, listOf, categoryRows, groupMembers, formatBytes, formatSize, formatAge, checkIsStale,
  parseTargetKey, targetKeyOf, storageHref, headerFigures, ruleState, ruleForm, validateRuleForm, withRule,
  ruleFormChanged, alertsForm, validateAlertsForm, withAlerts, alertsFormChanged, gbToBytes, bytesToGb,
  effectFor, isCheckRunning, isCheckFinished, isCleanupFinished, NOTHING_SELECTED, ALL_ELIGIBLE_SCOPE,
  RULE_FIELDS, ALERT_LIMITS, effectNote, cleanupEvents, reclaimedFigure, groupMemberNoun, itemHint, reclaimedParts, figureLabel,
} from '../../../frontend/src/components/app-storage/app-storage-model.mjs';
import { validatePolicy } from '../lib/app-storage/policy.js';
import {
  STATUS_LABELS, CATEGORY_LABELS, SNAPSHOT_WARNING, POLICY_SOURCE_LABELS, RULE_TEXT, TEXT, RULE_STATE_HINTS, POLICY_TEXT, SUB_LABELS, FIGURE_LABELS,
} from '../../../frontend/src/components/app-storage/app-storage-text.js';
import { nodusCheck, nodusPolicy, nodusEffects } from '../../../frontend/tests/fixtures/app-storage-fixture.mjs';

const NOW = Date.parse('2026-10-20T23:00:00Z');
const check = nodusCheck(NOW);
const byLabel = (label) => check.items.find((i) => i.label === label);
const OLD_RELEASE = byLabel('Release 9d1e7a0c');
const CACHE = byLabel('npm downloads');
const SNAP = byLabel('pp-mcp-pre-resources-20261012-0912');
const SNAP2 = byLabel('pp-pre-restore-62348a2a-k2j1');
const EXPORT = byLabel('pp-nodus-20261019.tar.zst');
const LIVE = byLabel('Live release 3c932650');
const LEFTOVER = byLabel('/opt/nodus-w48');
const JOURNAL = byLabel('System logs (journal)');

test('nothing is preselected and an empty selection sends no request', () => {
  const sel = selectionFor(check, null);
  assert.equal(sel.checkId, check.checkId);
  assert.equal(selectedCount(sel), 0);
  assert.equal(check.items.some((i) => isSelected(sel, i.id)), false);
  const r = cleanupRequest(check, sel);
  assert.equal(r.send, false);
  assert.equal(r.reason, 'nothing-selected');
  assert.equal(r.message, NOTHING_SELECTED);
  assert.equal(NOTHING_SELECTED, 'Nothing was selected, so nothing was changed.');
  assert.equal(selectionSummary(check, sel), '0 selected');
});

test('only "Can be cleaned up" items can be selected', () => {
  for (const item of [LIVE, LEFTOVER, byLabel('Database files'), byLabel('Rollback release 62a4fbff'), byLabel('Adopted checkout c5adcdaf'), byLabel('tsx-989')]) {
    assert.equal(canSelect(item), false, item.label);
    assert.equal(selectedCount(selectItem(check, null, item.id)), 0, item.label);
  }
  const pseudo = check.items.find((i) => i.kind === 'pseudo');
  assert.equal(canSelect(pseudo), false);
  assert.equal(canSelect({ ...OLD_RELEASE }), true);
  assert.equal(selectedCount(selectItem(check, null, 'not-an-id')), 0);
});

test('select one, several, deselect and toggle', () => {
  let sel = selectItem(check, null, OLD_RELEASE.id);
  assert.equal(selectedCount(sel), 1);
  assert.equal(isSelected(sel, OLD_RELEASE.id), true);
  sel = selectItem(check, sel, OLD_RELEASE.id);
  assert.equal(selectedCount(sel), 1, 'selecting twice keeps one entry');
  sel = selectMany(check, sel, [CACHE.id, JOURNAL.id, LIVE.id]);
  assert.equal(selectedCount(sel), 3, 'the protected live release is ignored');
  sel = deselectItem(check, sel, CACHE.id);
  assert.deepEqual(sel.items, [OLD_RELEASE.id, JOURNAL.id]);
  sel = toggleItem(check, sel, JOURNAL.id);
  assert.deepEqual(sel.items, [OLD_RELEASE.id]);
  sel = toggleItem(check, sel, JOURNAL.id);
  assert.deepEqual(sel.items, [OLD_RELEASE.id, JOURNAL.id]);
  const r = cleanupRequest(check, sel);
  assert.equal(r.send, true);
  assert.deepEqual(r.body, { checkId: check.checkId, items: [OLD_RELEASE.id, JOURNAL.id], snapshots: [], exports: [], acknowledgeSnapshotLoss: false, scope: 'items' });
});

test('one item picked by hand is scope "items" even when it is alone in its category', () => {
  assert.equal(categoryIds(check, 'releases').length, 1);
  const sel = selectItem(check, null, OLD_RELEASE.id);
  assert.equal(cleanupRequest(check, sel).body.scope, 'items');
  assert.equal(cleanupRequest(check, selectCategory(check, null, 'releases')).body.scope, 'categories');
  assert.equal(cleanupRequest(check, selectItem(check, selectCategory(check, null, 'caches'), JOURNAL.id)).body.scope, 'items');
});

test('select and deselect a whole category', () => {
  const ids = categoryIds(check, 'caches');
  assert.equal(ids.length, 4);
  assert.equal(categorySelectionState(check, null, 'caches'), 'none');
  let sel = selectCategory(check, null, 'caches');
  assert.equal(categorySelectionState(check, sel, 'caches'), 'all');
  assert.deepEqual(sel.items, ids);
  assert.equal(selectionScope(check, sel), 'categories');
  sel = deselectItem(check, sel, CACHE.id);
  assert.equal(categorySelectionState(check, sel, 'caches'), 'some');
  assert.equal(selectionScope(check, sel), 'items');
  sel = selectCategory(check, sel, 'temp');
  sel = selectCategory(check, sel, 'caches');
  assert.equal(selectionScope(check, sel), 'categories');
  assert.equal(cleanupRequest(check, sel).body.scope, 'categories');
  sel = deselectCategory(check, sel, 'caches');
  assert.equal(categorySelectionState(check, sel, 'caches'), 'none');
  // Protected-only and needs-a-look categories offer nothing to select.
  assert.equal(categorySelectionState(check, sel, 'running_app'), 'unavailable');
  assert.equal(categorySelectionState(check, sel, 'other'), 'unavailable');
  // Selecting the snapshot category goes to the snapshot list, never the file list.
  const snaps = selectCategory(check, null, 'snapshots');
  assert.deepEqual(snaps.items, []);
  assert.deepEqual(snaps.snapshots, [SNAP.id, SNAP2.id]);
});

test('all eligible = every "Can be cleaned up" item except Snapshots and Exports', () => {
  assert.equal(ALL_ELIGIBLE_SCOPE, 'Every item marked "Can be cleaned up" in this check, in every category except Snapshots and Exports.');
  const ids = allEligibleIds(check);
  const expected = check.items.filter((i) => i.status === 'eligible' && !['snapshots', 'exports'].includes(i.category)).map((i) => i.id);
  assert.deepEqual(ids, expected);
  assert.equal(ids.length, 17);
  const sel = selectAllEligible(check, null);
  assert.equal(sel.items.length, 17);
  assert.deepEqual(sel.snapshots, []);
  assert.deepEqual(sel.exports, []);
  assert.equal(isSelected(sel, SNAP.id), false);
  assert.equal(isSelected(sel, EXPORT.id), false);
  assert.equal(isSelected(sel, LIVE.id), false);
  assert.equal(isSelected(sel, LEFTOVER.id), false);
  const r = cleanupRequest(check, sel);
  assert.equal(r.send, true);
  assert.equal(r.body.scope, 'all-eligible');
  assert.deepEqual(r.body.snapshots, []);
  assert.equal(r.body.acknowledgeSnapshotLoss, false);
  // Deselecting one turns the recorded scope into an explicit item list.
  const less = deselectItem(check, sel, CACHE.id);
  const r2 = cleanupRequest(check, less);
  assert.equal(r2.body.items.includes(CACHE.id), false);
  assert.equal(r2.body.items.length, 16);
  assert.equal(r2.body.scope, 'items');
});

test('snapshots are a separate selection that requires an acknowledgement', () => {
  assert.equal(SNAPSHOT_WARNING, 'Deleting a snapshot removes the option to restore to that point. This cannot be undone.');
  assert.equal(listOf(SNAP), 'snapshots');
  assert.equal(listOf(EXPORT), 'exports');
  let sel = selectItem(check, null, SNAP.id);
  assert.deepEqual(sel.items, []);
  assert.deepEqual(sel.snapshots, [SNAP.id]);
  assert.equal(needsAcknowledgement(sel), true);
  const refused = cleanupRequest(check, sel);
  assert.equal(refused.send, false);
  assert.equal(refused.reason, 'acknowledgement-required');
  sel = acknowledgeSnapshots(sel, true);
  const ok = cleanupRequest(check, sel);
  assert.equal(ok.send, true);
  assert.deepEqual(ok.body.snapshots, [SNAP.id]);
  assert.equal(ok.body.acknowledgeSnapshotLoss, true);
  assert.deepEqual(ok.body.items, []);
  // Removing the last snapshot clears the acknowledgement, so a later
  // snapshot selection asks again.
  sel = deselectItem(check, sel, SNAP.id);
  assert.equal(sel.acknowledged, false);
  sel = selectItem(check, sel, SNAP2.id);
  assert.equal(cleanupRequest(check, sel).reason, 'acknowledgement-required');
  // An acknowledgement without snapshots means nothing.
  assert.equal(acknowledgeSnapshots(emptySelection(check.checkId), true).acknowledged, false);
  // Select all snapshots selects only snapshots.
  const all = selectAllSnapshots(check, selectItem(check, null, CACHE.id));
  assert.deepEqual(all.snapshots, allSnapshotIds(check));
  assert.deepEqual(all.items, [CACHE.id]);
  assert.deepEqual(all.exports, []);
});

test('exports are selected on their own list and need no acknowledgement', () => {
  const sel = selectItem(check, null, EXPORT.id);
  assert.deepEqual(sel.exports, [EXPORT.id]);
  const r = cleanupRequest(check, sel);
  assert.equal(r.send, true);
  assert.deepEqual(r.body.exports, [EXPORT.id]);
  assert.equal(r.body.acknowledgeSnapshotLoss, false);
});

test('a selection belongs to one check and clears when a new check replaces it', () => {
  const sel = selectItem(check, null, OLD_RELEASE.id);
  const next = nodusCheck(NOW + 60000, { checkId: 'chk_00000000-0000-4000-8000-000000000001' });
  assert.equal(selectedCount(selectionFor(next, sel)), 0);
  assert.equal(cleanupRequest(next, sel).send, false);
  assert.equal(selectedCount(clearSelection(check)), 0);
  assert.equal(cleanupRequest(null, sel).send, false);
});

test('review groups list the exact selection by category in display order', () => {
  let sel = selectMany(check, null, [SNAP.id, CACHE.id, OLD_RELEASE.id, EXPORT.id]);
  const groups = reviewGroups(check, sel);
  assert.deepEqual(groups.map((g) => g.key), ['releases', 'caches', 'snapshots', 'exports']);
  assert.equal(groups[0].label, CATEGORY_LABELS.releases);
  assert.deepEqual(groups.flatMap((g) => g.items.map((i) => i.id)).sort(), [SNAP.id, CACHE.id, OLD_RELEASE.id, EXPORT.id].sort());
  sel = deselectItem(check, sel, CACHE.id);
  assert.deepEqual(reviewGroups(check, sel).map((g) => g.key), ['releases', 'snapshots', 'exports']);
});

test('estimate: disk vs memory, journal estimate, snapshot-held notes and precision words', () => {
  const one = estimateSelection(check, selectItem(check, null, OLD_RELEASE.id));
  assert.equal(one.diskBytes, 497e6);
  assert.equal(one.memoryBytes, 0);
  assert.equal(one.precision, 'about');
  assert.ok(one.notes.some((n) => /snapshots is only returned/.test(n)), 'snapshot-held note when files are selected and snapshots exist');
  assert.equal(estimateText(one), 'about 497 MB');
  const journal = estimateSelection(check, selectItem(check, null, JOURNAL.id));
  assert.equal(journal.diskBytes, 356e6, 'journal vacuum counts usage minus the limit');
  assert.ok(journal.notes.some((n) => /System logs/.test(n)));
  const tmp = estimateSelection(check, selectMany(check, null, [byLabel('Abandoned browser download').id, OLD_RELEASE.id]));
  assert.equal(tmp.memoryBytes, 137.6e6);
  assert.equal(tmp.diskBytes, 497e6);
  assert.equal(estimateText(tmp), 'about 497 MB of disk and 138 MB of memory');
  assert.ok(tmp.notes.some((n) => /memory, not disk/.test(n)));
  const all = estimateSelection(check, selectAllSnapshots(check, null));
  assert.equal(all.snapshotBytes, 412e6, 'all snapshots selected → the space they hold together');
  const partialCheck = { ...check, items: check.items.map((i) => (i.id === CACHE.id ? { ...i, precision: 'at-least' } : i)) };
  const atLeast = estimateSelection(partialCheck, selectItem(partialCheck, null, CACHE.id));
  assert.equal(atLeast.precision, 'at-least');
  assert.equal(estimateText(atLeast), 'at least 118 MB');
  assert.equal(selectionSummary(check, selectItem(check, null, OLD_RELEASE.id)), '1 selected · about 497 MB can be recovered');
});

test('formatting: decimal sizes, precision words, ages and staleness', () => {
  assert.equal(formatBytes(0), '0 bytes');
  assert.equal(formatBytes(1), '1 byte');
  assert.equal(formatBytes(999), '999 bytes');
  assert.equal(formatBytes(1000), '1 KB');
  assert.equal(formatBytes(137.6e6), '138 MB');
  assert.equal(formatBytes(41.4e6), '41.4 MB');
  assert.equal(formatBytes(497e6), '497 MB');
  assert.equal(formatBytes(3.61e9), '3.6 GB');
  assert.equal(formatBytes(236422037504), '236 GB');
  assert.equal(formatBytes(999.96e6), '1 GB');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatSize(2e9, 'at-least'), 'at least 2 GB');
  assert.equal(formatSize(2e9, 'estimate'), 'about 2 GB');
  assert.equal(formatSize(2e9, 'exact'), '2 GB');
  assert.equal(formatAge(NOW - 20000, NOW), 'just now');
  assert.equal(formatAge(NOW - 5 * 60000, NOW), '5 minutes ago');
  assert.equal(formatAge(NOW - 3600000, NOW), '1 hour ago');
  assert.equal(formatAge(NOW - 3 * 86400000, NOW), '3 days ago');
  assert.equal(checkIsStale(check, NOW), false);
  assert.equal(checkIsStale(check, NOW + 61 * 60000), true);
});

test('target keys and links', () => {
  assert.deepEqual(parseTargetKey('application:1'), { kind: 'application', id: '1', key: 'application:1' });
  assert.equal(parseTargetKey('project:0'), null);
  assert.equal(parseTargetKey('host:1'), null);
  assert.equal(parseTargetKey('application:1/../x'), null);
  assert.equal(targetKeyOf('project', 7), 'project:7');
  assert.equal(storageHref('application', 1), '/storage/applications?target=application%3A1');
  assert.equal(storageHref('nope', 1), '/storage/applications');
});

test('categories in fixed order with groups showing their first 50 members', () => {
  const rows = categoryRows(check);
  assert.deepEqual(rows.map((r) => r.key), ['running_app', 'dependencies', 'data', 'releases', 'workspaces', 'archives', 'caches', 'test_reports', 'temp', 'logs', 'history', 'snapshots', 'exports', 'other']);
  assert.equal(rows.find((r) => r.key === 'test_reports').status, 'empty');
  assert.equal(rows.find((r) => r.key === 'releases').status, 'mixed');
  assert.equal(rows.find((r) => r.key === 'snapshots').separate, true);
  const group = byLabel('nodus-embed-* (263 folders)');
  const m = groupMembers(group);
  assert.equal(m.shown.length, 50);
  assert.equal(m.total, 263);
  assert.equal(m.hidden, 213);
  const h = headerFigures(check);
  assert.equal(h.snapshotsBytes, 412e6);
  assert.equal(h.memoryBacked[0].mount, '/tmp');
  assert.equal(h.onDiskBytes, 3.95e9);
  assert.equal(h.fileSizeBytes, 7.4e9);
});

test('statuses and states', () => {
  assert.deepEqual(STATUS_LABELS, { protected: 'Protected', eligible: 'Can be cleaned up', investigate: 'Needs a look' });
  assert.equal(isCheckRunning('running'), true);
  assert.equal(isCheckFinished('partial'), true);
  assert.equal(isCleanupFinished('partial'), true);
  assert.equal(isCleanupFinished('running'), false);
});

test('policy: rule states, forms, ranges and the proposed source', () => {
  const policy = nodusPolicy();
  assert.equal(ruleState(policy.rules.releases, 'preserved'), 'on');
  assert.equal(ruleState(policy.rules.caches, 'preserved'), 'proposed');
  assert.equal(ruleState(policy.rules.caches, 'defaults-existing'), 'proposed');
  assert.equal(ruleState(policy.rules.caches, 'edited'), 'off');
  assert.equal(ruleState(policy.rules.caches, 'edited', true), 'proposed', 'the server list wins');
  assert.equal(ruleState(policy.rules.caches, 'preserved', false), 'off');
  assert.equal(ruleState(policy.rules.releases, 'edited', true), 'on');
  assert.equal(POLICY_SOURCE_LABELS['defaults-existing'](), 'Proposed for this existing application — nothing runs until you turn it on');
  assert.equal(POLICY_SOURCE_LABELS.preserved('Nodus'), "Kept from Nodus's existing settings");
  assert.equal(POLICY_SOURCE_LABELS['defaults-new'](), 'Defaults for new applications');
  assert.ok(Object.keys(RULE_TEXT).every((k) => RULE_TEXT[k].description.length > 20));
  const form = ruleForm(policy, 'releases');
  assert.deepEqual(form, { keepReleases: '2' });
  assert.deepEqual(validateRuleForm('releases', { keepReleases: '1' }), { keepReleases: { min: 2, max: 20 } });
  assert.deepEqual(validateRuleForm('releases', { keepReleases: '21' }), { keepReleases: { min: 2, max: 20 } });
  assert.deepEqual(validateRuleForm('releases', { keepReleases: '2.5' }), { keepReleases: { min: 2, max: 20 } });
  assert.deepEqual(validateRuleForm('releases', { keepReleases: '5' }), {});
  assert.equal(ruleFormChanged(policy, 'releases', { keepReleases: '5' }), true);
  const turnedOn = withRule(policy, 'caches', ruleForm(policy, 'caches'), true);
  assert.equal(turnedOn.rules.caches.enabled, true);
  assert.equal(turnedOn.rules.caches.maxAgeDays, 14);
  assert.equal(policy.rules.caches.enabled, false, 'the saved policy object is not mutated');
  assert.deepEqual(turnedOn.rules.releases, policy.rules.releases, 'other rules are left as they are');
  const edited = withRule(policy, 'logs', { rotatedMaxAgeDays: '30', journalMaxMB: '512' });
  assert.deepEqual(edited.rules.logs, { enabled: false, rotatedMaxAgeDays: 30, journalMaxMB: 512 });
});

test('policy: alert thresholds in GB and the effects preview', () => {
  const policy = nodusPolicy();
  const form = alertsForm(policy);
  assert.deepEqual(form, { enabled: true, warnGb: '10', growthGb: '2', growthWindowHours: '24' });
  assert.equal(alertsFormChanged(policy, form), false);
  assert.deepEqual(validateAlertsForm({ ...form, warnGb: '0' }), { warnGb: { gb: true, min: 0.1, max: 1e6 } });
  assert.deepEqual(validateAlertsForm({ ...form, warnGb: '0.05' }), { warnGb: { gb: true, min: 0.1, max: 1e6 } }, 'below the server minimum of 1e8 bytes');
  assert.deepEqual(validateAlertsForm({ ...form, growthGb: '0.01' }), {});
  assert.deepEqual(validateAlertsForm({ ...form, growthWindowHours: '0' }), { growthWindowHours: { min: 1, max: 720 } });
  const next = withAlerts(policy, { ...form, warnGb: '12.5' });
  assert.equal(next.alerts.warnBytes, 12.5e9);
  assert.equal(alertsFormChanged(policy, { ...form, warnGb: '12.5' }), true);
  assert.equal(gbToBytes('10'), 10e9);
  assert.equal(bytesToGb(10e9), '10');
  assert.equal(effectFor(nodusEffects(), 'tempFiles').items, 4);
  assert.equal(effectFor({ caches: { items: 1 } }, 'caches').items, 1);
  assert.equal(effectFor(null, 'caches'), null);
});

test('plain language: no jargon in the user-facing text', async () => {
  const text = await import('../../../frontend/src/components/app-storage/app-storage-text.js');
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (typeof v === 'function') { let out; try { out = v(2, 'x', 3); } catch { out = v(['x', 'y']); } walk(out); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  // CATEGORY_ORDER holds API keys, not words on screen.
  for (const [name, value] of Object.entries(text)) if (name !== 'CATEGORY_ORDER') walk(value);
  assert.ok(strings.length > 150);
  for (const jargon of ['eligible', 'dedupe', 'inode', 'allocated', 'tmpfs', 'logical']) {
    assert.deepEqual(strings.filter((s) => new RegExp(jargon, 'i').test(s)), [], jargon);
  }
});

test('the policy form accepts exactly what the backend schema accepts (bounds of every field)', () => {
  const base = nodusPolicy();
  const valid = (policy) => { try { validatePolicy(policy); return true; } catch { return false; } };
  assert.equal(valid(base), true);
  for (const [rule, fields] of Object.entries(RULE_FIELDS)) {
    for (const f of fields) {
      for (const [value, ok] of [[f.min, true], [f.max, true], [f.min - 1, false], [f.max + 1, false]]) {
        const form = { ...ruleForm(base, rule), [f.key]: String(value) };
        assert.equal(Object.keys(validateRuleForm(rule, form)).length === 0, ok, `form ${rule}.${f.key}=${value}`);
        assert.equal(valid(withRule(base, rule, form)), ok, `server ${rule}.${f.key}=${value}`);
      }
    }
  }
  for (const [key, lim] of Object.entries(ALERT_LIMITS)) {
    for (const [value, ok] of [[lim.min, true], [lim.max, true]]) {
      const form = { ...alertsForm(base), [key]: String(value) };
      assert.deepEqual(validateAlertsForm(form), {}, `form alerts.${key}=${value}`);
      assert.equal(valid(withAlerts(base, form)), ok, `server alerts.${key}=${value}`);
    }
  }
});

test('effects notes that only restate the count are not repeated; job events are plain; reclaimed never negative', () => {
  assert.equal(effectNote({ note: 'Would remove 3 items, about 32.8 kB, now.' }), null);
  assert.equal(effectNote({ note: 'Nothing to remove now.' }), null);
  assert.equal(effectNote({ note: 'Keeps the newest 3; there is nothing to delete now.' }), 'Keeps the newest 3; there is nothing to delete now.');
  assert.equal(effectNote({}), null);
  const events = cleanupEvents({ events: [
    { kind: 'created', message: 'storage_cleanup for pp-nodus requested via ui by 1' }, { kind: 'claimed', message: null },
    { kind: 'step', message: 'Cleaning up /tmp/nodus-embed-* (6 folders)' }, { kind: 'checkpoint', phase: 'cleanup:item', message: 'cleanup:item' },
    { kind: 'step', message: 'Checking that the application is still healthy' }, { kind: 'finished', message: 'Storage cleanup succeeded: 3 removed, 0 skipped, 0 failed; health passed.' },
  ] });
  assert.deepEqual(events.map((e) => e.message), ['Cleaning up /tmp/nodus-embed-* (6 folders)', 'Checking that the application is still healthy', 'Storage cleanup succeeded: 3 removed, 0 skipped, 0 failed; health passed.']);
  assert.equal(reclaimedFigure(-4096), 0);
  assert.equal(reclaimedFigure(65536), 65536);
  assert.equal(reclaimedFigure(null), null);
});

test('"Some can be cleaned up" only when a category has something that can be (review 12)', () => {
  const protectedItem = { ...byLabel('/usr'), category: 'other' };
  const look = byLabel('/opt/nodus-w48');
  const mixedNothing = { checkId: 'chk_x', categories: [{ key: 'other', label: 'Other or unclassified', status: 'mixed' }], items: [protectedItem, look] };
  assert.equal(categoryRows(mixedNothing).find((r) => r.key === 'other').status, 'investigate');
  const mixedProtected = { checkId: 'chk_x', categories: [{ key: 'other', status: 'mixed' }], items: [protectedItem] };
  assert.equal(categoryRows(mixedProtected)[0].status, 'protected');
  assert.equal(categoryRows(check).find((r) => r.key === 'releases').status, 'mixed', 'a real mix keeps its status');
});

test('groups say files or folders from their members; the memory note is not repeated as a hint (review 18)', () => {
  assert.equal(groupMemberNoun(byLabel('nodus-embed-* (263 folders)')), 'folders');
  assert.equal(groupMemberNoun({ members: [{ kind: 'file' }, { kind: 'file' }] }), 'files');
  assert.equal(groupMemberNoun({ members: [{ kind: 'file' }, { kind: 'directory' }] }), 'entries');
  assert.equal(groupMemberNoun({}), 'entries');
  assert.equal(groupMemberNoun({ memberKind: 'files', members: [{ kind: 'directory' }] }), 'files', "the check's memberKind wins");
  assert.equal(groupMemberNoun({ memberKind: 'entries' }), 'entries');
  assert.equal(groupMemberNoun({ memberKind: 'nonsense', members: [{ kind: 'file' }] }), 'files', 'an unknown memberKind falls back to the members');
  assert.equal(TEXT.showMembers(6, 6, 'files'), 'Show all 6 files');
  assert.equal(TEXT.showMembers(50, 263, 'folders'), 'Show 50 of 263 folders');
  assert.equal(TEXT.hideMembers('files'), 'Hide files');
  assert.equal(itemHint({ memoryBacked: true, hint: 'Uses memory, not disk.' }), null);
  assert.equal(itemHint({ memoryBacked: false, hint: 'Tests download it again.' }), 'Tests download it again.');
  assert.equal(itemHint({ memoryBacked: true, hint: 'A leftover download.' }), 'A leftover download.');
});

test('used figures are named by what they measure; rules say who changed them and when (review 17, 24, 28)', () => {
  assert.equal(TEXT.colUsedNow, 'Disk used now');
  assert.equal(TEXT.usedNowHint, 'on disk, with snapshots');
  assert.equal(TEXT.usedSize('3.6 GB'), '3.6 GB of files in the container');
  assert.equal(TEXT.used, 'Used by files');
  assert.equal(TEXT.onDisk, 'On disk, with snapshots');
  assert.equal(POLICY_TEXT.changed('5 minutes ago', 'Oct 21, 2026, 1:00 AM', 'admin'), 'Last changed 5 minutes ago (Oct 21, 2026, 1:00 AM) by admin.');
  assert.equal(POLICY_TEXT.changed('just now', 'x', null), 'Last changed just now (x).');
  assert.match(POLICY_TEXT.noCheckNudge, /you can still turn a rule on/);
  assert.equal(RULE_STATE_HINTS.on(RULE_TEXT.snapshots.when), 'On: it runs whenever a snapshot is taken, and each time ProxyPilot starts.');
  assert.equal(RULE_STATE_HINTS.off(RULE_TEXT.releases.when), 'Turned off. Nothing runs. Once on, it runs during each release build.');
  // No text promises a built-in minimum that keeps running when a rule is off (review HIGH 1).
  const words = JSON.stringify([RULE_TEXT, POLICY_TEXT.description, Object.values(RULE_STATE_HINTS).map((f) => f('x'))]);
  for (const w of ['floor', 'built-in', 'static']) assert.equal(new RegExp(w, 'i').test(words), false, w);
});

test('the measured reclaim is shown by kind: files on disk, memory, the pool with snapshots (review M8, result side)', () => {
  assert.deepEqual(reclaimedParts({ guestBytes: 65536, memoryBytes: null, datasetBytes: 0, settling: false }), [{ key: 'disk', bytes: 65536 }]);
  assert.deepEqual(reclaimedParts({ guestBytes: 0, memoryBytes: 1.1e9, datasetBytes: 0 }), [{ key: 'disk', bytes: 0 }, { key: 'memory', bytes: 1.1e9 }]);
  assert.deepEqual(reclaimedParts({ guestBytes: 0, memoryBytes: null, datasetBytes: 40e6 }, { snapshotsDeleted: true }), [{ key: 'disk', bytes: 0 }, { key: 'pool', bytes: 40e6 }]);
  assert.deepEqual(reclaimedParts({ guestBytes: 0, memoryBytes: null, datasetBytes: 0 }, { snapshotsDeleted: true }), [{ key: 'disk', bytes: 0 }, { key: 'pool', bytes: 0 }], 'a deleted snapshot always shows the pool line');
  assert.deepEqual(reclaimedParts({ guestBytes: -4096, memoryBytes: -1, datasetBytes: -1 }), [{ key: 'disk', bytes: 0 }, { key: 'memory', bytes: 0 }]);
  assert.deepEqual(reclaimedParts(null), []);
  assert.deepEqual(Object.keys(TEXT.reclaimedKinds), ['disk', 'memory', 'pool']);
});

test('categories keep disk and memory apart and leave host-wide shared items out (review M8, M9; WS1 §5)', () => {
  const temp = categoryRows(check).find((r) => r.key === 'temp');
  assert.equal(temp.allocatedBytes, 4096, 'disk: /var/tmp only');
  assert.equal(temp.memoryBytes, 203628192, '/tmp is memory');
  assert.equal(temp.eligibleMemoryBytes, 181420000);
  // A check without the split (older shape) is split from its items.
  const old = { ...check, categories: check.categories.map(({ memoryBytes, eligibleMemoryBytes, sharedHostBytes, ...c }) => (c.key === 'temp' ? { ...c, allocatedBytes: 203632288 } : c)) };
  const oldTemp = categoryRows(old).find((r) => r.key === 'temp');
  assert.equal(oldTemp.allocatedBytes, 4096);
  assert.equal(oldTemp.memoryBytes, 203628192);
  const bundle = { id: 'b'.repeat(16), category: 'archives', label: 'bundle-x', kind: 'directory', status: 'investigate', sub: 'shared', sharedHost: true, allocatedBytes: 5000, location: 'host' };
  const withShared = { checkId: 'chk_y', items: [bundle] };
  const arch = categoryRows(withShared).find((r) => r.key === 'archives');
  assert.equal(arch.allocatedBytes, 0);
  assert.equal(arch.sharedHostBytes, 5000);
  assert.equal(canSelect(bundle), false);
  assert.equal(TEXT.cleanableSize('2.1 GB', '181 MB'), '2.1 GB on disk and 181 MB in memory can be cleaned up');
  assert.equal(TEXT.cleanableSize('6.4 GB'), '6.4 GB can be cleaned up');
  assert.equal(TEXT.sharedHostShort('5 KB'), '5 KB shared by all applications, not counted here');
});

test('a pool on the host disk: figures named as the host\'s, no "not measured individually" item (review M10, 17)', () => {
  const shared = nodusCheck(NOW, { sharedHost: true });
  const h = headerFigures(shared);
  assert.equal(h.sharedHost, true);
  assert.equal(h.usedSource, 'shared-host-df');
  const withPseudo = { ...shared, items: [...shared.items, { id: 'p'.repeat(16), category: 'other', kind: 'pseudo', status: 'investigate', label: 'Not measured individually', allocatedBytes: 1e9 }] };
  assert.equal(categoryRows(withPseudo).flatMap((r) => r.items).some((i) => i.kind === 'pseudo'), false);
  assert.equal(headerFigures(check).sharedHost, false);
  assert.equal(figureLabel('incus-root-usage'), 'on disk, with snapshots');
  assert.equal(figureLabel('container-df'), 'files inside the container');
  assert.equal(figureLabel('shared-host-df'), "the host's shared disk, not this container's alone");
  assert.equal(figureLabel('something-new'), null, 'no server wording (it names df, Incus or ZFS) for an unknown source');
  assert.equal(h.containerUsedBytes, 2.1e9, "Used is the container's own figure on a shared host disk");
  assert.equal(figureLabel(undefined), null);
  assert.match(TEXT.sharedHostNotice, /not this container's alone/);
});

test('several snapshots (not all) free at least their figures; new-project defaults are explained (review 16, WS1 §1)', () => {
  const three = { ...check, items: [...check.items, { ...SNAP2, id: 'c'.repeat(16), label: 'pp-third' }] };
  const two = selectMany(three, null, [SNAP.id, SNAP2.id]);
  const est = estimateSelection(three, two);
  assert.equal(est.precision, 'at-least');
  assert.ok(est.notes.some((n) => /several snapshots together/.test(n)));
  assert.equal(estimateSelection(three, selectItem(three, null, SNAP.id)).precision, 'about', 'one snapshot is an estimate');
  assert.equal(POLICY_TEXT.defaultsNewRecorded, 'These rules were turned on when the project was created (the documented defaults).');
});

test('new item kinds get a plain note; figure labels name no tools (WS1 §3, §4; review N4)', () => {
  assert.deepEqual(Object.keys(SUB_LABELS).sort(), ['current', 'held', 'idle', 'kept', 'pending', 'recovery-set', 'rollback-unknown', 'rotated', 'shared', 'unknown']);
  assert.equal(SUB_LABELS.pending, 'Being validated');
  assert.equal(SUB_LABELS.idle, 'Nothing writes to it any more');
  for (const label of [...Object.values(SUB_LABELS), ...Object.values(FIGURE_LABELS)]) {
    assert.equal(/\b(ZFS|dataset|referenced|df|Incus)\b/i.test(label), false, label);
  }
});
