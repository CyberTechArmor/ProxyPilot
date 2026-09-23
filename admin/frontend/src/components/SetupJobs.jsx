import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const statusLabel = (value) => String(value || 'not_checked').replaceAll('_', ' ');
const timestamp = (value) => value ? new Date(value).toLocaleString() : 'Never';

// Platform Setup → Operation history: every setup job with its redacted events.
export default function SetupJobs() {
  const [overview, setOverview] = useState(null);
  const [detail, setDetail] = useState(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const [next, job] = await Promise.all([api.getSetupOverview(), selected ? api.getSetupJob(selected) : Promise.resolve(null)]);
      if (requestId.current !== id) return;
      setOverview(next); setDetail(job); setError('');
    } catch (err) { if (requestId.current === id) setError(err.message); }
  }, [selected]);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 10000); return () => { clearInterval(timer); requestId.current++; }; }, [refresh]);
  return <Card>
    <CardHeader className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div className="space-y-1.5"><CardTitle>Existing setup jobs</CardTitle><CardDescription>Execution and verification are separate. This saved plan does not create a job.</CardDescription></div>
      <Button variant="outline" className="min-h-11 shrink-0" onClick={refresh}><RefreshCw className="h-4 w-4 mr-2" aria-hidden="true" />Refresh jobs</Button>
    </CardHeader>
    <CardContent className="space-y-4">
      {error && <p role="alert" className="text-destructive break-words">Job status could not be refreshed: {error}. Previously loaded records may be out of date.</p>}
      {!overview && !error && <p role="status">Loading jobs…</p>}
      {overview?.locks?.length > 0 && <div className="rounded-lg border p-3 text-sm space-y-2">{overview.locks.map((lock) => <p key={lock.app} className="break-all">{lock.app}: {lock.stale ? 'Stale lease — recovery needs attention' : 'Operation holds a live lease'} ({lock.operation})</p>)}</div>}
      {overview?.jobs?.length === 0 && <p className="text-sm text-muted-foreground">No recorded setup jobs. Service installation state remains unverified.</p>}
      <ul className="space-y-2">{overview?.jobs?.map((job) => <li key={job.id} className="rounded-lg border p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0 break-words"><p className="font-medium">{job.app} · {statusLabel(job.kind)}</p><p className="text-sm">Status: {statusLabel(job.status)} · Outcome: {job.outcome ? statusLabel(job.outcome) : 'Not recorded'}</p><p className="text-sm text-muted-foreground">Verification: {job.verification?.state ? statusLabel(job.verification.state) : 'Not checked'}{job.verification?.pending?.length ? ` · Pending: ${job.verification.pending.map(statusLabel).join(', ')}` : ''}</p></div>
        <Button variant="outline" className="min-h-11 shrink-0" aria-expanded={selected === job.id} onClick={() => { setDetail(null); setSelected(selected === job.id ? '' : job.id); }}> {selected === job.id ? 'Hide events' : 'View events'}<span className="sr-only"> for {job.app}</span></Button>
      </li>)}</ul>
      {detail && <section aria-label="Selected job events" className="rounded-lg border p-4 space-y-3 min-w-0">
        <h3 className="font-semibold break-words">{detail.job.app}: {statusLabel(detail.job.status)}</h3>
        <p className="text-sm break-words">{detail.job.reason || 'No reason recorded.'}</p>
        <p className="text-xs text-muted-foreground break-all">Job {detail.job.id} · {timestamp(detail.job.updated_at)}</p>
        {detail.events.length === 0 ? <p className="text-sm">No recorded events.</p> : <ol className="space-y-3">{detail.events.map((event) => <li key={event.id} className="border-t pt-3 text-sm min-w-0"><p>{timestamp(event.at || event.created_at)} · {statusLabel(event.kind)}</p><p className="break-words">{event.message}</p><pre className="mt-1 whitespace-pre-wrap break-all font-sans text-muted-foreground">{JSON.stringify(event.data, null, 2)}</pre></li>)}</ol>}
      </section>}
    </CardContent>
  </Card>;
}
