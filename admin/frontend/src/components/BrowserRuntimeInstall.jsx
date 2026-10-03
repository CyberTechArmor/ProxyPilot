import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

export default function BrowserRuntimeInstall() {
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const live = starting || ['queued', 'running'].includes(run?.status);
  useEffect(() => {
    let ended = false;
    const refresh = async () => {
      try {
        const value = await api.getUpdateProgress(run?.id, { tail: 4096 });
        if (ended) return;
        setDisconnected(false);
        if (run?.id && (value.id_match === false || value.id !== run.id)) return;
        if (value.action?.startsWith('browser-runtime-')) setRun(value);
      } catch { if (!ended && live) setDisconnected(true); }
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { ended = true; clearInterval(timer); };
  }, [run?.id, live]);
  const start = async operation => {
    setStarting(true); setError('');
    try {
      const value = await api.manageBrowserRuntime(operation);
      setRun({ ...value, action: `browser-runtime-${operation}`, status: 'queued', phase: 'Queued' });
    } catch (e) { setError(e.message || 'Could not request the operation'); }
    finally { setStarting(false); }
  };
  return <section className="min-w-0 space-y-3 rounded-lg border p-4" aria-label="Browser runtime installation">
    <div><h3 className="font-medium">Browser runtime</h3>
      <p className="text-sm text-muted-foreground">Install or update the general-site browser package. The dashboard briefly disconnects while the host finishes the operation. Browser capabilities are verified separately.</p></div>
    <div className="flex flex-wrap gap-2">
      <Button className="min-h-[44px]" disabled={live} onClick={() => start('install')}>Install browser runtime</Button>
      <Button className="min-h-[44px]" variant="outline" disabled={live} onClick={() => start('recover')}>Recover runtime</Button>
      <Button className="min-h-[44px]" variant="outline" disabled={live} onClick={() => start('rollback')}>Roll back runtime</Button>
    </div>
    <p role="status" className="break-words text-sm">{disconnected ? 'Dashboard restarting; waiting for the host result…' : run ? `${run.status}: ${run.phase || ''}` : 'No runtime operation loaded.'}</p>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    {run?.reason && <p className="break-words text-sm text-destructive">{run.reason}</p>}
    {run?.log_tail && <details><summary className="cursor-pointer text-sm">Operation details</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{run.log_tail}</pre></details>}
  </section>;
}
