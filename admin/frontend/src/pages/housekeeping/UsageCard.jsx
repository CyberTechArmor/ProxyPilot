// Storage usage card — sits at the top of the Backups tab.
// Surfaces total bytes / count + per-destination breakdown so
// operators can see what's eating each bucket without the click-
// through that the master spec calls out ('Storage usage card at
// the top showing total size + per-service breakdown').
//
// Numbers come from GET /api/backups/usage which is a pure SQL
// aggregation — cheap.  Refreshing on every Backups-tab visit
// is fine.

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Database, HardDrive } from 'lucide-react';

function fmtBytes(n) {
  if (typeof n !== 'number' || Number.isNaN(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export default function UsageCard({ usage, loading }) {
  if (loading && !usage) {
    return null; // empty until the first load resolves; avoids
                 // flash of "0 backups" before the real numbers
  }
  if (!usage) return null;

  const total = usage.total || { bytes: 0, count: 0 };
  const perDest = usage.per_destination || [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <HardDrive className="h-5 w-5 mt-0.5 text-muted-foreground" />
          <div className="space-y-1 flex-1">
            <CardTitle className="text-base">Storage usage</CardTitle>
            <CardDescription className="text-xs">
              Aggregate size of every successful backup row, across destinations and tiers.
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold font-mono">{fmtBytes(total.bytes)}</div>
            <div className="text-xs text-muted-foreground">{total.count} backup{total.count === 1 ? '' : 's'}</div>
          </div>
        </div>
      </CardHeader>
      {perDest.length > 0 && (
        <CardContent>
          <div className="space-y-2">
            {perDest.map((d) => (
              <div key={d.destination_id || 'unknown'} className="border rounded p-2">
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <Database className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium text-sm">{d.destination_name || 'unknown destination'}</span>
                  </div>
                  <div className="text-sm font-mono">{fmtBytes(d.bytes)}</div>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-1.5 text-[11px]">
                  {(d.tiers || []).map((t) => (
                    <div key={t.tier} className="bg-muted/40 rounded px-2 py-1">
                      <div className="font-mono uppercase tracking-wide text-muted-foreground">{t.tier}</div>
                      <div className="font-mono">{fmtBytes(t.bytes)} · {t.count}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
