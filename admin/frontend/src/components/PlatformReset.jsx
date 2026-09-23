import { useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

// Platform Setup → Reset Full Platform. The same review and queue the MCP
// tool reset_platform_setup uses: an inert preview listing everything that
// will be removed, then the reset itself behind fresh local authentication.
export default function PlatformReset() {
  const [purgeData, setPurgeData] = useState(false);
  const [review, setReview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [queued, setQueued] = useState(null);
  const run = async (name, fn) => { setBusy(name); setError(''); try { await fn(); } catch (e) { setError(e.message || 'Reset could not continue.'); } finally { setBusy(''); } };
  const preview = (purge) => run('review', async () => { setConfirmed(false); setQueued(null); setReview(await api.fullPlatformResetReview({ purgeData: purge })); });
  const list = (title, items, render) => items?.length ? <div className="space-y-1"><p className="font-medium">{title}</p><ul className="list-disc pl-5 space-y-1">{items.map((x, i) => <li key={i} className="break-all">{render(x)}</li>)}</ul></div> : null;
  return <div className="space-y-4 text-sm">
    <p>Start Platform Setup over. Owned containers and their Caddy routes are removed and the saved plan, platform operations and owned service records are discarded, so stage A starts clean. External services are never touched. Reset is refused while SSO is active, while Pomerium application policies are active, or while an operation is running.</p>
    <label className="flex gap-2 items-start min-h-11"><input type="checkbox" className="mt-1" checked={purgeData} disabled={!!busy} onChange={e => { setPurgeData(e.target.checked); setReview(null); setConfirmed(false); }} /><span>Also delete owned data (directories, volumes, networks and protected credentials). A backup set is written to the exports directory and verified first.</span></label>
    <Button variant="outline" className="min-h-11 w-full sm:w-auto" disabled={!!busy} onClick={() => preview(purgeData)}>{busy === 'review' ? 'Reviewing…' : 'Review reset'}</Button>
    {error && <p role="alert" className="text-destructive break-words">{error}</p>}
    {review && <section aria-label="Reset preview" className="rounded-lg border p-4 space-y-3 min-w-0">
      <h3 className="font-semibold">{review.purgeData ? 'Reset and delete owned data' : 'Reset (data kept)'}</h3>
      {review.blockers.map(b => <p role="alert" key={b} className="break-words">{b}</p>)}
      <ul className="list-disc pl-5 space-y-1">{review.effects.map(e => <li key={e} className="break-words">{e}</li>)}</ul>
      {list('Containers removed', review.remove.containers, c => `${c.name} (${c.service})`)}
      {list('Routes removed', review.remove.routes, r => r.hostname)}
      {list('Records discarded', review.remove.records, r => `${r.table}: ${r.rows} — ${r.what}`)}
      {list('Directories deleted', review.remove.directories, d => d.path)}
      {list('Volumes deleted', review.remove.volumes, v => v.name)}
      {list('Networks deleted', review.remove.networks, n => n.name)}
      {list('External services left untouched', review.external, e => `${e.service} ${e.url || ''}`)}
      {review.backup && <p className="break-words">Backup set: {review.backup.directory}. {review.backup.verified}</p>}
      {!review.purgeData && list('Data directories', review.retain?.directories, d => d.moved_to ? `${d.path} → moved aside to ${d.moved_to}` : `${d.path} (kept in place)`)}
      {review.retain?.note && <p className="break-words text-muted-foreground">{review.retain.note}</p>}
      {!review.blockers.length && <label className="flex gap-2 items-start min-h-11"><input type="checkbox" className="mt-1" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /><span>I reviewed everything listed above{review.purgeData ? ', including the data that will be deleted after the backup set is verified' : ''}.</span></label>}
      <div className="flex flex-col sm:flex-row gap-2">
        <Button variant="destructive" className="min-h-11" disabled={!!busy || !confirmed || review.blockers.length > 0} onClick={() => run('reset', async () => { const r = await api.fullPlatformReset({ revision: review.revision, reviewToken: review.reviewToken, purgeData: review.purgeData, reviewed: true }); setQueued(r.job); setReview(null); setConfirmed(false); })}>{busy === 'reset' ? 'Queuing reset…' : 'Reset Full Platform'}</Button>
        <Button variant="outline" className="min-h-11" disabled={!!busy} onClick={() => { setReview(null); setConfirmed(false); }}>Cancel</Button>
      </div>
    </section>}
    {queued && <p role="status" className="break-words">Reset queued as operation {queued.id}. Follow it under Operation history; when it finishes, Platform Setup starts at step 1.</p>}
  </div>;
}
