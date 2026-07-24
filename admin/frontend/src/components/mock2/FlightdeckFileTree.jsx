import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  ChevronRight, ChevronDown, File as FileIcon, Folder, FolderOpen,
  RefreshCw, FilePlus, FolderPlus, Loader2, Search,
} from 'lucide-react';

// Flightdeck file explorer — the project working tree from the container, with
// expand/collapse, quick-filter, open-on-click, and create/rename/delete. Live
// changes (agent/terminal edits) surface via the `refreshKey` bump + the manual
// refresh; the whole codebase polls rather than pushes, so the tree re-fetches
// on demand and after each write. canEdit gates the mutating actions.

function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    if (n.type === 'dir' && n.children) flatten(n.children, out);
  }
  return out;
}

function TreeNode({ node, depth, expanded, onToggle, onOpen, onContext, activePath, canEdit }) {
  const isDir = node.type === 'dir';
  const isOpen = expanded.has(node.path);
  const pad = { paddingLeft: `${depth * 12 + 6}px` };
  return (
    <div>
      <div
        role="treeitem"
        aria-expanded={isDir ? isOpen : undefined}
        onClick={() => (isDir ? onToggle(node.path) : onOpen(node))}
        onContextMenu={(e) => { if (canEdit) { e.preventDefault(); onContext(e, node); } }}
        style={pad}
        className={`flex items-center gap-1 py-1 pr-2 text-sm cursor-pointer select-none rounded hover:bg-muted/60 ${activePath === node.path ? 'bg-muted' : ''} ${node.muted ? 'opacity-50' : ''}`}
        title={node.path}
      >
        {isDir ? (
          isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        ) : <span className="w-3.5 shrink-0" />}
        {isDir ? (isOpen ? <FolderOpen className="h-4 w-4 shrink-0 text-blue-400" /> : <Folder className="h-4 w-4 shrink-0 text-blue-400" />)
          : <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="truncate">{node.name}</span>
      </div>
      {isDir && isOpen && node.children?.map((c) => (
        <TreeNode key={c.path} node={c} depth={depth + 1} expanded={expanded} onToggle={onToggle} onOpen={onOpen} onContext={onContext} activePath={activePath} canEdit={canEdit} />
      ))}
    </div>
  );
}

export default function FlightdeckFileTree({ projectId, canEdit, activePath, onOpen, refreshKey = 0, onError }) {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set(['.', 'src']));
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState(null); // { x, y, node }

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await api.mock2FlightdeckTree(projectId);
      setTree(r.tree || []);
    } catch (e) {
      setErr(e?.message || 'Could not load files.');
      onError?.(e);
    } finally { setLoading(false); }
  }, [projectId, onError]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const toggle = useCallback((path) => {
    setExpanded((prev) => { const n = new Set(prev); n.has(path) ? n.delete(path) : n.add(path); return n; });
  }, []);

  // Quick-filter: flat list of files whose path matches (fuzzy-ish substring).
  const filtered = useMemo(() => {
    if (!filter.trim() || !tree) return null;
    const q = filter.trim().toLowerCase();
    return flatten(tree).filter((n) => n.type === 'file' && n.path.toLowerCase().includes(q)).slice(0, 100);
  }, [filter, tree]);

  const doCreate = async (kind) => {
    setMenu(null);
    const base = menu?.node?.type === 'dir' ? `${menu.node.path}/` : '';
    const name = window.prompt(`New ${kind === 'dir' ? 'folder' : 'file'} path (relative to project root):`, base);
    if (!name) return;
    try { await api.mock2FlightdeckCreate(projectId, name, kind); await load(); if (kind === 'file') onOpen?.({ path: name, type: 'file' }); }
    catch (e) { onError?.(e); }
  };
  const doRename = async () => {
    const node = menu?.node; setMenu(null); if (!node) return;
    const to = window.prompt('Rename to (relative path):', node.path);
    if (!to || to === node.path) return;
    try { await api.mock2FlightdeckRename(projectId, node.path, to); await load(); }
    catch (e) { onError?.(e); }
  };
  const doDelete = async () => {
    const node = menu?.node; setMenu(null); if (!node) return;
    if (!window.confirm(`Delete ${node.path}? This cannot be undone.`)) return;
    try { await api.mock2FlightdeckDelete(projectId, node.path); await load(); }
    catch (e) { onError?.(e); }
  };

  return (
    <div className="flex flex-col h-full min-h-0" onClick={() => menu && setMenu(null)}>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex-1">Explorer</span>
        {canEdit && <button className="p-1 rounded hover:bg-muted" title="New file" onClick={() => { setMenu({ node: null }); doCreate('file'); }}><FilePlus className="h-3.5 w-3.5" /></button>}
        {canEdit && <button className="p-1 rounded hover:bg-muted" title="New folder" onClick={() => { setMenu({ node: null }); doCreate('dir'); }}><FolderPlus className="h-3.5 w-3.5" /></button>}
        <button className="p-1 rounded hover:bg-muted" title="Refresh" onClick={load}><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>
      <div className="px-2 py-1.5 border-b">
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Quick open…" className="w-full pl-7 pr-2 py-1 text-xs rounded border border-input bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
        </div>
      </div>
      <div className="flex-1 overflow-auto py-1" role="tree">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground p-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
        ) : err ? (
          <div className="text-xs text-red-500 p-3 space-y-2"><p>{err}</p><Button size="sm" variant="outline" onClick={load}>Retry</Button></div>
        ) : filtered ? (
          filtered.length ? filtered.map((n) => (
            <div key={n.path} onClick={() => onOpen?.(n)} className={`flex items-center gap-1.5 py-1 px-2 text-sm cursor-pointer hover:bg-muted/60 ${activePath === n.path ? 'bg-muted' : ''}`} title={n.path}>
              <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{n.path}</span>
            </div>
          )) : <p className="text-xs text-muted-foreground p-3">No matching files.</p>
        ) : (tree && tree.length) ? (
          tree.map((n) => <TreeNode key={n.path} node={n} depth={0} expanded={expanded} onToggle={toggle} onOpen={onOpen} onContext={(e, node) => setMenu({ x: e.clientX, y: e.clientY, node })} activePath={activePath} canEdit={canEdit} />)
        ) : <p className="text-xs text-muted-foreground p-3">Empty project.</p>}
      </div>

      {menu && menu.x != null && (
        <div style={{ left: menu.x, top: menu.y }} className="fixed z-50 min-w-[10rem] rounded-md border bg-popover shadow-md py-1 text-sm" onClick={(e) => e.stopPropagation()}>
          <button className="w-full text-left px-3 py-1.5 hover:bg-muted" onClick={() => doCreate('file')}>New file…</button>
          <button className="w-full text-left px-3 py-1.5 hover:bg-muted" onClick={() => doCreate('dir')}>New folder…</button>
          <button className="w-full text-left px-3 py-1.5 hover:bg-muted" onClick={doRename}>Rename…</button>
          <button className="w-full text-left px-3 py-1.5 hover:bg-muted text-red-500" onClick={doDelete}>Delete…</button>
        </div>
      )}
    </div>
  );
}
