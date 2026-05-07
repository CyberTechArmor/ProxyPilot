import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { api } from '@/lib/api';

// Global snapshot-export queue state.  One provider mounted in
// Layout.jsx so the polling continues regardless of which page
// the operator is on — switching tabs mid-export must not break
// the banner or the disabled-action gating.
//
// Polling cadence:
//   * 2.5s while ANY job is running OR queued.
//   * 30s when the queue is empty (cheap heartbeat that catches
//     a job started by a different operator / browser tab).
const SnapshotExportContext = createContext({
  status: { running: [], queued: [], queue_depth: 0, max_concurrency: 1 },
  isBusy: false,
  refresh: () => {},
});

export function SnapshotExportProvider({ children }) {
  const [status, setStatus] = useState({
    running: [],
    queued: [],
    queue_depth: 0,
    max_concurrency: 1,
  });
  const lastBusy = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.getSnapshotExportQueue();
      setStatus({
        running: Array.isArray(r.running) ? r.running : [],
        queued: Array.isArray(r.queued) ? r.queued : [],
        queue_depth: r.queue_depth || 0,
        max_concurrency: r.max_concurrency || 1,
      });
    } catch {
      // Auth-not-yet-loaded / transient — next poll catches up.
    }
  }, []);

  useEffect(() => {
    refresh();
    let intervalMs = 30_000;
    let id;
    const schedule = () => {
      if (id) clearInterval(id);
      id = setInterval(async () => {
        await refresh();
        const busy = (lastBusy.current);
        const desired = busy ? 2_500 : 30_000;
        if (desired !== intervalMs) {
          intervalMs = desired;
          schedule();
        }
      }, intervalMs);
    };
    schedule();
    return () => { if (id) clearInterval(id); };
  }, [refresh]);

  const isBusy = status.running.length > 0 || status.queue_depth > 0;
  lastBusy.current = isBusy;

  return (
    <SnapshotExportContext.Provider value={{ status, isBusy, refresh }}>
      {children}
    </SnapshotExportContext.Provider>
  );
}

export function useSnapshotExports() {
  return useContext(SnapshotExportContext);
}
