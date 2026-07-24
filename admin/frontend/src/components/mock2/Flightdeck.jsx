import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import BuildChat from './BuildChat';
import ProjectTerminal from './ProjectTerminal';
import { PreviewPanel } from './ProjectPreview';
import FlightdeckFileTree from './FlightdeckFileTree';
import FlightdeckEditor from './FlightdeckEditor';
import { WORKSPACE_NAME, flightdeckLayoutKey, readJsonPref, writeJsonPref } from '@/lib/flightdeck';
import { Button } from '@/components/ui/button';
import {
  Files, TerminalSquare, MessagesSquare, Code2, Eye, LayoutPanelLeft,
  PanelLeftClose, PanelRightClose, StopCircle, PanelBottom, Maximize2, Minimize2, Info,
} from 'lucide-react';

// Flightdeck — the build-phase IDE workspace. It does NOT rebuild the agent: the
// right-hand chat is the existing harness front-end (BuildChat → startCycle/Ask),
// the terminal is the existing container PTY, and the editor/file-tree operate on
// the SAME project sandbox the agent edits — so agent edits appear live here.
// One shared workspace, assembled from existing instruments.

const DEFAULT_LAYOUT = { left: 240, right: 380, bottom: 240, showLeft: true, showRight: true, showBottom: true };
const MOBILE_PANELS = [
  { key: 'files', label: 'Files', icon: Files },
  { key: 'editor', label: 'Editor', icon: Code2 },
  { key: 'chat', label: 'Chat', icon: MessagesSquare },
  { key: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { key: 'preview', label: 'Preview', icon: Eye },
];

export default function Flightdeck({
  projectId, project, canEdit, isAdmin, previewSrc, provLog, provMessage, onChanged, onBuilt, onSwitchView, onShowDetails,
}) {
  const online = project?.lifecycle === 'active';
  const containerName = project?.container_name || null;

  // Cycle poll (mirrors BuildMode) — drives the top-bar status/cost + the
  // editor's external-change reconciliation nonce, and feeds BuildChat.
  const [cycle, setCycle] = useState(null);
  const [job, setJob] = useState(null);
  const [buildQueue, setBuildQueue] = useState([]);
  const [activity, setActivity] = useState([]);
  const active = !!cycle && ['queued', 'running', 'awaiting_admin', 'paused'].includes(cycle.status);

  const load = useCallback(async () => {
    if (!online) return;
    try {
      const r = await api.mock2GetLatestCycle(projectId);
      setCycle(r.cycle || null); setJob(r.job || null); setBuildQueue(r.build_queue || []);
      setActivity(Array.isArray(r.activity) ? r.activity : []);
    } catch { /* transient */ }
  }, [projectId, online]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!online) return undefined;
    const t = setInterval(load, active ? 3000 : 8000);
    return () => clearInterval(t);
  }, [online, active, load]);

  // Editor reconciliation: bump a nonce as the agent spends tokens (i.e. edits).
  const externalNonce = (cycle?.used_tokens || 0) + (active ? 1 : 0);

  // File open coordination between tree/chat and the editor.
  const [openRequest, setOpenRequest] = useState(null);
  const [activeFilePath, setActiveFilePath] = useState(null);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const openFile = useCallback((node) => {
    if (node?.type === 'dir') return;
    setOpenRequest({ path: node.path, nonce: Date.now() });
  }, []);
  // Refresh the tree when the agent is working (files may appear/disappear).
  useEffect(() => { if (active) setTreeRefresh((n) => n + 1); }, [active]);

  // Center pane: editor vs preview. terminalMax expands the terminal to fill the
  // whole center column (full height) — an option alongside the docked bottom panel.
  const [centerTab, setCenterTab] = useState('editor');
  const [terminalMax, setTerminalMax] = useState(false);
  // Expand the preview to full height (over the terminal's space too).
  const [previewFull, setPreviewFull] = useState(false);
  // Dev mode: OFF (default) is the clean, non-technical view — just the live
  // preview + chat. ON brings in the developer surfaces (file tree, editor,
  // terminal). Persisted globally so the choice sticks across projects.
  const [devMode, setDevMode] = useState(() => readJsonPref('mock2.flightdeck.devMode', false));
  useEffect(() => { writeJsonPref('mock2.flightdeck.devMode', devMode); }, [devMode]);
  // Mobile single-panel switch.
  const [mobilePanel, setMobilePanel] = useState('preview');

  // Persisted layout.
  const [layout, setLayout] = useState(() => ({ ...DEFAULT_LAYOUT, ...readJsonPref(flightdeckLayoutKey(projectId), {}) }));
  useEffect(() => { writeJsonPref(flightdeckLayoutKey(projectId), layout); }, [layout, projectId]);
  const setL = (patch) => setLayout((l) => ({ ...l, ...patch }));

  // Drag resizers.
  const drag = useRef(null);
  const onDragStart = (which) => (e) => { drag.current = { which, x: e.clientX, y: e.clientY, start: { ...layout } }; e.preventDefault(); };
  useEffect(() => {
    const move = (e) => {
      const d = drag.current; if (!d) return;
      if (d.which === 'left') setL({ left: Math.max(160, Math.min(480, d.start.left + (e.clientX - d.x))) });
      if (d.which === 'right') setL({ right: Math.max(280, Math.min(560, d.start.right - (e.clientX - d.x))) });
      if (d.which === 'bottom') setL({ bottom: Math.max(120, Math.min(560, d.start.bottom - (e.clientY - d.y))) });
    };
    const up = () => { drag.current = null; };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = async () => { try { await api.mock2InterruptCycle(projectId, cycle.id); load(); } catch { /* ignore */ } };

  const costText = cycle ? `$${((cycle.used_cost_cents || 0) / 100).toFixed(2)} · ${cycle.used_tokens || 0} tok` : '$0.00';
  const routing = (() => { try { return cycle?.routing_json ? JSON.parse(cycle.routing_json) : null; } catch { return null; } })();

  const editorPane = (
    <FlightdeckEditor projectId={projectId} openRequest={openRequest} canEdit={canEdit} externalNonce={externalNonce}
      onActivePathChange={setActiveFilePath} />
  );
  // Annotate the live preview: drop pins on the embedded app and send them as a
  // Quick update. Goes straight through the cycle API (skipping split/suggest,
  // like the screenshot annotate path); the poll above then surfaces the new
  // cycle in the chat. Gated to editors on an online project.
  const annotatePreview = useCallback(async ({ text, image }) => {
    if (!canEdit || !online) return;
    const images = image ? [image] : [];
    await api.mock2StartCycle(projectId, text, images, 'quick', { skipSplit: true, skipSuggest: true });
    load();
  }, [projectId, canEdit, online, load]);

  // The preview embeds the running app directly. Caddy relaxes the app's
  // frame-ancestors to allow ONLY the dashboard origin (see mock2/caddy.js), so
  // the iframe renders instead of "refused to connect" — no stand-in bar needed.
  // "Open App", the full-height toggle, and Annotate live in the PreviewPanel toolbar.
  const previewPane = previewSrc
    ? <PreviewPanel src={previewSrc} title={project?.name} approved reloadKey={externalNonce}
        fullHeight={previewFull} onToggleFullHeight={devMode ? (() => setPreviewFull((v) => !v)) : null}
        onAnnotate={canEdit && online ? annotatePreview : null} />
    : <div className="flex items-center justify-center h-full text-sm text-muted-foreground">No preview — the app isn’t serving yet.</div>;
  const chatPane = (
    <BuildChat projectId={projectId} project={project} cycle={cycle} canEdit={canEdit} online={online} active={active}
      job={job} buildQueue={buildQueue} activity={activity} onStarted={load} />
  );
  const terminalPane = online
    ? <ProjectTerminal projectId={projectId} containerName={containerName} defaultOpen fill />
    : <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Start the project to open a terminal.</div>;
  const filesPane = <FlightdeckFileTree projectId={projectId} canEdit={canEdit} activePath={activeFilePath} onOpen={openFile} refreshKey={treeRefresh} />;

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] min-h-[32rem] border rounded-lg overflow-hidden bg-background">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 h-11 border-b bg-muted/40 shrink-0 text-sm">
        <LayoutPanelLeft className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold">{WORKSPACE_NAME}</span>
        <span className="text-muted-foreground truncate hidden sm:inline">· {project?.name} · Build</span>
        <div className="flex-1" />
        {routing?.model ? <span className="text-xs text-muted-foreground hidden md:inline">{routing.model}{routing.effort ? ` · ${routing.effort}` : ''}</span> : null}
        <span className="text-xs font-mono px-2 py-0.5 rounded bg-background border" title="Spend this cycle">{costText}</span>
        {active ? <Button size="sm" variant="destructive" className="h-8" onClick={stop}><StopCircle className="h-3.5 w-3.5 mr-1" /> Stop</Button> : null}
        {/* Dev toggle: green (off) = clean preview+chat view; blue (on) = full IDE
            (file tree + editor + terminal). */}
        <button
          type="button" role="switch" aria-checked={devMode} aria-label="Developer view"
          onClick={() => setDevMode((v) => !v)}
          title={devMode ? 'Developer view on — file tree, editor and terminal (click for the clean view)' : 'Clean view — just the preview and chat (click for the developer view)'}
          className={`relative inline-flex h-7 w-[3.25rem] shrink-0 items-center rounded-full transition-colors ${devMode ? 'bg-blue-600' : 'bg-emerald-600'}`}
        >
          <span className={`absolute text-[9px] font-bold uppercase tracking-wide text-white ${devMode ? 'left-1.5' : 'right-1.5'}`}>Dev</span>
          <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${devMode ? 'translate-x-[1.875rem]' : 'translate-x-1'}`} />
        </button>
        <Button size="sm" variant="outline" className="h-8" onClick={onSwitchView} title="Switch to the classic build view">Classic view</Button>
        {onShowDetails ? (
          <Button size="sm" variant="outline" className="h-8" onClick={onShowDetails} title="Show project details in the center pane"><Info className="h-3.5 w-3.5 mr-1" />Details</Button>
        ) : null}
      </div>

      {/* Desktop layout (lg+) */}
      <div className="hidden lg:flex flex-1 min-h-0">
        {devMode ? (
        <div className="flex flex-1 min-h-0">
          {/* left */}
          {layout.showLeft && (
            <>
              <div style={{ width: layout.left }} className="shrink-0 border-r min-h-0">{filesPane}</div>
              <div onMouseDown={onDragStart('left')} className="w-1 cursor-col-resize hover:bg-primary/40 shrink-0" />
            </>
          )}
          {/* center + bottom terminal */}
          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            {terminalMax ? (
              // Full-height terminal: the terminal fills the whole center column.
              <>
                <div className="flex items-center gap-1 px-2 h-8 border-b bg-muted/20 shrink-0 text-xs">
                  <TerminalSquare className="h-3.5 w-3.5 mr-1" /> Terminal
                  <div className="flex-1" />
                  <button onClick={() => setTerminalMax(false)} title="Restore editor" className="p-1 rounded hover:bg-muted"><Minimize2 className="h-3.5 w-3.5" /></button>
                </div>
                <div className="flex-1 min-h-0 bg-black">{terminalPane}</div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1 px-2 h-8 border-b bg-muted/20 shrink-0">
                  <button onClick={() => setCenterTab('editor')} className={`px-2 py-0.5 text-xs rounded ${centerTab === 'editor' ? 'bg-background border' : 'text-muted-foreground'}`}><Code2 className="h-3.5 w-3.5 inline mr-1" />Editor</button>
                  <button onClick={() => setCenterTab('preview')} className={`px-2 py-0.5 text-xs rounded ${centerTab === 'preview' ? 'bg-background border' : 'text-muted-foreground'}`}><Eye className="h-3.5 w-3.5 inline mr-1" />Preview</button>
                  <div className="flex-1" />
                  <button onClick={() => setL({ showLeft: !layout.showLeft })} title="Toggle Explorer" className="p-1 rounded hover:bg-muted"><PanelLeftClose className="h-3.5 w-3.5" /></button>
                  <button onClick={() => setL({ showBottom: !layout.showBottom })} title="Toggle Terminal" className="p-1 rounded hover:bg-muted"><PanelBottom className="h-3.5 w-3.5" /></button>
                  <button onClick={() => setL({ showRight: !layout.showRight })} title="Toggle Chat" className="p-1 rounded hover:bg-muted"><PanelRightClose className="h-3.5 w-3.5" /></button>
                </div>
                <div className="flex-1 min-h-0">{centerTab === 'editor' ? editorPane : previewPane}</div>
                {layout.showBottom && !(centerTab === 'preview' && previewFull) && (
                  <>
                    <div onMouseDown={onDragStart('bottom')} className="h-1 cursor-row-resize hover:bg-primary/40 shrink-0" />
                    <div style={{ height: layout.bottom }} className="shrink-0 border-t min-h-0 bg-black flex flex-col">
                      <div className="flex items-center px-2 h-6 shrink-0 text-[11px] text-white/60 border-b border-white/10">
                        <TerminalSquare className="h-3 w-3 mr-1" /> Terminal
                        <div className="flex-1" />
                        <button onClick={() => setTerminalMax(true)} title="Full-height terminal" className="p-0.5 rounded hover:bg-white/10 text-white/70"><Maximize2 className="h-3 w-3" /></button>
                      </div>
                      <div className="flex-1 min-h-0">{terminalPane}</div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
          {/* right chat */}
          {layout.showRight && (
            <>
              <div onMouseDown={onDragStart('right')} className="w-1 cursor-col-resize hover:bg-primary/40 shrink-0" />
              {/* flex column + overflow-hidden so BuildChat's own message list
                  scrolls internally (the conversation scrolls, not the panel). */}
              <div style={{ width: layout.right }} className="shrink-0 border-l min-h-0 flex flex-col overflow-hidden">{chatPane}</div>
            </>
          )}
        </div>
        ) : (
        // Clean view — just the live preview + chat. No file tree, editor or
        // terminal; the preview fills the space (its own toolbar keeps Annotate
        // and Open App).
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-w-0 min-h-0 p-2">{previewPane}</div>
          <div onMouseDown={onDragStart('right')} className="w-1 cursor-col-resize hover:bg-primary/40 shrink-0" />
          <div style={{ width: layout.right }} className="shrink-0 border-l min-h-0 flex flex-col overflow-hidden">{chatPane}</div>
        </div>
        )}
      </div>

      {/* Mobile / narrow: one panel at a time. Clean view shows only preview +
          chat; dev view exposes files/editor/terminal too. */}
      {(() => {
        const panels = devMode ? MOBILE_PANELS : MOBILE_PANELS.filter((p) => p.key === 'preview' || p.key === 'chat');
        const cur = panels.some((p) => p.key === mobilePanel) ? mobilePanel : 'preview';
        return (
          <div className="flex flex-col flex-1 min-h-0 lg:hidden">
            <div className="flex-1 min-h-0 overflow-auto">
              {cur === 'files' && filesPane}
              {cur === 'editor' && editorPane}
              {cur === 'chat' && chatPane}
              {cur === 'terminal' && <div className="h-full bg-black">{terminalPane}</div>}
              {cur === 'preview' && previewPane}
            </div>
            <div className={`grid border-t shrink-0 ${devMode ? 'grid-cols-5' : 'grid-cols-2'}`}>
              {panels.map((p) => (
                <button key={p.key} onClick={() => setMobilePanel(p.key)}
                  className={`flex flex-col items-center gap-0.5 py-2 min-h-[44px] text-[11px] ${cur === p.key ? 'text-primary' : 'text-muted-foreground'}`}>
                  <p.icon className="h-4 w-4" />{p.label}
                </button>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
