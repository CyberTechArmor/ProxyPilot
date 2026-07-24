import { useCallback, useEffect, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { api } from '@/lib/api';
import { codemirrorLanguage } from '@/lib/flightdeck';
import { X, Loader2, Save, FileWarning } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

// Flightdeck editor — tabbed CodeMirror over the container file API. Dirty
// indicators, Cmd/Ctrl+S save, language by extension, dark theme. Opens files on
// `openRequest` ({ path, nonce }) from the file tree / chat edit links.
// External-change reconciliation: when a build cycle touches files (bumped via
// `externalNonce`), unmodified open tabs reload; modified tabs show a
// non-destructive banner so the user never loses edits silently.

export default function FlightdeckEditor({ projectId, openRequest, canEdit, externalNonce = 0, onDirtyChange, onActivePathChange }) {
  const { toast } = useToast();
  const [tabs, setTabs] = useState([]); // { path, language, content, saved, dirty, conflict }
  const [activePath, setActivePath] = useState(null);
  const [loading, setLoading] = useState(false);
  const lastOpenNonce = useRef(0);

  const active = tabs.find((t) => t.path === activePath) || null;

  useEffect(() => { onActivePathChange?.(activePath); }, [activePath, onActivePathChange]);
  useEffect(() => { onDirtyChange?.(tabs.some((t) => t.dirty)); }, [tabs, onDirtyChange]);

  const openFile = useCallback(async (path) => {
    if (!path) return;
    const existing = tabs.find((t) => t.path === path);
    if (existing) { setActivePath(path); return; }
    setLoading(true);
    try {
      const r = await api.mock2FlightdeckReadFile(projectId, path);
      setTabs((prev) => [...prev, { path, language: r.language, content: r.content, saved: r.content, dirty: false, conflict: false }]);
      setActivePath(path);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not open file', description: e?.message || String(e) });
    } finally { setLoading(false); }
  }, [projectId, tabs, toast]);

  // React to open requests from the tree / chat.
  useEffect(() => {
    if (openRequest && openRequest.nonce !== lastOpenNonce.current) {
      lastOpenNonce.current = openRequest.nonce;
      openFile(openRequest.path);
    }
  }, [openRequest, openFile]);

  // External-change reconciliation on cycle activity.
  useEffect(() => {
    if (!externalNonce) return;
    let cancelled = false;
    (async () => {
      for (const t of tabs) {
        try {
          const r = await api.mock2FlightdeckReadFile(projectId, t.path);
          if (cancelled) return;
          if (r.content === t.saved) continue; // unchanged on disk
          setTabs((prev) => prev.map((x) => {
            if (x.path !== t.path) return x;
            if (!x.dirty) return { ...x, content: r.content, saved: r.content, conflict: false }; // safe auto-refresh
            return { ...x, saved: r.content, conflict: true }; // modified locally → flag conflict
          }));
        } catch { /* file may have been deleted; leave the tab */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalNonce]);

  const onChange = (val) => {
    setTabs((prev) => prev.map((t) => (t.path === activePath ? { ...t, content: val, dirty: val !== t.saved } : t)));
  };

  const save = useCallback(async () => {
    if (!active || !active.dirty || !canEdit) return;
    try {
      await api.mock2FlightdeckSaveFile(projectId, active.path, active.content);
      setTabs((prev) => prev.map((t) => (t.path === active.path ? { ...t, saved: t.content, dirty: false, conflict: false } : t)));
    } catch (e) {
      toast({ variant: 'destructive', title: 'Save failed', description: e?.message || String(e) });
    }
  }, [active, canEdit, projectId, toast]);

  const closeTab = (path) => {
    const t = tabs.find((x) => x.path === path);
    if (t?.dirty && !window.confirm(`${path} has unsaved changes. Close anyway?`)) return;
    setTabs((prev) => prev.filter((x) => x.path !== path));
    if (activePath === path) { const rest = tabs.filter((x) => x.path !== path); setActivePath(rest.length ? rest[rest.length - 1].path : null); }
  };

  // Cmd/Ctrl+S saves the active tab.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#282c34]">
      {/* tab bar */}
      <div className="flex items-stretch overflow-x-auto border-b border-black/40 bg-[#21252b] shrink-0">
        {tabs.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No file open — pick one from the Explorer.</div>
        ) : tabs.map((t) => (
          <div key={t.path} onClick={() => setActivePath(t.path)} title={t.path}
            className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-black/40 max-w-[16rem] ${activePath === t.path ? 'bg-[#282c34] text-white' : 'text-white/60 hover:text-white/90'}`}>
            <span className="truncate">{t.path.split('/').pop()}</span>
            {t.dirty ? <span className="h-2 w-2 rounded-full bg-white/70 shrink-0" title="Unsaved" /> : null}
            <button onClick={(e) => { e.stopPropagation(); closeTab(t.path); }} className="opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded"><X className="h-3 w-3" /></button>
          </div>
        ))}
      </div>

      {/* breadcrumb + save */}
      {active && (
        <div className="flex items-center justify-between px-3 py-1 text-[11px] text-white/50 bg-[#21252b] border-b border-black/40 shrink-0">
          <span className="truncate">{active.path}</span>
          {canEdit && active.dirty ? (
            <button onClick={save} className="flex items-center gap-1 text-white/80 hover:text-white"><Save className="h-3 w-3" /> Save</button>
          ) : null}
        </div>
      )}

      {active?.conflict && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-amber-500/15 text-amber-300 border-b border-amber-500/30 shrink-0">
          <FileWarning className="h-3.5 w-3.5 shrink-0" />
          This file changed on disk while you were editing. Save to overwrite, or close without saving to take the new version.
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {loading && !active ? (
          <div className="flex items-center gap-2 text-xs text-white/60 p-4"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Opening…</div>
        ) : active ? (
          <CodeMirror
            value={active.content}
            height="100%"
            theme={oneDark}
            editable={canEdit}
            extensions={[codemirrorLanguage(active.language)].filter(Boolean)}
            onChange={onChange}
            style={{ height: '100%', fontSize: '13px' }}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-white/30 text-sm">Flightdeck editor</div>
        )}
      </div>
    </div>
  );
}
