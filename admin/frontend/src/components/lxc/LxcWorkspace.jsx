import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useMediaQuery } from '@/hooks/use-media-query';
import InteractiveTerminal from '@/components/InteractiveTerminal';
import ZipUploadDialog from '@/components/ZipUploadDialog';
import FlightdeckFileTree from '@/components/mock2/FlightdeckFileTree';
import FlightdeckEditor from '@/components/mock2/FlightdeckEditor';
import MobilePanelBar from '@/components/mock2/MobilePanelBar';
import { PreviewPanel } from '@/components/mock2/ProjectPreview';
import {
  lxcWorkspaceFs, lxcWorkspaceLayoutKey, lxcWorkspaceRootKey, readJsonPref, writeJsonPref, readPref, writePref,
} from '@/lib/flightdeck';
import {
  Files, TerminalSquare, Code2, Eye, PanelLeftClose, PanelBottom, Maximize2, Minimize2,
  Upload, FileArchive, FolderInput, Loader2, Globe,
} from 'lucide-react';

// LxcWorkspace — the Flightdeck workspace (explorer + editor + preview +
// terminal, everything but the build chat) on one operator container. It is an
// assembly of the SAME instruments Flightdeck uses: FlightdeckFileTree and
// FlightdeckEditor over an `lxcWorkspaceFs` adapter (lib/flightdeck.js →
// /api/lxc/containers/:name/workspace), PreviewPanel over the container's
// published HTTP route, and the existing LXC PTY (/api/terminal/lxc/:name).
// It replaced the dialog's separate Terminal and Files tabs.
//
// The one thing an operator's LXC has that a project sandbox does not: no
// fixed app directory. The workspace is rooted at an operator-chosen absolute
// directory (remembered per container); the backend picks a sensible default
// (startup working dir → /opt/app → /srv/app → /var/www → /root) when none is
// remembered.
//
// The terminal is mounted ONCE, at a fixed spot in the tree, and shown/hidden
// with CSS (docked, full-height, collapsed, or the narrow-screen panel) so a
// layout change never tears the PTY down. The dialog keeps this component
// mounted across its tabs for the same reason.
//
// MOBILE_FIRST: below lg one panel shows at a time, switched from a ≥44px
// bottom bar (Files / Editor / Preview / Terminal); every toolbar button is a
// real tap target; nothing here has a fixed desktop width.

const DEFAULT_LAYOUT = { left: 240, bottom: 240, showLeft: true, showBottom: true };
const NARROW_PANELS = [
  { key: 'files', label: 'Files', icon: Files },
  { key: 'editor', label: 'Editor', icon: Code2 },
  { key: 'preview', label: 'Preview', icon: Eye },
  { key: 'terminal', label: 'Terminal', icon: TerminalSquare },
];

// The LXC PTY. `?type=vm` tells the backend to probe the guest agent and fall
// back to `incus console` for an agentless VM. A cwd change reconnects the
// shell there (InteractiveTerminal re-dials when its URL changes).
export function LxcTerminalPanel({ containerName, initialCwd, instanceType }) {
  const wsPath = instanceType === 'virtual-machine'
    ? `/api/terminal/lxc/${containerName}?type=vm`
    : `/api/terminal/lxc/${containerName}`;
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      {instanceType === 'virtual-machine' && (
        <div className="px-3 py-2 text-xs bg-purple-500/10 border-b border-purple-500/30 text-purple-300">
          VM console — agent shortcuts disabled. Resize is supported but limited.
        </div>
      )}
      <InteractiveTerminal wsPath={wsPath} initialCwd={initialCwd} />
    </div>
  );
}

// The URL the preview embeds for one published route.
function serviceUrl(svc) {
  if (!svc?.domain) return null;
  const prefix = svc.pathPrefix && svc.pathPrefix !== '/' ? svc.pathPrefix : '/';
  return `https://${svc.domain}${prefix}`;
}

export default function LxcWorkspace({
  containerName, instanceType, running = true, services = [], canEdit = true, initialCwd = '',
}) {
  const { toast } = useToast();
  // lg+ gets the three-pane IDE; below that, one panel at a time. A media
  // query (not a Tailwind `hidden`) because it decides WHICH layout mounts —
  // both mounted would mean two CodeMirrors and, worse, two PTYs.
  const wide = useMediaQuery('(min-width: 1024px)');

  // ---- root ----
  const [root, setRoot] = useState(() => readPref(lxcWorkspaceRootKey(containerName), null));
  const fs = useMemo(() => lxcWorkspaceFs(containerName, root), [containerName, root]);
  const onTreeLoaded = useCallback((r) => {
    // No remembered root: the backend picked one — adopt it (the adapter
    // re-keys, which re-fetches once; the tabs are empty at that point).
    if (r?.root && r.root !== root) setRoot(r.root);
  }, [root]);
  useEffect(() => { if (root) writePref(lxcWorkspaceRootKey(containerName), root); }, [root, containerName]);
  const changeRoot = () => {
    const next = window.prompt('Directory to open (absolute path inside the container):', root || '/opt/app');
    if (!next) return;
    const clean = next.trim().replace(/\/+$/, '') || '/';
    if (!clean.startsWith('/') || clean.split('/').includes('..')) {
      toast({ variant: 'destructive', title: 'Not a directory path', description: 'Enter an absolute path such as /opt/app.' });
      return;
    }
    setRoot(clean);
  };

  // ---- editor / tree coordination ----
  const [openRequest, setOpenRequest] = useState(null);
  const [activeFilePath, setActiveFilePath] = useState(null);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const openFile = useCallback((node) => {
    if (node?.type === 'dir') return;
    setOpenRequest({ path: node.path, nonce: Date.now() });
  }, []);

  // ---- terminal cwd: the root on first resolve, or "Open terminal here" ----
  const [terminalCwd, setTerminalCwd] = useState(initialCwd || '');
  useEffect(() => { if (initialCwd) setTerminalCwd(initialCwd); }, [initialCwd]);
  useEffect(() => { if (root && !terminalCwd) setTerminalCwd(root); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [root]);

  // ---- preview: the container's published HTTP route(s) ----
  const routes = useMemo(() => (services || []).filter((s) => s?.domain), [services]);
  const [previewIdx, setPreviewIdx] = useState(0);
  const previewSvc = routes[Math.min(previewIdx, Math.max(0, routes.length - 1))] || null;
  const previewSrc = serviceUrl(previewSvc);
  const [previewReload, setPreviewReload] = useState(0);
  const onSaved = useCallback(() => setPreviewReload((n) => n + 1), []);

  // ---- layout ----
  const [layout, setLayout] = useState(() => ({ ...DEFAULT_LAYOUT, ...readJsonPref(lxcWorkspaceLayoutKey(containerName), {}) }));
  useEffect(() => { writeJsonPref(lxcWorkspaceLayoutKey(containerName), layout); }, [layout, containerName]);
  const setL = (patch) => setLayout((l) => ({ ...l, ...patch }));
  const [centerTab, setCenterTab] = useState('editor');
  const [terminalMax, setTerminalMax] = useState(false);
  const [previewFull, setPreviewFull] = useState(false);
  const [narrowPanel, setNarrowPanel] = useState('files');

  const drag = useRef(null);
  const onDragStart = (which) => (e) => { drag.current = { which, x: e.clientX, y: e.clientY, start: { ...layout } }; e.preventDefault(); };
  useEffect(() => {
    const move = (e) => {
      const d = drag.current; if (!d) return;
      if (d.which === 'left') setL({ left: Math.max(160, Math.min(480, d.start.left + (e.clientX - d.x))) });
      if (d.which === 'bottom') setL({ bottom: Math.max(120, Math.min(560, d.start.bottom - (e.clientY - d.y))) });
    };
    const up = () => { drag.current = null; };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- upload / download / zip (what the old Files tab could do) ----
  const fileInputRef = useRef(null);
  const uploadDirRef = useRef(null); // absolute dir for the next upload
  const [uploading, setUploading] = useState(false);
  const [zipOpen, setZipOpen] = useState(false);
  const startUpload = (absDir) => { uploadDirRef.current = absDir; fileInputRef.current?.click(); };
  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    const dir = uploadDirRef.current || root;
    if (!file || !dir) return;
    setUploading(true);
    try {
      await api.uploadFileToContainer(containerName, `${dir === '/' ? '' : dir}/`, file);
      toast({ title: 'Uploaded', description: `${file.name} → ${dir}` });
      setTreeRefresh((n) => n + 1);
    } catch (err) {
      toast({ title: 'Upload failed', description: err.message, variant: 'destructive' });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };
  const download = (node) => {
    const abs = fs.absolute(node.path);
    fetch(api.getContainerFileDownloadUrl(containerName, abs), { credentials: 'include' })
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.blob(); })
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = node.name || abs.split('/').pop();
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((err) => toast({ title: 'Download failed', description: err.message, variant: 'destructive' }));
  };
  const contextActions = useMemo(() => [
    { label: 'Download', when: (n) => n?.type === 'file', onClick: download },
    { label: 'Open terminal here', when: (n) => n?.type === 'dir', onClick: (n) => { setTerminalCwd(fs.absolute(n.path)); setL({ showBottom: true }); if (!wide) setNarrowPanel('terminal'); } },
    ...(canEdit ? [{ label: 'Upload a file here…', when: (n) => n?.type === 'dir', onClick: (n) => startUpload(fs.absolute(n.path)) }] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [fs, canEdit, wide]);

  if (!running) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Start the container to browse its files, edit them, preview the app and open a terminal.
      </div>
    );
  }

  const headerActions = canEdit ? (
    <>
      <button className="p-1 rounded hover:bg-muted" title="Open another directory" onClick={changeRoot}><FolderInput className="h-3.5 w-3.5" /></button>
      <button className="p-1 rounded hover:bg-muted" title={`Upload a file into ${root || 'the root'}`} onClick={() => startUpload(root)} disabled={uploading}>
        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
      </button>
      <button className="p-1 rounded hover:bg-muted" title="Upload a ZIP and extract it (optional startup script)" onClick={() => setZipOpen(true)}><FileArchive className="h-3.5 w-3.5" /></button>
    </>
  ) : (
    <button className="p-1 rounded hover:bg-muted" title="Open another directory" onClick={changeRoot}><FolderInput className="h-3.5 w-3.5" /></button>
  );

  const filesPane = (
    <FlightdeckFileTree
      fs={fs} canEdit={canEdit} activePath={activeFilePath} onOpen={openFile} refreshKey={treeRefresh}
      onTreeLoaded={onTreeLoaded} subtitle={root || 'Finding the app directory…'}
      headerActions={headerActions} contextActions={contextActions}
    />
  );
  const editorPane = (
    <FlightdeckEditor fs={fs} openRequest={openRequest} canEdit={canEdit} onActivePathChange={setActiveFilePath} onSaved={onSaved}
      placeholder="Pick a file in the Explorer to edit it" />
  );
  const previewPane = previewSrc ? (
    <div className="flex flex-col h-full min-h-0">
      {routes.length > 1 ? (
        <div className="flex items-center gap-2 px-2 py-1 border-b shrink-0 text-xs">
          <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <select
            value={Math.min(previewIdx, routes.length - 1)} onChange={(e) => setPreviewIdx(Number(e.target.value))}
            aria-label="Route to preview"
            className="h-9 sm:h-8 min-w-0 flex-1 sm:flex-none rounded border border-input bg-background px-2 text-xs"
          >
            {routes.map((r, i) => <option key={`${r.domain}${r.pathPrefix || '/'}`} value={i}>{serviceUrl(r)}</option>)}
          </select>
        </div>
      ) : null}
      <div className="flex-1 min-h-0">
        <PreviewPanel src={previewSrc} title={containerName} approved reloadKey={previewReload}
          fullHeight={previewFull} onToggleFullHeight={wide ? (() => setPreviewFull((v) => !v)) : null} />
      </div>
    </div>
  ) : (
    <div className="flex flex-col items-center justify-center gap-2 h-full p-4 text-center">
      <Globe className="h-6 w-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">No HTTP route is published for this container yet.</p>
      <p className="text-xs text-muted-foreground max-w-[40ch]">Add a service under Details and it appears here. An app that refuses to be framed still opens in a new tab from its route.</p>
    </div>
  );
  const terminalPane = (
    <LxcTerminalPanel containerName={containerName} initialCwd={terminalCwd} instanceType={instanceType} />
  );

  const uploadInput = <input ref={fileInputRef} type="file" onChange={handleUpload} className="hidden" />;
  const zipDialog = (
    <ZipUploadDialog
      mode="lxc" open={zipOpen} onOpenChange={setZipOpen} subjectName={containerName}
      defaultTargetDir={root || '/opt/app'}
      upload={(file, targetDir, onProgress) => api.uploadLxcZip(containerName, file, targetDir, onProgress)}
      apply={(uploadId, options) => api.applyLxcZip(containerName, uploadId, options)}
      cancel={(uploadId) => api.cancelLxcZip(containerName, uploadId)}
      onApplied={() => setTreeRefresh((n) => n + 1)}
    />
  );

  // ---- narrow (<lg): one panel at a time. Every panel stays MOUNTED and is
  // hidden with CSS: the editor keeps its open tabs (and unsaved edits) while
  // the operator hops to Files or Preview, the terminal keeps its PTY, and
  // the tree/preview are not refetched on every switch. ----
  if (!wide) {
    const show = (key) => (narrowPanel === key ? 'flex flex-col' : 'hidden');
    return (
      <div className="flex flex-col flex-1 min-h-0 rounded-lg border overflow-hidden bg-background">
        <div className={`flex-1 min-h-0 ${show('files')}`}>{filesPane}</div>
        <div className={`flex-1 min-h-0 ${show('editor')}`}>{editorPane}</div>
        <div className={`flex-1 min-h-0 ${show('preview')}`}>{previewPane}</div>
        <div className={`flex-1 min-h-0 bg-black ${show('terminal')}`}>{terminalPane}</div>
        <MobilePanelBar panels={NARROW_PANELS} current={narrowPanel} onSelect={setNarrowPanel} />
        {uploadInput}
        {zipDialog}
      </div>
    );
  }

  // ---- wide (lg+): explorer | editor/preview over a docked terminal ----
  const editorHidden = terminalMax;
  const terminalHidden = !layout.showBottom || (centerTab === 'preview' && previewFull && !terminalMax);
  return (
    <div className="flex flex-1 min-h-0 rounded-lg border overflow-hidden bg-background">
      {layout.showLeft && (
        <>
          <div style={{ width: layout.left }} className="shrink-0 border-r min-h-0">{filesPane}</div>
          <div onMouseDown={onDragStart('left')} className="w-1 cursor-col-resize hover:bg-primary/40 shrink-0" />
        </>
      )}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {/* Center tab strip. In full-height terminal mode it collapses to the
            terminal's own header, but the panes below keep their tree position. */}
        {terminalMax ? (
          <div className="flex items-center gap-1 px-2 h-8 border-b bg-muted/20 shrink-0 text-xs">
            <TerminalSquare className="h-3.5 w-3.5 mr-1" /> Terminal
            <div className="flex-1" />
            <button onClick={() => setTerminalMax(false)} title="Restore editor" className="p-1 rounded hover:bg-muted"><Minimize2 className="h-3.5 w-3.5" /></button>
          </div>
        ) : (
          <div className="flex items-center gap-1 px-2 h-8 border-b bg-muted/20 shrink-0">
            <button onClick={() => setCenterTab('editor')} className={`px-2 py-0.5 text-xs rounded ${centerTab === 'editor' ? 'bg-background border' : 'text-muted-foreground'}`}><Code2 className="h-3.5 w-3.5 inline mr-1" />Editor</button>
            <button onClick={() => setCenterTab('preview')} className={`px-2 py-0.5 text-xs rounded ${centerTab === 'preview' ? 'bg-background border' : 'text-muted-foreground'}`}><Eye className="h-3.5 w-3.5 inline mr-1" />Preview</button>
            <div className="flex-1" />
            <button onClick={() => setL({ showLeft: !layout.showLeft })} title="Toggle Explorer" className="p-1 rounded hover:bg-muted"><PanelLeftClose className="h-3.5 w-3.5" /></button>
            <button onClick={() => setL({ showBottom: !layout.showBottom })} title="Toggle Terminal" className="p-1 rounded hover:bg-muted"><PanelBottom className="h-3.5 w-3.5" /></button>
          </div>
        )}
        <div className={`flex-1 min-h-0 ${editorHidden ? 'hidden' : ''}`}>
          {centerTab === 'editor' ? editorPane : previewPane}
        </div>
        {/* The docked terminal — one mount point for every mode. */}
        {!terminalHidden && !terminalMax ? <div onMouseDown={onDragStart('bottom')} className="h-1 cursor-row-resize hover:bg-primary/40 shrink-0" /> : null}
        <div
          style={terminalMax ? undefined : { height: layout.bottom }}
          className={`${terminalHidden ? 'hidden' : 'flex'} ${terminalMax ? 'flex-1' : 'shrink-0 border-t'} min-h-0 bg-black flex-col`}
        >
          {!terminalMax ? (
            <div className="flex items-center px-2 h-6 shrink-0 text-[11px] text-white/60 border-b border-white/10">
              <TerminalSquare className="h-3 w-3 mr-1" /> Terminal
              <span className="ml-2 font-mono text-white/40 truncate">{terminalCwd}</span>
              <div className="flex-1" />
              <button onClick={() => setTerminalMax(true)} title="Full-height terminal" className="p-0.5 rounded hover:bg-white/10 text-white/70"><Maximize2 className="h-3 w-3" /></button>
            </div>
          ) : null}
          <div className="flex-1 min-h-0 flex flex-col">{terminalPane}</div>
        </div>
      </div>
      {uploadInput}
      {zipDialog}
    </div>
  );
}
