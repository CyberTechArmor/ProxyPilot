// Application storage → overview: one row per application / Dev Studio
// project (GET /api/app-storage/overview). A table from lg up, cards below
// (MOBILE_FIRST.md: the table needs the width the sidebar leaves at lg).
// "Request storage check" starts a read-only check; the page polls it.

import { Link } from 'react-router-dom';
import { Bell, ChevronRight, Loader2, PieChart, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { BTN, Chip, EmptyState } from '@/components/storage/shared';
import { formatAge, formatBytes, formatDateTime } from './app-storage-model.mjs';
import { KIND_LABELS, POLICY_SOURCE_LABELS, TEXT } from './app-storage-text.js';

const detailHref = (key) => `/storage/applications?target=${encodeURIComponent(key)}`;

function lastCheckText(t, now) {
  const c = t.lastCheck;
  if (!c) return { main: TEXT.neverChecked, sub: null };
  const used = c.totals?.guest?.usedBytes;
  return {
    main: `${formatAge(c.finishedAt, now)}`,
    title: formatDateTime(c.finishedAt),
    sub: [used != null ? TEXT.usedSize(formatBytes(used)) : null, c.eligibleBytes ? TEXT.cleanableSize(formatBytes(c.eligibleBytes)) : null].filter(Boolean).join(' · ') || null,
  };
}

function Alerts({ alerts }) {
  if (!alerts?.length) return <span className="text-xs text-muted-foreground">{TEXT.noAlerts}</span>;
  return (
    <ul className="space-y-1">
      {alerts.map((a) => (
        <li key={a.key} className="flex items-start gap-1.5 text-xs break-words">
          <Bell className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${a.level === 'error' ? 'text-red-500' : 'text-amber-500'}`} aria-hidden="true" />
          <span className="min-w-0">{a.title}</span>
        </li>
      ))}
    </ul>
  );
}

function PolicyChip({ policy, name }) {
  if (!policy?.source) return null;
  const label = TEXT.policyChip[policy.source] || POLICY_SOURCE_LABELS[policy.source]?.(name) || policy.source;
  return <Chip level={policy.source === 'defaults-existing' ? 'warn' : 'muted'} className="whitespace-normal text-left">{label}</Chip>;
}

function CheckButton({ t, running, onRequestCheck, className }) {
  const stopped = t.guestStatus && t.guestStatus !== 'Running';
  return (
    <Button variant="outline" className={`${BTN} ${className || ''}`} disabled={running} onClick={() => onRequestCheck(t)} title={stopped ? TEXT.containerStopped : undefined}>
      {running ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Search className="h-4 w-4 mr-1.5" />}
      {running ? TEXT.checking : TEXT.requestCheck}
      <span className="sr-only">{TEXT.forName(t.name)}</span>
    </Button>
  );
}

function NameCell({ t }) {
  return (
    <div className="min-w-0 space-y-1">
      <Link to={detailHref(t.key)} className="font-medium underline decoration-primary decoration-2 underline-offset-4 hover:text-primary break-words">{t.name}</Link>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>{KIND_LABELS[t.kind] || t.kind}</span>
        <span className="font-mono">{t.guest}</span>
        {t.guestStatus && t.guestStatus !== 'Running' && <Chip level="warn">{t.guestStatus}</Chip>}
      </div>
      <PolicyChip policy={t.policy} name={t.name} />
    </div>
  );
}

export default function StorageOverview({ data, running = {}, onRequestCheck, now = Date.now() }) {
  const targets = data?.targets || [];
  if (!targets.length) return <EmptyState icon={PieChart} title={TEXT.overviewEmptyTitle} hint={TEXT.overviewEmptyHint} />;
  return (
    <>
      <div className="hidden lg:block border rounded-lg">
        <table className="w-full text-sm table-fixed">
          <caption className="sr-only">{TEXT.pageTitle}</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="text-left font-medium p-3 w-[30%]">{TEXT.colApplication}</th>
              <th scope="col" className="text-right font-medium p-3 w-[12%]">{TEXT.colUsedNow}</th>
              <th scope="col" className="text-left font-medium p-3 w-[20%]">{TEXT.colLastCheck}</th>
              <th scope="col" className="text-left font-medium p-3">{TEXT.colAlerts}</th>
              <th scope="col" className="p-3 w-[13.5rem]"><span className="sr-only">{TEXT.colActions}</span></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {targets.map((t) => {
              const lc = lastCheckText(t, now);
              const isRunning = Boolean(running[t.key] || t.runningCheckId);
              return (
                <tr key={t.key} className="align-top" data-target={t.key}>
                  <td className="p-3"><NameCell t={t} /></td>
                  <td className="p-3 text-right text-xs"><span className="font-mono whitespace-nowrap">{t.usage?.usedBytes != null ? formatBytes(t.usage.usedBytes) : TEXT.usageUnknown}</span>{t.usage?.usedBytes != null && <div className="text-muted-foreground">{TEXT.usedNowHint}</div>}</td>
                  <td className="p-3 text-xs">
                    <span title={lc.title}>{lc.main}</span>
                    {lc.sub && <div className="text-muted-foreground break-words">{lc.sub}</div>}
                  </td>
                  <td className="p-3"><Alerts alerts={t.alerts} /></td>
                  <td className="p-3">
                    <div className="flex flex-col gap-2 items-stretch">
                      <CheckButton t={t} running={isRunning} onRequestCheck={onRequestCheck} />
                      <Button asChild variant="ghost" className={BTN}><Link to={detailHref(t.key)}>{TEXT.openDetails}<ChevronRight className="h-4 w-4 ml-1" /><span className="sr-only">{TEXT.ofName(t.name)}</span></Link></Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="lg:hidden space-y-3">
        {targets.map((t) => {
          const lc = lastCheckText(t, now);
          const isRunning = Boolean(running[t.key] || t.runningCheckId);
          return (
            <Card key={t.key} data-target={t.key}>
              <CardContent className="p-4 space-y-3">
                <NameCell t={t} />
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div className="min-w-0"><dt className="text-xs text-muted-foreground">{TEXT.colUsedNow}</dt><dd className="text-xs"><span className="font-mono">{t.usage?.usedBytes != null ? formatBytes(t.usage.usedBytes) : TEXT.usageUnknown}</span>{t.usage?.usedBytes != null && <span className="block text-muted-foreground">{TEXT.usedNowHint}</span>}</dd></div>
                  <div className="min-w-0"><dt className="text-xs text-muted-foreground">{TEXT.colLastCheck}</dt><dd className="text-xs break-words"><span title={lc.title}>{lc.main}</span>{lc.sub && <span className="block text-muted-foreground">{lc.sub}</span>}</dd></div>
                  <div className="min-w-0 sm:col-span-2"><dt className="text-xs text-muted-foreground">{TEXT.colAlerts}</dt><dd><Alerts alerts={t.alerts} /></dd></div>
                </dl>
                <div className="flex flex-col sm:flex-row gap-2">
                  <CheckButton t={t} running={isRunning} onRequestCheck={onRequestCheck} className="w-full sm:w-auto" />
                  <Button asChild variant="ghost" className={`${BTN} w-full sm:w-auto`}><Link to={detailHref(t.key)}>{TEXT.openDetails}<ChevronRight className="h-4 w-4 ml-1" /><span className="sr-only">{TEXT.ofName(t.name)}</span></Link></Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
