// Application storage → one target's latest check (DESIGN §7): the header
// figures, the categories as expandable sections with their items, the
// separate "Restore points and copies" section, and the selection bar.
// Nothing is ever preselected: the selection lives in the page and every
// change goes through app-storage-model.mjs.

import { useId, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { BTN, CapacityBar, Checkbox, Chip, EmptyState, Notice } from '@/components/storage/shared';
import {
  acknowledgeSnapshots, allEligibleIds, allSnapshotIds, canSelect, categoryRows, checkIsStale,
  clearSelection, deselectCategory, formatAge, formatBytes, formatDateTime, formatSize, groupMemberNoun, groupMembers, headerFigures, itemHint,
  isSelected, needsAcknowledgement, selectAllEligible, selectAllSnapshots, selectCategory, selectedCount,
  selectionFor, selectionSummary, toggleItem,
} from './app-storage-model.mjs';
import { ALL_ELIGIBLE_SCOPE, FIGURE_LABELS, KIND_LABELS, SNAPSHOT_ACK, SNAPSHOT_WARNING, SUB_LABELS, TEXT } from './app-storage-text.js';
import { CategoryStatusChip, Figure, ItemStatusChip } from './parts.jsx';

/* --------------------------------- header -------------------------------- */

export function CheckHeader({ target, check, running, onRequestCheck, now = Date.now() }) {
  const f = headerFigures(check);
  const stopped = target?.guestStatus && target.guestStatus !== 'Running';
  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-lg font-semibold break-words">{target?.name}</h2>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{KIND_LABELS[target?.kind] || target?.kind}</span>
              <span className="font-mono">{target?.guest}</span>
              {stopped && <Chip level="warn">{target.guestStatus}</Chip>}
              {check?.finishedAt && <span title={formatDateTime(check.finishedAt)}>{TEXT.checkedAt} {formatAge(check.finishedAt, now)} ({formatDateTime(check.finishedAt)})</span>}
              {check?.status === 'partial' && <Chip level="warn">{TEXT.partialChip}</Chip>}
              {check?.status === 'failed' && <Chip level="fail">{TEXT.failedChip}</Chip>}
            </div>
          </div>
          <Button variant="outline" className={`${BTN} w-full sm:w-auto shrink-0`} disabled={running} onClick={onRequestCheck}>
            {running ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Search className="h-4 w-4 mr-1.5" />}
            {running ? TEXT.checking : TEXT.requestCheck}
          </Button>
        </div>
        {running && <p role="status" className="text-xs text-muted-foreground">{TEXT.checkRunningHint}{check ? ` ${TEXT.newCheckRunning}` : ''}</p>}
        {stopped && <Notice level="warn"><p>{TEXT.containerStopped}</p></Notice>}
        {check && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {f.sharedHost && f.containerUsedBytes != null
                ? <Figure label={TEXT.usedByContainer} value={formatBytes(f.containerUsedBytes)} hint={<span>{FIGURE_LABELS['incus-root-usage']}</span>} />
                : <Figure label={f.sharedHost ? TEXT.usedShared : TEXT.used} value={formatBytes(f.usedBytes)} hint={<><span>{f.sharedHost ? null : TEXT.usedHint}</span>{f.usedPct != null && !f.sharedHost && <CapacityBar pct={f.usedPct} className="mt-1" />}</>} />}
              <Figure label={f.sharedHost ? TEXT.availableShared : TEXT.available} value={formatBytes(f.availableBytes)} />
              <Figure label={TEXT.limit} value={f.limitBytes ? formatBytes(f.limitBytes) : TEXT.noLimit} />
              <Figure label={TEXT.snapshotsHold} value={f.snapshotsBytes != null ? formatBytes(f.snapshotsBytes) : '—'} hint={f.snapshotsBytes ? TEXT.snapshotsHoldHint : null} />
            </div>
            <p className="text-sm flex flex-wrap gap-x-4 gap-y-1">
              <span><span className="text-muted-foreground">{TEXT.onDisk}:</span> {formatBytes(f.onDiskBytes)}</span>
              <span><span className="text-muted-foreground">{TEXT.fileSizes}:</span> {formatBytes(f.fileSizeBytes)}</span>
            </p>
            {f.sharedHost && <div data-testid="shared-host"><Notice level="warn"><p>{TEXT.sharedHostNotice}</p></Notice></div>}
            {f.memoryBacked.map((m) => <Notice key={m.mount} level="info"><p>{TEXT.memoryBacked(m.mount, formatBytes(m.usedBytes))}</p></Notice>)}
            {check.status === 'partial' && <Notice level="warn"><p>{TEXT.checkPartial}</p></Notice>}
            {check.status === 'failed' && <Notice level="error"><p>{check.error?.message || TEXT.checkFailed}</p></Notice>}
            {checkIsStale(check, now) && <Notice level="warn"><p>{TEXT.checkStale}</p></Notice>}
            {check.unmeasured?.length > 0 && (
              <Notice level="warn">
                <p className="font-medium">{TEXT.notMeasuredTitle}</p>
                <ul className="list-disc pl-4 space-y-0.5">{check.unmeasured.map((u, i) => <li key={i} className="break-words"><span className="font-medium">{u.area}:</span> {u.reason}</li>)}</ul>
              </Notice>
            )}
            {check.notes?.length > 0 && (
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p className="font-medium">{TEXT.notesTitle}</p>
                <ul className="list-disc pl-4 space-y-0.5">{check.notes.map((n, i) => <li key={i} className="break-words">{n}</li>)}</ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------------------------- items -------------------------------- */

function GroupMembers({ item }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { shown, total, hidden } = groupMembers(item);
  const noun = groupMemberNoun(item);
  if (!total) return null;
  return (
    <div>
      <button type="button" className="min-h-[44px] inline-flex items-center gap-1 text-xs text-primary hover:underline" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {open ? TEXT.hideMembers(noun) : TEXT.showMembers(shown.length, total, noun)}
      </button>
      {open && (
        <div id={id} className="rounded border bg-muted/40 p-2 space-y-1">
          <ul className="max-h-60 overflow-y-auto space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {shown.map((m) => <li key={m.path} className="break-all">{m.path}</li>)}
          </ul>
          {hidden > 0 && <p className="text-[11px] text-muted-foreground">{TEXT.membersMore(hidden)}</p>}
        </div>
      )}
    </div>
  );
}

export function ItemRow({ item, selected, onToggle, now = Date.now(), selectable = canSelect(item) }) {
  const showPath = item.path && item.path !== item.label;
  return (
    <li className="p-3 flex items-start gap-2 sm:gap-3" data-item={item.id}>
      {selectable ? (
        <label className="-m-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
          <input type="checkbox" className="h-5 w-5 accent-primary cursor-pointer" checked={selected} onChange={() => onToggle(item.id)} aria-label={TEXT.selectItem(item.label)} />
        </label>
      ) : <span className="w-7 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium break-words min-w-0">{item.label}</span>
          <ItemStatusChip status={item.status} />
          {item.memoryBacked && <Chip level="accent">{TEXT.usesMemory}</Chip>}
          {SUB_LABELS[item.sub] && <Chip>{SUB_LABELS[item.sub]}</Chip>}
          {item.location === 'host' && <Chip>{TEXT.host}</Chip>}
        </div>
        {showPath && <p className="font-mono text-xs text-muted-foreground break-all">{item.path}</p>}
        {item.reason && <p className="text-xs break-words">{item.reason}</p>}
        {itemHint(item) && <p className="text-xs text-muted-foreground break-words">{itemHint(item)}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="text-foreground font-medium">{formatSize(item.allocatedBytes, item.precision)} {item.memoryBacked ? TEXT.inMemoryShort : TEXT.onDiskShort}</span>
          {item.logicalBytes != null && item.logicalBytes !== item.allocatedBytes && <span>{TEXT.fileSizesAddUp(formatBytes(item.logicalBytes))}</span>}
          {item.recoverableBytes != null && <span>{TEXT.recoverable(formatBytes(item.recoverableBytes))}</span>}
          {item.files > 0 && <span>{TEXT.files(item.files)}</span>}
          {item.newestMtimeMs && item.kind !== 'pseudo' ? <span title={formatDateTime(item.newestMtimeMs)}>{item.kind === 'snapshot' || item.kind === 'export' ? TEXT.created : TEXT.lastModified} {formatAge(item.newestMtimeMs, now)}</span> : null}
        </div>
        {item.breakdown?.length > 0 && (
          <div className="text-xs text-muted-foreground">
            <p>{TEXT.insideRelease}:</p>
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5">{item.breakdown.map((b) => <li key={b.label}><span className="font-mono">{b.label}</span> {formatBytes(b.allocatedBytes)}</li>)}</ul>
          </div>
        )}
        {item.kind === 'group' && <GroupMembers item={item} />}
      </div>
    </li>
  );
}

function CategorySection({ row, selection, onToggle, onSelectCategory, onClearCategory, now }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="border rounded-lg" aria-label={row.label} data-category={row.key}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-1 p-1">
        <button type="button" className="flex-1 min-w-0 min-h-[44px] text-left flex items-start gap-2 rounded-md p-2 hover:bg-accent/50" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium break-words">{row.label}</span>
              <CategoryStatusChip status={row.status} />
            </span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {(row.allocatedBytes > 0 || !row.memoryBytes) && <span className="text-foreground">{formatSize(row.allocatedBytes, row.precision)} {TEXT.onDiskShort}</span>}
              {row.memoryBytes > 0 && <span className="text-foreground">{formatBytes(row.memoryBytes)} {TEXT.inMemoryShort}</span>}
              {row.sharedHostBytes > 0 && <span>{TEXT.sharedHostShort(formatBytes(row.sharedHostBytes))}</span>}
              <span>{TEXT.items(row.itemCount)}</span>
              {row.count > 0 && <span>{TEXT.files(row.count)}</span>}
              {row.newestMtimeMs ? <span title={formatDateTime(row.newestMtimeMs)}>{TEXT.lastModified} {formatAge(row.newestMtimeMs, now)}</span> : null}
              {row.eligibleCount > 0 && <span className="text-cyan-600 dark:text-cyan-400">{TEXT.canBeCleaned(row.eligibleCount)}</span>}
            </span>
          </span>
        </button>
        {row.eligibleCount > 0 && (
          <CategoryButton row={row} selection={selection} onSelectCategory={onSelectCategory} onClearCategory={onClearCategory} />
        )}
      </div>
      {open && (
        <ul id={id} className="border-t divide-y">
          {row.items.map((item) => <ItemRow key={item.id} item={item} selected={isSelected(selection, item.id)} onToggle={onToggle} now={now} />)}
        </ul>
      )}
    </section>
  );
}

function CategoryButton({ row, selection, onSelectCategory, onClearCategory }) {
  const n = row.items.filter((i) => canSelect(i) && isSelected(selection, i.id)).length;
  const all = n > 0 && n === row.eligibleCount;
  return (
    <Button type="button" variant="outline" size="sm" className={`${BTN} w-full sm:w-auto shrink-0 sm:mr-1`} aria-pressed={all}
      onClick={() => (all ? onClearCategory(row.key) : onSelectCategory(row.key))}>
      {all ? TEXT.deselectCategoryShort : TEXT.selectCategoryShort}
      <span className="sr-only"> {TEXT.inCategory(row.label)}</span>
      {n > 0 && !all && <span className="ml-1 text-xs text-muted-foreground">({n}/{row.eligibleCount})</span>}
    </Button>
  );
}

/* ------------------------------ restore points ---------------------------- */

function RestorePoints({ rows, check, selection, onChange, now }) {
  const snapshots = rows.find((r) => r.key === 'snapshots')?.items || [];
  const exports = rows.find((r) => r.key === 'exports')?.items || [];
  const snapIds = allSnapshotIds(check);
  const ack = needsAcknowledgement(selection);
  const toggle = (id) => onChange(toggleItem(check, selection, id));
  return (
    <section className="space-y-3" aria-labelledby="restore-points-title">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="min-w-0">
          <h3 id="restore-points-title" className="text-base font-semibold">{TEXT.restorePointsTitle}</h3>
          <p className="text-xs text-muted-foreground">{TEXT.restorePointsDescription}</p>
        </div>
        {snapIds.length > 0 && (
          <Button type="button" variant="outline" className={`${BTN} w-full sm:w-auto`} onClick={() => onChange(selectAllSnapshots(check, selection))}>{TEXT.selectAllSnapshots}</Button>
        )}
      </div>
      {!snapshots.length && !exports.length ? <p className="text-sm text-muted-foreground">{TEXT.noSnapshots}</p> : (
        <>
          <Notice level="warn"><p>{SNAPSHOT_WARNING}</p></Notice>
          {[['snapshots', snapshots], ['exports', exports]].filter(([, list]) => list.length).map(([key, list]) => (
            <div key={key} className="border rounded-lg" data-category={key}>
              <h4 className="px-3 pt-3 text-sm font-medium">{rows.find((r) => r.key === key)?.label}</h4>
              <ul className="divide-y">{list.map((item) => <ItemRow key={item.id} item={item} selected={isSelected(selection, item.id)} onToggle={toggle} now={now} />)}</ul>
            </div>
          ))}
          {ack && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3">
              <Checkbox checked={selection.acknowledged} onChange={(v) => onChange(acknowledgeSnapshots(selection, v))} label={SNAPSHOT_ACK} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* --------------------------------- the list ------------------------------- */

export default function StorageCheckDetail({ check, selection: rawSelection, onSelectionChange, onReview, now = Date.now(), running, onRequestCheck }) {
  if (!check) {
    return (
      <EmptyState icon={Search} title={TEXT.noCheckTitle} hint={TEXT.noCheckHint}
        action={<Button className={BTN} disabled={running} onClick={onRequestCheck}>{running ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Search className="h-4 w-4 mr-1.5" />}{running ? TEXT.checking : TEXT.requestCheck}</Button>} />
    );
  }
  const selection = selectionFor(check, rawSelection);
  const rows = categoryRows(check);
  const listed = rows.filter((r) => !r.separate && r.itemCount > 0);
  const empty = rows.filter((r) => !r.separate && r.itemCount === 0);
  const n = selectedCount(selection);
  const eligibleTotal = allEligibleIds(check).length;
  const set = onSelectionChange;
  return (
    <div className="space-y-4">
      <section className="space-y-3" aria-labelledby="what-uses-storage">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <h3 id="what-uses-storage" className="text-base font-semibold">{TEXT.whatUsesStorage}</h3>
            <p className="text-xs text-muted-foreground">{TEXT.whatUsesStorageHint}</p>
          </div>
          <div className="flex flex-col gap-1 sm:items-end sm:max-w-sm">
            <Button type="button" variant="outline" className={`${BTN} w-full sm:w-auto`} disabled={!eligibleTotal} aria-describedby="all-eligible-scope" onClick={() => set(selectAllEligible(check, selection))}>{TEXT.selectAllEligible}</Button>
            <p id="all-eligible-scope" className="text-xs text-muted-foreground sm:text-right">{ALL_ELIGIBLE_SCOPE}</p>
          </div>
        </div>
        <div className="space-y-2">
          {listed.map((row) => (
            <CategorySection key={row.key} row={row} selection={selection} now={now}
              onToggle={(id) => set(toggleItem(check, selection, id))}
              onSelectCategory={(key) => set(selectCategory(check, selection, key))}
              onClearCategory={(key) => set(deselectCategory(check, selection, key))} />
          ))}
        </div>
        {empty.length > 0 && <p className="text-xs text-muted-foreground">{TEXT.emptyCategories(empty.map((r) => r.label))}</p>}
      </section>

      <RestorePoints rows={rows} check={check} selection={selection} onChange={set} now={now} />

      <div role="region" aria-label={TEXT.selectionBarLabel} className="sticky bottom-0 z-10 rounded-lg border bg-card/95 backdrop-blur shadow-lg p-3 flex flex-col sm:flex-row sm:items-center gap-2">
        <p className="text-sm font-medium min-w-0 flex-1 break-words" aria-live="polite" data-testid="selection-summary">{selectionSummary(check, selection)}</p>
        {n > 0 && needsAcknowledgement(selection) && !selection.acknowledged && (
          <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{TEXT.ackPending}</p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" className={`${BTN} flex-1 sm:flex-none`} disabled={n === 0} onClick={() => set(clearSelection(check))}>{TEXT.clear}</Button>
          <Button type="button" className={`${BTN} flex-1 sm:flex-none`} disabled={n === 0} onClick={onReview}>{TEXT.reviewCleanup}</Button>
        </div>
      </div>
    </div>
  );
}
