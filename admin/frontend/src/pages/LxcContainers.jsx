import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import LxcCertMounts from '@/components/LxcCertMounts';
import DelegatedEditing from '@/components/lxc/DelegatedEditing';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Server, Play, Square, RefreshCw, RotateCw, Trash2, Plus, Info,
  Cpu, MemoryStick, HardDrive, Globe, Camera, Loader2,
  Box, AlertCircle, Check, Download, Settings, Wifi,
  Terminal, FolderOpen, File, Upload, ChevronRight, ChevronDown, ArrowLeft, FolderUp, MessageSquare, StickyNote,
  X, Shield, Copy, Sparkles, Pencil, MoveRight, FileArchive
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import InteractiveTerminal from '@/components/InteractiveTerminal';
import ZipUploadDialog from '@/components/ZipUploadDialog';
import { useSnapshotExports } from '@/context/SnapshotExportContext';

const STATUS_COLORS = {
  Running: 'bg-green-500',
  Stopped: 'bg-gray-400',
  Error: 'bg-red-500',
  Frozen: 'bg-blue-500',
};

const STATUS_TEXT_COLORS = {
  Running: 'text-green-500',
  Stopped: 'text-gray-400',
  Error: 'text-red-500',
  Frozen: 'text-blue-500',
};

function StatusBadge({ status }) {
  const normalized = status?.charAt(0).toUpperCase() + status?.slice(1).toLowerCase();
  const bg = STATUS_COLORS[normalized] || 'bg-gray-400';
  const text = STATUS_TEXT_COLORS[normalized] || 'text-gray-400';
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${text}`}>
      <span className={`w-2 h-2 rounded-full ${bg} ${normalized === 'Running' ? 'animate-pulse' : ''}`} />
      {normalized || 'Unknown'}
    </span>
  );
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Compact human-readable duration. Used by the export/import progress
// rows to show elapsed and ETA without dragging in a date library.
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${remM}m` : `${h}h`;
}

// Renders the per-destination pending-export row beneath a
// snapshot.  Two reasons this is its own component:
//   1. It needs a 1Hz local timer so the elapsed reading ticks
//      between the parent's polled refreshes (snapshotS3Exports
//      refresh fires far less often than the operator wants the
//      seconds counter to advance).
//   2. Color-coding ('preparing' = amber, 'uploading' = sky)
//      reads better as a single styled unit than as a chain of
//      conditional class strings inline.
function PendingSnapshotExportRow({
  exportRow, onCancel, cancelDisabled, snapshotName,
}) {
  const e = exportRow;
  const pct = (e.bytes_total && e.bytes_total > 0)
    ? Math.min(99, Math.round((e.bytes_uploaded / e.bytes_total) * 100))
    : null;
  // Phase inferred from byte counts: bytes_total set means
  // putObject's first httpUploadProgress fired, i.e. we're
  // actively uploading.  Until then we're in the prep phase
  // (incus copy + export + read-into-buffer).
  const phase = pct !== null ? 'uploading' : 'preparing';

  // 1Hz tick so the displayed elapsed advances every second
  // regardless of how often the parent re-fetches.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const startedAtMs = e.started_at ? Date.parse(e.started_at) : null;
  const elapsedMs = startedAtMs ? Date.now() - startedAtMs : null;
  const elapsedLabel = elapsedMs !== null && elapsedMs >= 0
    ? formatDuration(elapsedMs) : null;

  const colors = phase === 'uploading'
    ? { bar: 'bg-sky-500', track: 'bg-sky-500/20', text: 'text-sky-600 dark:text-sky-400' }
    : { bar: 'bg-amber-500', track: 'bg-amber-500/20', text: 'text-amber-600 dark:text-amber-400' };

  return (
    <div className="flex items-center gap-2 text-[10.5px]">
      <span className="text-muted-foreground min-w-[5rem] truncate">
        → {e.destination_name || e.destination_id}
      </span>
      <div className={`flex-1 max-w-md h-1 ${colors.track} rounded overflow-hidden`}>
        <div
          className={`h-full ${colors.bar} transition-[width] duration-700`}
          style={{ width: pct !== null ? `${Math.max(2, pct)}%` : '5%' }}
        />
      </div>
      <span className={`font-mono tabular-nums ${colors.text}`}>
        {e.cancel_requested
          ? 'cancelling…'
          : pct !== null
            ? `${pct}%${elapsedLabel ? ` · ${elapsedLabel}` : ''}`
            : `preparing${elapsedLabel ? ` · ${elapsedLabel}` : '…'}`}
      </span>
      {!e.cancel_requested && (
        <button
          type="button"
          onClick={() => onCancel(snapshotName, e.id)}
          disabled={cancelDisabled}
          className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-muted/40 disabled:opacity-50"
        >
          Cancel
        </button>
      )}
    </div>
  );
}


// LxcTerminalPanel wraps InteractiveTerminal for an LXC.
// The legacy "Run install script" toolbar was removed once dedicated
// install scripts (XRay, n8n, …) replaced the apt one-liner — the
// button was a footgun on Alpine/CentOS and added no value for
// operators running real install scripts.
function LxcTerminalPanel({ containerName, initialCwd, instanceType }) {
  // Pass `?type=vm` to the WS upgrade when the selected instance is a
  // virtual machine. The backend uses that hint to run a guest-agent
  // probe and falls back to `incus console` when no agent is talking.
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
      <InteractiveTerminal
        wsPath={wsPath}
        initialCwd={initialCwd}
      />
    </div>
  );
}

// File manager component for browsing, uploading, and downloading files
function ContainerFiles({ containerName, onOpenTerminal }) {
  const { toast } = useToast();
  const [currentPath, setCurrentPath] = useState('/root');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [zipUploadOpen, setZipUploadOpen] = useState(false);
  const fileInputRef = useRef(null);

  const fetchFiles = useCallback(async (path) => {
    setLoading(true);
    try {
      const res = await api.listContainerFiles(containerName, path);
      setFiles(res.files || []);
      setCurrentPath(path);
    } catch (err) {
      toast({ title: 'Error', description: `Failed to list files: ${err.message}`, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [containerName, toast]);

  useEffect(() => {
    fetchFiles('/root');
  }, [fetchFiles]);

  const navigateTo = (path) => {
    fetchFiles(path);
  };

  const goUp = () => {
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    fetchFiles(parent);
  };

  const handleDownload = (filePath) => {
    const url = api.getContainerFileDownloadUrl(containerName, filePath);
    // Fetch with auth via the httpOnly cookie and trigger download.
    fetch(url, { credentials: 'include' })
      .then(res => res.blob())
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filePath.split('/').pop();
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(err => toast({ title: 'Download failed', description: err.message, variant: 'destructive' }));
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadFileToContainer(containerName, currentPath + '/', file);
      toast({ title: 'Uploaded', description: `${file.name} uploaded to ${currentPath}` });
      fetchFiles(currentPath);
    } catch (err) {
      toast({ title: 'Upload failed', description: err.message, variant: 'destructive' });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const breadcrumbs = currentPath.split('/').filter(Boolean);

  return (
    <div className="space-y-3">
      {/* Breadcrumb navigation */}
      <div className="flex items-center gap-1 text-xs flex-wrap">
        <Button variant="ghost" size="sm" className="h-6 px-1" onClick={() => navigateTo('/')}>
          /
        </Button>
        {breadcrumbs.map((part, i) => {
          const path = '/' + breadcrumbs.slice(0, i + 1).join('/');
          return (
            <span key={path} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => navigateTo(path)}>
                {part}
              </Button>
            </span>
          );
        })}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={goUp} disabled={currentPath === '/'}>
          <ArrowLeft className="h-3 w-3 mr-1" />Up
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => fetchFiles(currentPath)}>
          <RefreshCw className="h-3 w-3 mr-1" />Refresh
        </Button>
        {onOpenTerminal && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onOpenTerminal(currentPath)}
            title={`Open terminal in ${currentPath}`}
          >
            <Terminal className="h-3 w-3 mr-1" />Open terminal here
          </Button>
        )}
        <div className="flex-1" />
        <input ref={fileInputRef} type="file" onChange={handleUpload} className="hidden" />
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Upload className="h-3 w-3 mr-1" />}
          Upload
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setZipUploadOpen(true)}
          title="Extract a zip into the container (optional startup script)"
        >
          <FileArchive className="h-3 w-3 mr-1" />
          Upload ZIP
        </Button>
      </div>

      {/* Zip app-drop upload — two-phase confirm flow; conflicts are
          listed and only replaced (as .old) after confirmation */}
      <ZipUploadDialog
        mode="lxc"
        open={zipUploadOpen}
        onOpenChange={setZipUploadOpen}
        subjectName={containerName}
        defaultTargetDir="/opt/app"
        upload={(file, targetDir, onProgress) => api.uploadLxcZip(containerName, file, targetDir, onProgress)}
        apply={(uploadId, options) => api.applyLxcZip(containerName, uploadId, options)}
        cancel={(uploadId) => api.cancelLxcZip(containerName, uploadId)}
        onApplied={() => fetchFiles(currentPath)}
      />

      {/* File list */}
      <div className="border rounded-lg overflow-hidden">
        <div className="grid grid-cols-[1fr_80px_120px_40px] gap-2 px-3 py-1.5 bg-muted text-xs font-medium text-muted-foreground">
          <span>Name</span>
          <span className="text-right">Size</span>
          <span>Modified</span>
          <span></span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : files.length === 0 ? (
          <div className="text-center py-8 text-xs text-muted-foreground">
            Empty directory
          </div>
        ) : (
          <div className="overflow-y-auto divide-y">
            {files
              .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
              .map((file) => (
                <div
                  key={file.name}
                  className={`grid grid-cols-[1fr_80px_120px_40px] gap-2 px-3 py-1.5 text-xs items-center hover:bg-muted/50 ${
                    file.isDir ? 'cursor-pointer' : ''
                  }`}
                  onClick={() => file.isDir && navigateTo(file.path)}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {file.isDir ? (
                      <FolderOpen className="h-3.5 w-3.5 text-cyan-500 shrink-0" />
                    ) : (
                      <File className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className={`truncate ${file.isDir ? 'font-medium text-cyan-500' : ''}`}>
                      {file.name}
                    </span>
                  </span>
                  <span className="text-right text-muted-foreground">
                    {file.isDir ? '-' : formatSize(file.size)}
                  </span>
                  <span className="text-muted-foreground truncate">{file.modified}</span>
                  <span>
                    {!file.isDir && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={(e) => { e.stopPropagation(); handleDownload(file.path); }}
                      >
                        <Download className="h-3 w-3" />
                      </Button>
                    )}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function LxcContainers() {
  const { toast } = useToast();
  // Global snapshot-export queue state.  Drives the per-button
  // disabled gating: while this container's snapshot is being
  // pushed (or sitting in the queue), the per-snapshot Push to
  // S3 / delete / create buttons are greyed out so the operator
  // can't fire competing operations.
  const { status: exportQueue, isBusy: exportQueueBusy } = useSnapshotExports();
  // True when the queue currently has a running OR queued job
  // touching `containerName`.  Used to disable create/delete
  // affordances on the same container's snapshot list.
  const isContainerBusyForExport = (containerName) => {
    if (!containerName) return false;
    if ((exportQueue?.running || []).some((j) => j.container_name === containerName)) return true;
    if ((exportQueue?.queued || []).some((j) => j.container_name === containerName)) return true;
    return false;
  };
  const exportBusyTooltip = 'Waiting for snapshot export to finish.';

  // Incus availability
  const [incusAvailable, setIncusAvailable] = useState(null);
  const [incusVersion, setIncusVersion] = useState('');
  const [incusInitWarning, setIncusInitWarning] = useState(null);

  // Containers
  const [containers, setContainers] = useState([]);
  // 'all' | 'container' | 'virtual-machine'. Drives the filter chips
  // above the grid. Stored in component state (not URL/localStorage)
  // because the operator's intent is per-session — a CT-only operator
  // shouldn't see "VM" sticky-filtered the next time they hit the page.
  const [typeFilter, setTypeFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState({});

  // Dialogs
  const [createOpen, setCreateOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoDefaultTab, setInfoDefaultTab] = useState('details');
  const [terminalCwd, setTerminalCwd] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resizeOpen, setResizeOpen] = useState(false);

  // Selected container
  const [selectedContainer, setSelectedContainer] = useState(null);
  const [containerState, setContainerState] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotName, setSnapshotName] = useState('');
  const [snapshotNote, setSnapshotNote] = useState('');
  // Backup destinations gating the per-snapshot 'Push to S3' button
  // and feeding the destination-picker dialog.  Snapshot creation
  // itself is always local-only — operators promote to S3 via the
  // per-row push dialog after the fact.
  const [backupDestinations, setBackupDestinations] = useState([]);
  // Retroactive 'Push to S3' picker: when set, opens a small
  // dialog scoped to one snapshot row.  Operator picks one or
  // more destinations and the existing fan-out kicks off
  // asynchronously.
  const [pushSnapshotName, setPushSnapshotName] = useState(null);
  const [pushDestinationIds, setPushDestinationIds] = useState([]);
  const [pushBusy, setPushBusy] = useState(false);
  // Set of export-row IDs currently being canceled (prevents
  // double-clicks while the cancel round-trip is in flight).
  const [cancelingExportIds, setCancelingExportIds] = useState(new Set());
  // Snapshot whose deletion is pending operator confirmation.
  // null = no pending confirm.  Holds the snapshot name string.
  const [confirmDeleteSnap, setConfirmDeleteSnap] = useState(null);
  // Per-S3-destination delete confirm state.  When set, opens a
  // dialog scoped to a single export row (one snapshot × one
  // destination); the dialog also fires a HEAD round-trip on
  // mount to surface object-lock / retention info before the
  // operator commits.  Shape: { snapshotName, exportId,
  // destinationName, info?, infoLoading, busy }.
  const [pendingS3Delete, setPendingS3Delete] = useState(null);
  // Local-only delete confirm: drops the local Incus copy but
  // keeps every S3 copy.  Shape: { snapshotName, busy }.
  const [pendingLocalDelete, setPendingLocalDelete] = useState(null);
  // Pull-from-S3 confirm: re-imports an exported tarball back
  // into the local Incus pool as a snapshot.  Shape:
  // { snapshotName, exportRow, busy }.
  const [pendingPullFromS3, setPendingPullFromS3] = useState(null);
  // Rename dialog state.  { busy, value } when open, null when
  // closed.  The actual incus rename fires on confirm.
  const [pendingRename, setPendingRename] = useState(null);
  // Transfer-routes dialog state.  { fromName, toName, busy, services? }
  // — `services` is populated after a dry-run query so the
  // operator sees what's about to move before they commit.
  const [pendingTransfer, setPendingTransfer] = useState(null);
  // Per-snapshot S3 export state, keyed by snapshot name → array
  // of { destination_id, destination_name, status, error?, ... }.
  const [snapshotS3Exports, setSnapshotS3Exports] = useState({});
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  // Progress for the in-flight `Create snapshot` job. Driven by polling
  // /lxc/containers/:name/snapshot-jobs/:jobId. Shape:
  // { containerName, snapshotName, elapsedMs, estimateMs, status }.
  const [snapshotProgress, setSnapshotProgress] = useState(null);
  const [snapshotNotes, setSnapshotNotes] = useState({}); // { snapName: [notes] }
  const [expandedSnapshot, setExpandedSnapshot] = useState(null);
  const [newNoteText, setNewNoteText] = useState('');
  const [containerServices, setContainerServices] = useState([]);
  const [containerListening, setContainerListening] = useState(null);
  const [servicesLoading, setServicesLoading] = useState(false);
  // Phase 2c: full TCP + UDP listening-port set from the new
  // /containers/:name/listening-ports endpoint. Loaded when the
  // container detail dialog opens so the "add service" port input
  // can autocomplete from real data instead of the operator
  // guessing. Distinct from `containerListening` above (which is
  // probe-failure scoped, only TCP, only set on the legacy services
  // endpoint when at least one route is unreachable).
  const [exposedPorts, setExposedPorts] = useState({ tcp: [], udp: [] });
  const [exposedPortsLoading, setExposedPortsLoading] = useState(false);
  const [exposedPortsScannedAt, setExposedPortsScannedAt] = useState(null);
  // Phase 2c: MEET-preset quick-add. Modal opens with the domain
  // input pre-empty; the operator fills it and confirms. Detection
  // for whether to show the button at all is computed in render
  // from `exposedPorts.tcp`.
  const [meetQuickAddOpen, setMeetQuickAddOpen] = useState(false);
  const [meetQuickAddDomain, setMeetQuickAddDomain] = useState('');
  const [meetQuickAddSaving, setMeetQuickAddSaving] = useState(false);
  const [addServiceForm, setAddServiceForm] = useState({
    domain: '',
    port: '',
    obtainCert: true,
    healthPath: '',
    // Phase 2c: a non-root pathPrefix routes the new entry through
    // service_http_routes so multiple paths can share a domain
    // (MEET-style fan-out). stripPrefix and websocketEnabled are
    // only meaningful when pathPrefix != '/'.
    pathPrefix: '/',
    stripPrefix: false,
    websocketEnabled: false,
  });
  const [addingService, setAddingService] = useState(false);
  const [editingService, setEditingService] = useState(null); // { domain, port, obtainCert, healthPath } or null
  const [editServiceForm, setEditServiceForm] = useState({ domain: '', port: '', obtainCert: true, healthPath: '' });
  const [exporting, setExporting] = useState(false);
  // Live export progress. Carries the containerName the export belongs
  // to so the panel only renders progress for that container — without
  // this scoping, opening another LXC's panel mid-export inherits the
  // running progress bar. abortController lets the Cancel button kill
  // the in-flight fetch (and trigger backend cleanup via req.close).
  // Shape: { containerName, snapshotName?, loaded, total, elapsedMs,
  //          phase, throughputBps, abortController }
  const [exportProgress, setExportProgress] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState('');
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  // Live import progress: { loaded, total, phase, elapsedMs }. phase is
  // 'uploading' while the browser is sending bytes, 'processing' once
  // upload finishes and we're waiting on `incus import` on the host.
  const [importProgress, setImportProgress] = useState(null);

  // Host cleanup state. preview is the backend response; selected is
  // the set of category keys the operator wants to clean.
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupPreview, setCleanupPreview] = useState(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupSelected, setCleanupSelected] = useState(new Set());
  const [cleanupRunning, setCleanupRunning] = useState(false);

  // Preset images for the dropdown
  const PRESET_IMAGES = [
    { value: 'images:ubuntu/24.04', label: 'Ubuntu 24.04 LTS' },
    { value: 'images:ubuntu/22.04', label: 'Ubuntu 22.04 LTS' },
    { value: 'images:debian/13', label: 'Debian 13 (Trixie)' },
    { value: 'images:debian/12', label: 'Debian 12 (Bookworm)' },
    { value: 'images:debian/11', label: 'Debian 11 (Bullseye)' },
    { value: 'images:alpine/3.20', label: 'Alpine 3.20' },
    { value: 'images:centos/9-Stream', label: 'CentOS 9 Stream' },
    { value: 'images:fedora/40', label: 'Fedora 40' },
    { value: 'images:rockylinux/9', label: 'Rocky Linux 9' },
  ];

  // Init scripts run inside the freshly-launched container as soon as
  // it has an IP. apt-get can race networking on first boot, so each
  // template retries `apt-get update` up to 5 times with 5s backoff
  // before the install step. The set -e at the top makes the script
  // exit non-zero on the first install failure so the backend can
  // surface it instead of silently producing an empty container.
  const APT_RETRY_PREAMBLE = (
    '#!/bin/sh\n' +
    'set -e\n' +
    'export DEBIAN_FRONTEND=noninteractive\n' +
    '# Wait for DNS + apt repos to come up.\n' +
    'i=0\n' +
    'until apt-get update; do\n' +
    '  i=$((i+1))\n' +
    '  [ "$i" -ge 5 ] && { echo "apt-get update failed after 5 attempts" >&2; exit 1; }\n' +
    '  echo "apt-get update failed (attempt $i/5), retrying in 5s..." >&2\n' +
    '  sleep 5\n' +
    'done\n'
  );
  const INIT_TEMPLATES = [
    { value: 'essentials', label: 'Essentials (git, curl, sudo, nano, htop)',
      script: APT_RETRY_PREAMBLE + 'apt-get install -y git sudo curl wget nano htop unzip ca-certificates openssh-client\n' },
    { value: 'webdev', label: 'Web Development (Node.js, git, build tools)',
      script: APT_RETRY_PREAMBLE + 'apt-get install -y git sudo curl wget nano htop unzip ca-certificates openssh-client build-essential\ncurl -fsSL https://deb.nodesource.com/setup_22.x | bash -\napt-get install -y nodejs\n' },
    { value: 'python', label: 'Python Development',
      script: APT_RETRY_PREAMBLE + 'apt-get install -y git sudo curl wget nano htop unzip ca-certificates openssh-client build-essential python3 python3-pip python3-venv\n' },
    { value: 'docker', label: 'Docker-in-LXC',
      // Docker requires security.nesting + syscall intercepts on the
      // LXC itself or `dockerd` can't mount overlayfs. The Docker
      // checkbox below auto-enables when this template is picked so
      // the backend launches with the right --config flags.
      dockerSupport: true,
      script: APT_RETRY_PREAMBLE + 'apt-get install -y git sudo curl wget nano htop unzip ca-certificates\ncurl -fsSL https://get.docker.com | sh\n' },
  ];

  // Create form. Docker support + Privileged Docker default ON because
  // (a) most operators creating LXCs through this dashboard intend to
  // run Docker workloads, and (b) every Docker image that touches
  // sysctls during container init (n8n, anything basing on the
  // node:N-alpine line, etc.) fails OCI init unless AppArmor is
  // unconfined — which is what the Privileged toggle now bundles.
  // Operators who want stricter isolation untick before creating.
  const [imageSelection, setImageSelection] = useState('');
  const [createForm, setCreateForm] = useState({
    name: '', image: '', type: 'container',
    cpu: '', memory: '', initScript: '',
    dockerSupport: true, dockerPrivileged: true,
    services: [{ domain: '', port: '', obtainCert: true, healthPath: '' }],
  });
  const [templateSelection, setTemplateSelection] = useState('');
  const [creating, setCreating] = useState(false);
  const [createProgress, setCreateProgress] = useState(null); // { phase, message, elapsed, error, ip }
  const pollRef = useRef(null);

  // Resize form
  const [resizeForm, setResizeForm] = useState({ cpu: '', memory: '' });
  const [resizing, setResizing] = useState(false);

  // Delete target
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Live image catalog for the Create dialog dropdown. Populated on
  // dialog open from GET /lxc/images (already-pulled local images),
  // each row annotated with `supports: ['container'|'virtual-machine']`
  // by the backend so we can filter by createForm.type. PRESET_IMAGES
  // below is the fallback when the live fetch fails (incus daemon
  // down, network glitch on the proxy hop, etc.) — without it the
  // operator gets locked out of creating an instance during a
  // degraded-but-not-down condition.
  const [imageCatalog, setImageCatalog] = useState(null);
  const [imageCatalogLoading, setImageCatalogLoading] = useState(false);
  const [imageCatalogError, setImageCatalogError] = useState(null);

  // Smooth local timer for the snapshot progress panel. The poll loop
  // in handleCreateSnapshot only refreshes every second; this ticks
  // the elapsed display in between so it counts up steadily instead of
  // freezing. Running while a snapshot job is active and pinned to its
  // start time so we don't drift.
  useEffect(() => {
    if (!snapshotProgress || snapshotProgress.status !== 'running' || !snapshotProgress.startedAt) return;
    const tick = setInterval(() => {
      setSnapshotProgress((p) => {
        if (!p || p.status !== 'running' || !p.startedAt) return p;
        return { ...p, elapsedMs: Date.now() - p.startedAt };
      });
    }, 500);
    return () => clearInterval(tick);
  }, [snapshotProgress?.status, snapshotProgress?.startedAt]);

  // Check Incus status on mount
  useEffect(() => {
    api.getLxcStatus()
      .then((res) => {
        setIncusAvailable(res.available);
        setIncusVersion(res.version || '');
        if (res.initWarning) setIncusInitWarning(res.initWarning);
      })
      .catch(() => {
        setIncusAvailable(false);
      });
  }, []);

  // Fetch the live image catalog whenever the Create dialog opens.
  // Re-fetches on every open (cheap; one shell-out, ~10ms) so a fresh
  // image pull from the Image Cache page shows up without a page
  // reload. Errors don't block the dialog — the Select falls back to
  // PRESET_IMAGES below.
  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    setImageCatalogLoading(true);
    setImageCatalogError(null);
    api.getLxcImages()
      .then((res) => {
        if (cancelled) return;
        setImageCatalog(Array.isArray(res?.images) ? res.images : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setImageCatalog(null);
        setImageCatalogError(err?.message || 'Failed to load image catalog');
      })
      .finally(() => {
        if (!cancelled) setImageCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, [createOpen]);

  // Fetch containers
  const fetchContainers = useCallback(async () => {
    if (incusAvailable === false) return;
    try {
      const res = await api.getLxcContainers();
      setContainers(res.containers || []);
    } catch (err) {
      console.error('Failed to fetch containers:', err);
    } finally {
      setLoading(false);
    }
  }, [incusAvailable]);

  // Initial load and polling
  useEffect(() => {
    if (incusAvailable === null) return;
    fetchContainers();
    const interval = setInterval(fetchContainers, 10000);
    return () => clearInterval(interval);
  }, [incusAvailable, fetchContainers]);

  // Container actions
  const handleAction = async (action, name) => {
    const key = `${name}-${action}`;
    setActionLoading((prev) => ({ ...prev, [key]: true }));
    try {
      switch (action) {
        case 'start':
          await api.startLxcContainer(name);
          toast({ title: 'Container started', description: `${name} is starting up.` });
          break;
        case 'stop':
          await api.stopLxcContainer(name);
          toast({ title: 'Container stopped', description: `${name} has been stopped.` });
          break;
        case 'restart':
          await api.restartLxcContainer(name);
          toast({ title: 'Container restarted', description: `${name} is restarting.` });
          break;
        case 'reboot':
          await api.rebootLxcContainer(name);
          toast({ title: 'Reboot requested', description: `${name} is rebooting gracefully.` });
          break;
      }
      await fetchContainers();
    } catch (err) {
      toast({ title: 'Action failed', description: err.message, variant: 'destructive' });
    } finally {
      setActionLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  // Stop polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Create container (async with progress polling)
  const handleCreate = async () => {
    if (!createForm.name || !createForm.image) {
      toast({ title: 'Validation error', description: 'Name and image are required.', variant: 'destructive' });
      return;
    }
    setCreating(true);
    setCreateProgress({ phase: 'starting', message: 'Starting creation...', elapsed: 0 });

    try {
      // Filter services to only include entries with at least a domain specified.
      // healthPath is optional; trim and forward only when set so the backend
      // sees null vs an empty string and stays on TCP-only.
      const validServices = createForm.services
        .filter((s) => s.domain.trim())
        .map((s) => ({
          domain: s.domain.trim(),
          port: s.port ? parseInt(s.port, 10) : 80,
          obtainCert: s.obtainCert,
          ...(s.healthPath && s.healthPath.trim() && { healthPath: s.healthPath.trim() }),
        }));

      const isVm = createForm.type === 'virtual-machine';
      const data = {
        name: createForm.name,
        image: createForm.image,
        type: createForm.type,
        ...(validServices.length > 0 && { services: validServices }),
        ...(createForm.cpu && { cpu: parseInt(createForm.cpu, 10) }),
        ...(createForm.memory && { memory: parseInt(createForm.memory, 10) }),
        ...(createForm.initScript && { initScript: createForm.initScript }),
        // Docker-in-LXC syscall intercepts are CT-only (the backend
        // refuses them with 400 for VMs); never send them when type=vm.
        ...(!isVm && createForm.dockerSupport && { dockerSupport: true }),
        ...(!isVm && createForm.dockerSupport && createForm.dockerPrivileged && { dockerPrivileged: true }),
      };
      await api.createLxcContainer(data);

      // Start polling for progress
      const containerName = createForm.name;
      const pollStatus = async () => {
        try {
          const status = await api.getLxcCreateStatus(containerName);
          setCreateProgress(status);

          if (status.phase === 'ready') {
            // Success — stop polling
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setCreating(false);
            setCreateProgress(null);
            setCreateOpen(false);
            setCreateForm({ name: '', image: '', type: 'container', cpu: '', memory: '', initScript: '', dockerSupport: true, dockerPrivileged: true, services: [{ domain: '', port: '', obtainCert: true, healthPath: '' }] });
            setImageSelection('');
            setTemplateSelection('');
            if (status.initScriptWarning) {
              toast({
                title: 'Container created — init script failed',
                description: status.initScriptWarning,
                variant: 'destructive',
              });
            } else {
              toast({
                title: 'Container created',
                description: `${containerName} is running${status.ip ? ` (IP: ${status.ip})` : ''}`,
              });
            }
            await fetchContainers();
          } else if (status.phase === 'failed') {
            // Failed — stop polling
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setCreating(false);
            toast({
              title: 'Creation failed',
              description: status.error || 'Unknown error',
              variant: 'destructive',
            });
          }
        } catch (err) {
          console.error('Poll error:', err);
        }
      };

      // Poll every 2 seconds
      pollRef.current = setInterval(pollStatus, 2000);
      // Run first check immediately
      setTimeout(pollStatus, 500);

    } catch (err) {
      setCreating(false);
      setCreateProgress(null);
      toast({
        title: 'Creation failed',
        description: err.message || 'Unknown error occurred',
        variant: 'destructive',
      });
    }
  };

  // Open info dialog
  const fetchContainerServices = useCallback(async (containerName) => {
    setServicesLoading(true);
    try {
      const res = await api.getLxcServices(containerName);
      setContainerServices(res.services || []);
      setContainerListening(res.listening || null);
    } catch {
      setContainerServices([]);
      setContainerListening(null);
    } finally {
      setServicesLoading(false);
    }
  }, []);

  // Fetch the container's currently-listening TCP+UDP ports. Used
  // by the detail panel's exposed-ports chip row + the port-input
  // datalist so an operator picking a service port sees real data
  // instead of guessing. Independent from fetchContainerServices —
  // that endpoint only returns listening data on probe failure;
  // this one always probes when the panel opens.
  const fetchExposedPorts = useCallback(async (containerName) => {
    setExposedPortsLoading(true);
    try {
      const res = await api.getLxcListeningPorts(containerName);
      setExposedPorts({ tcp: res.tcp || [], udp: res.udp || [] });
      setExposedPortsScannedAt(res.scannedAt || null);
    } catch {
      setExposedPorts({ tcp: [], udp: [] });
      setExposedPortsScannedAt(null);
    } finally {
      setExposedPortsLoading(false);
    }
  }, []);

  const openInfo = async (container, tab = 'details') => {
    setSelectedContainer(container);
    setContainerState(null);
    setSnapshots([]);
    setContainerServices([]);
    setContainerListening(null);
    setExposedPorts({ tcp: [], udp: [] });
    setExposedPortsScannedAt(null);
    setAddServiceForm({
      domain: '',
      port: '',
      obtainCert: true,
      healthPath: '',
      pathPrefix: '/',
      stripPrefix: false,
      websocketEnabled: false,
    });
    setEditingService(null);
    setInfoDefaultTab(tab);
    setTerminalCwd('');
    setInfoOpen(true);
    try {
      const [stateRes, snapRes, expRes, destRes] = await Promise.all([
        api.getLxcContainerState(container.name).catch(() => null),
        api.getLxcSnapshots(container.name).catch(() => ({ snapshots: [] })),
        // Per-snapshot S3 export rows.  Cheap (small DB query)
        // and needed before the snapshots list renders so the
        // 'on-site / off-site' chips are accurate on first paint.
        api.getLxcSnapshotExports(container.name).catch(() => ({ exports: [] })),
        // Backup destinations for the 'Also push to S3' picker.
        // Fetched here (rather than on dialog mount) so the
        // multi-select renders without a flash on open.
        api.backupsListStorage().catch(() => ({ destinations: [] })),
      ]);
      if (stateRes) setContainerState(stateRes.state);
      setSnapshots(snapRes.snapshots || []);
      const grouped = {};
      for (const r of expRes.exports || []) {
        (grouped[r.snapshot_name] ||= []).push(r);
      }
      setSnapshotS3Exports(grouped);
      setBackupDestinations(destRes.destinations || []);
    } catch {
      // Silently fail for detail fetch
    }
    // Fetch services + exposed ports in parallel — services lookup
    // can be slow when probing routes, exposed-ports is a cheap
    // /proc read, no need to serialize.
    fetchContainerServices(container.name);
    fetchExposedPorts(container.name);
  };

  // Delete container
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteLxcContainer(deleteTarget);
      toast({ title: 'Container deleted', description: `${deleteTarget} has been removed.` });
      setDeleteOpen(false);
      setDeleteTarget(null);
      if (infoOpen && selectedContainer?.name === deleteTarget) {
        setInfoOpen(false);
      }
      await fetchContainers();
    } catch (err) {
      toast({ title: 'Delete failed', description: err.message, variant: 'destructive' });
    } finally {
      setDeleting(false);
    }
  };

  // Resize container
  const handleResize = async () => {
    if (!selectedContainer) return;
    setResizing(true);
    try {
      const limits = {};
      if (resizeForm.cpu) limits.cpu = parseInt(resizeForm.cpu, 10);
      if (resizeForm.memory) limits.memory = parseInt(resizeForm.memory, 10);
      await api.resizeLxcContainer(selectedContainer.name, limits);
      toast({ title: 'Container resized', description: `Resource limits updated for ${selectedContainer.name}.` });
      setResizeOpen(false);
      await fetchContainers();
    } catch (err) {
      toast({ title: 'Resize failed', description: err.message, variant: 'destructive' });
    } finally {
      setResizing(false);
    }
  };

  // Service management
  const handleAddService = async () => {
    if (!selectedContainer || !addServiceForm.domain.trim()) return;
    setAddingService(true);
    try {
      const domain = addServiceForm.domain.trim();
      const trimmedHealthPath = (addServiceForm.healthPath || '').trim();
      const pathPrefix = (addServiceForm.pathPrefix || '/').trim() || '/';
      const res = await api.addLxcService(selectedContainer.name, {
        domain,
        port: parseInt(addServiceForm.port, 10) || 80,
        obtainCert: addServiceForm.obtainCert,
        healthPath: trimmedHealthPath || null,
        pathPrefix,
        // strip is meaningful only on non-root paths; the backend
        // defaults to true when path != '/' if the field is omitted,
        // but we send it explicitly so the operator's choice
        // round-trips on edit.
        ...(pathPrefix !== '/' && {
          stripPrefix: !!addServiceForm.stripPrefix,
          websocketEnabled: !!addServiceForm.websocketEnabled,
        }),
      });
      if (res?.warning) {
        toast({ title: 'Service saved with warning', description: res.warning, variant: 'destructive' });
      } else {
        toast({ title: 'Service added', description: `${domain}${pathPrefix === '/' ? '' : pathPrefix} configured.` });
      }
      setAddServiceForm({
        domain: '',
        port: '',
        obtainCert: true,
        healthPath: '',
        pathPrefix: '/',
        stripPrefix: false,
        websocketEnabled: false,
      });
      fetchContainerServices(selectedContainer.name);
    } catch (err) {
      toast({ title: 'Failed to add service', description: err.message, variant: 'destructive' });
    } finally {
      setAddingService(false);
    }
  };

  // Phase 2c: detect when the LXC's listening ports match MEET's
  // canonical layout (frontend 3000, livekit 7880, livekit-tcp-fb
  // 7881, api 8080). UDP isn't checked — LiveKit allocates the
  // 50000-60000 RTC range only when a call is in progress, so it's
  // expected to be absent at install time.
  const MEET_REQUIRED_TCP = [3000, 7880, 7881, 8080];
  const meetPortsDetected =
    MEET_REQUIRED_TCP.every((p) =>
      exposedPorts.tcp.some((row) => row.port === p && (!row.portEnd || row.portEnd === p))
    );

  const submitMeetQuickAdd = async () => {
    if (!selectedContainer || !meetQuickAddDomain.trim()) return;
    setMeetQuickAddSaving(true);
    try {
      const res = await api.quickAddMeet(selectedContainer.name, meetQuickAddDomain.trim());
      // Phase 2c: response carries per-action counts so re-runs can
      // report what was actually changed vs what was already in
      // place. Shape after the idempotency fix:
      //   routes:   { added, skipped, normalized }
      //   forwards: { added, skipped }
      const r = res?.routes;
      const f = res?.forwards;
      const summarize = () => {
        // Backwards-compat: original endpoint returned plain numbers.
        if (typeof r === 'number' && typeof f === 'number') {
          return `${r} HTTP routes + ${f} L4 forwards on ${res.domain}.`;
        }
        const parts = [];
        if (r) {
          const bits = [`${r.added} added`];
          if (r.skipped) bits.push(`${r.skipped} already correct`);
          if (r.normalized) bits.push(`${r.normalized} fixed`);
          parts.push(`routes: ${bits.join(', ')}`);
        }
        if (f) {
          const bits = [`${f.added} added`];
          if (f.skipped) bits.push(`${f.skipped} already correct`);
          parts.push(`L4: ${bits.join(', ')}`);
        }
        return `${parts.join('; ')} on ${res.domain}.`;
      };
      if (res?.warning) {
        toast({ title: 'MEET installed with warning', description: res.warning, variant: 'destructive' });
      } else {
        toast({ title: 'MEET installed', description: summarize() });
      }
      setMeetQuickAddOpen(false);
      setMeetQuickAddDomain('');
      fetchContainerServices(selectedContainer.name);
      fetchExposedPorts(selectedContainer.name);
    } catch (err) {
      toast({ title: 'Failed to add MEET', description: err.message, variant: 'destructive' });
    } finally {
      setMeetQuickAddSaving(false);
    }
  };

  // Phase 2c: takes the full service row (or just the legacy
  // domain string) so we can preserve routeId / source / pathPrefix
  // through the update call. Editing a routes-table row updates
  // through the Phase 2c pipeline; editing a legacy file row stays
  // on the file-write path.
  const handleUpdateService = async (svc) => {
    if (!selectedContainer || !editServiceForm.domain.trim()) return;
    const oldDomain = typeof svc === 'string' ? svc : svc.domain;
    const routeId = typeof svc === 'string' ? undefined : (svc.source === 'db' ? svc.id : undefined);
    try {
      const domain = editServiceForm.domain.trim();
      const trimmedHealthPath = (editServiceForm.healthPath || '').trim();
      const body = {
        domain,
        port: parseInt(editServiceForm.port, 10) || 80,
        obtainCert: editServiceForm.obtainCert,
        healthPath: trimmedHealthPath || null,
      };
      // Routes-table rows carry the full set of per-route knobs;
      // forward them through so toggling strip / WS works inline.
      if (routeId) {
        body.pathPrefix = (editServiceForm.pathPrefix || '/').trim() || '/';
        body.stripPrefix = !!editServiceForm.stripPrefix;
        body.websocketEnabled = !!editServiceForm.websocketEnabled;
      }
      const res = await api.updateLxcService(selectedContainer.name, oldDomain, body, routeId);
      if (res?.warning) {
        toast({ title: 'Service saved with warning', description: res.warning, variant: 'destructive' });
      } else {
        toast({ title: 'Service updated', description: `${domain}${body.pathPrefix && body.pathPrefix !== '/' ? body.pathPrefix : ''} updated.` });
      }
      setEditingService(null);
      fetchContainerServices(selectedContainer.name);
    } catch (err) {
      toast({ title: 'Failed to update service', description: err.message, variant: 'destructive' });
    }
  };

  // Phase 2c: when the service entry is a routes-table row
  // (source='db'), the caller passes its route id so the backend
  // can target the right pipeline. Legacy file-only entries
  // (source='file' or absent) still delete by domain.
  const handleDeleteService = async (svc) => {
    if (!selectedContainer) return;
    const domain = typeof svc === 'string' ? svc : svc.domain;
    const routeId = typeof svc === 'string' ? undefined : (svc.source === 'db' ? svc.id : undefined);
    try {
      const res = await api.deleteLxcService(selectedContainer.name, domain, routeId);
      if (res?.warning) {
        toast({ title: 'Service removed with warning', description: res.warning, variant: 'destructive' });
      } else {
        toast({ title: 'Service removed', description: `${domain} removed.` });
      }
      fetchContainerServices(selectedContainer.name);
    } catch (err) {
      toast({ title: 'Failed to remove service', description: err.message, variant: 'destructive' });
    }
  };

  // Snapshot actions
  // Streamed download with live byte counter, phase indicator, and
  // throughput. Handles both the live-container export and the
  // per-snapshot export — they share progress wiring; only the URL,
  // filename, and pre-flight estimator differ.
  //
  // The export is bursty by nature: incus emits a small tarball
  // header (~few KB) immediately, then stalls for minutes while it
  // does its internal snapshot/copy work (especially on dir
  // storage), then streams the real rootfs bytes. We treat that
  // as two distinct phases ("preparing" → "streaming") so the UI
  // doesn't look stuck during the copy phase. Throughput is a
  // 10-second moving average computed from the read-loop samples.
  const streamDownload = async ({ url, filename, fetchEstimate, label, containerName, snapshotName }) => {
    const startTime = Date.now();
    // AbortController wires the Cancel button to fetch — calling
    // .abort() makes reader.read() throw, the catch path below
    // tags it 'AbortError' so the toast says "cancelled" rather
    // than "failed". The backend's req.on('close') handler kills
    // the incus export child + cleans up any temp container.
    const abortController = new AbortController();
    setExportProgress({
      containerName, snapshotName: snapshotName || null,
      loaded: 0, total: null, elapsedMs: 0,
      phase: 'preparing', throughputBps: null,
      abortController,
    });

    let total = null;
    if (fetchEstimate) {
      try {
        const info = await fetchEstimate();
        if (typeof info?.estimatedBytes === 'number') total = info.estimatedBytes;
      } catch {
        // pre-flight is best-effort
      }
    }
    setExportProgress((p) => ({ ...(p || { loaded: 0 }), total, elapsedMs: 0, phase: 'preparing' }));

    const res = await fetch(url, { credentials: 'include', signal: abortController.signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `${label} failed`);
    }
    const reportedLen = res.headers.get('content-length');
    if (reportedLen && /^\d+$/.test(reportedLen)) {
      total = parseInt(reportedLen, 10);
    }

    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    let lastByteTime = startTime;
    // Threshold: first chunks include the ~5-15 KB tarball header
    // incus emits before doing its real work. We don't switch to
    // 'streaming' until we've seen meaningful payload — 256 KB filters
    // out the header reliably across compressors.
    const STREAM_THRESHOLD = 256 * 1024;
    let firstStreamingByteTime = null;
    // 10s moving window of (loaded, t) samples, drives the
    // throughput readout.
    const samples = [];

    // Keep elapsed/phase/throughput fresh while the read loop is
    // blocked waiting on incus (which can be minutes during the
    // dir-storage copy phase). The read loop only fires on
    // incoming chunks — without this interval, the UI would freeze
    // mid-export.
    const tick = setInterval(() => {
      const now = Date.now();
      const sinceLastByte = now - lastByteTime;
      // 'preparing' until we've seen enough bytes to know rootfs
      // streaming has begun OR we've been quiet for >2s after the
      // header, meaning incus is in its copy/compression stage.
      let phase = 'preparing';
      if (firstStreamingByteTime) {
        phase = sinceLastByte > 5000 ? 'stalled' : 'streaming';
      }
      let throughputBps = null;
      if (samples.length >= 2 && firstStreamingByteTime) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const dt = (last.t - first.t) / 1000;
        const dBytes = last.loaded - first.loaded;
        if (dt > 0.25) throughputBps = dBytes / dt;
      }
      setExportProgress((p) => p ? { ...p, elapsedMs: now - startTime, phase, throughputBps } : p);
    }, 500);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        const now = Date.now();
        lastByteTime = now;
        if (!firstStreamingByteTime && loaded >= STREAM_THRESHOLD) {
          firstStreamingByteTime = now;
          // Reset samples window so throughput reflects the
          // streaming phase, not the long preparing-then-idle
          // ramp-up.
          samples.length = 0;
          samples.push({ loaded, t: now });
        } else if (firstStreamingByteTime) {
          samples.push({ loaded, t: now });
          while (samples.length > 1 && now - samples[0].t > 10000) samples.shift();
        }
        // Drop the loaded count into state immediately so the bytes
        // counter ticks per-chunk; the interval tick handles
        // elapsed/phase/throughput on its own cadence.
        setExportProgress((p) => p ? { ...p, loaded, total } : p);
      }
    } finally {
      clearInterval(tick);
    }

    const blob = new Blob(chunks, { type: 'application/gzip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    return loaded;
  };

  // Export the live container as a tarball. Streams via ReadableStream
  // so the UI can show a live byte counter + percentage. With the
  // export endpoint no longer force-stopping the container, this is a
  // true online backup — the bridge IP stays bound and the inline
  // services list keeps showing the active routes throughout.
  const handleExport = async () => {
    if (!selectedContainer) return;
    setExporting(true);
    const ctName = selectedContainer.name;
    try {
      const loaded = await streamDownload({
        url: `/api/lxc/containers/${ctName}/export`,
        filename: `${ctName}-backup.tar.gz`,
        fetchEstimate: () => api.getLxcExportInfo(ctName),
        label: 'Export',
        containerName: ctName,
      });
      toast({ title: 'Export complete', description: `${ctName} backup downloaded (${formatSize(loaded)}).` });
    } catch (err) {
      // AbortError = operator clicked Cancel. Distinguish it from a
      // real failure so the toast doesn't blame the operator's
      // action as an error.
      if (err?.name === 'AbortError') {
        toast({ title: 'Export cancelled', description: `${ctName} export cancelled.` });
      } else {
        toast({ title: 'Export failed', description: err.message, variant: 'destructive' });
      }
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  // Refresh the per-snapshot S3 export rows for the currently-
  // selected container.  Used by the polling effect below + by
  // any handler that needs an immediate refresh after a state
  // change (push, cancel, delete).
  const refreshSnapshotExports = async () => {
    if (!selectedContainer) return;
    try {
      const r = await api.getLxcSnapshotExports(selectedContainer.name);
      const grouped = {};
      for (const e of r.exports || []) {
        (grouped[e.snapshot_name] ||= []).push(e);
      }
      setSnapshotS3Exports(grouped);
    } catch { /* tolerated */ }
  };

  // While ANY snapshot export is in 'pending' state, poll the
  // exports endpoint every 2.5s so the operator sees the
  // progress percentage advance.  Polling stops automatically
  // when nothing's pending.  Survives page refresh because
  // pending state lives in the DB, not in this component.
  useEffect(() => {
    if (!selectedContainer) return undefined;
    const anyPending = Object.values(snapshotS3Exports).some(
      (rows) => rows.some((r) => r.status === 'pending')
    );
    if (!anyPending) return undefined;
    const id = setInterval(refreshSnapshotExports, 2500);
    return () => clearInterval(id);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [snapshotS3Exports, selectedContainer]);

  // Open the 'Push to S3' picker for a specific snapshot.
  // Default-selects every destination not already exported to.
  const openPushDialog = (snapshotName) => {
    const existing = (snapshotS3Exports[snapshotName] || [])
      .filter((e) => e.status === 'exported' || e.status === 'pending')
      .map((e) => e.destination_id);
    const candidates = backupDestinations
      .filter((d) => !existing.includes(d.id))
      .map((d) => d.id);
    setPushSnapshotName(snapshotName);
    setPushDestinationIds(candidates);
  };

  const submitPushDialog = async () => {
    if (!selectedContainer || !pushSnapshotName) return;
    if (pushDestinationIds.length === 0) {
      toast({
        title: 'No destinations selected',
        description: 'Pick at least one destination to push to.',
        variant: 'destructive',
      });
      return;
    }
    setPushBusy(true);
    try {
      const r = await api.exportLxcSnapshotToS3(
        selectedContainer.name, pushSnapshotName, pushDestinationIds,
      );
      toast({
        title: 'Push started',
        description: `Uploading ${pushSnapshotName} to ${r.queued} destination${r.queued === 1 ? '' : 's'}.`,
      });
      setPushSnapshotName(null);
      setPushDestinationIds([]);
      // Immediate refresh so the 'pending' chips render.  The
      // polling effect takes over from there.
      await refreshSnapshotExports();
    } catch (err) {
      toast({
        title: 'Push failed to start',
        description: err?.message || 'unknown error',
        variant: 'destructive',
      });
    } finally {
      setPushBusy(false);
    }
  };

  const cancelSnapshotExport = async (snapshotName, exportId) => {
    if (!selectedContainer || cancelingExportIds.has(exportId)) return;
    setCancelingExportIds((prev) => new Set(prev).add(exportId));
    try {
      const r = await api.cancelLxcSnapshotS3Export(
        selectedContainer.name, snapshotName, exportId,
      );
      if (r.alreadyFinished) {
        toast({
          title: 'Already finished',
          description: `Export already in '${r.status}' state.`,
        });
      } else {
        toast({ title: 'Cancel requested', description: 'Upload will abort shortly.' });
      }
      await refreshSnapshotExports();
    } catch (err) {
      toast({
        title: 'Cancel failed',
        description: err?.message || 'unknown error',
        variant: 'destructive',
      });
    } finally {
      setCancelingExportIds((prev) => {
        const next = new Set(prev);
        next.delete(exportId);
        return next;
      });
    }
  };

  // dismissSnapshotS3Export — operator-driven cleanup of a
  // 'failed' export row.  Backend treats failed/pending status
  // specially in deleteSnapshotExport: drops the DB row outright,
  // no S3 call.  No confirm dialog because the operation is
  // non-destructive — the row references nothing in any bucket.
  // Refresh both the snapshot list AND the S3 export rows.  The
  // backend's snapshot list now merges S3-only ghost rows; after
  // a per-location delete that drops the last copy of a ghost,
  // we need both fetches to converge so the row disappears.
  const refreshSnapshotsAndExports = async () => {
    if (!selectedContainer) return;
    try {
      const snapRes = await api.getLxcSnapshots(selectedContainer.name);
      setSnapshots(snapRes.snapshots || []);
    } catch { /* tolerated */ }
    await refreshSnapshotExports();
  };

  const dismissSnapshotS3Export = async (snapshotName, exportId) => {
    if (!selectedContainer) return;
    try {
      await api.deleteLxcSnapshotS3Export(
        selectedContainer.name, snapshotName, exportId,
      );
      toast({ title: 'Failed entry dismissed' });
      await refreshSnapshotsAndExports();
    } catch (err) {
      toast({
        title: 'Dismiss failed',
        description: err?.message || 'unknown error',
        variant: 'destructive',
      });
    }
  };

  // Open the per-S3-destination delete confirm dialog.  The actual
  // delete fires from confirmS3DeleteFromDialog once the operator
  // clicks Confirm; that's where the lock-aware error handling
  // lives.
  const deleteSnapshotS3Copy = (snapshotName, exportId, destinationName) => {
    if (!selectedContainer) return;
    setPendingS3Delete({
      snapshotName, exportId, destinationName,
      info: null, infoLoading: true, busy: false,
    });
  };

  const confirmS3DeleteFromDialog = async () => {
    const p = pendingS3Delete;
    if (!p || !selectedContainer) return;
    setPendingS3Delete({ ...p, busy: true });
    try {
      await api.deleteLxcSnapshotS3Export(
        selectedContainer.name, p.snapshotName, p.exportId,
      );
      toast({
        title: 'S3 copy removed',
        description: `${p.snapshotName} deleted from ${p.destinationName || 'destination'}.`,
      });
      setPendingS3Delete(null);
      await refreshSnapshotsAndExports();
    } catch (err) {
      // 423 Locked: server detected retention or legal hold.  Keep
      // the dialog open and replace its body with the lock state
      // so the operator sees why the delete didn't go through.
      if (err?.locked) {
        setPendingS3Delete({
          ...p,
          busy: false,
          info: {
            found: true,
            locked: true,
            retention_until: err.retention_until || null,
            retention_mode: err.retention_mode || null,
            legal_hold: !!err.legal_hold,
          },
        });
        toast({
          title: 'S3 object is locked',
          description: err?.message || 'Bucket has Object Lock enabled.',
          variant: 'destructive',
        });
        return;
      }
      toast({
        title: 'Delete failed',
        description: err?.message || 'unknown error',
        variant: 'destructive',
      });
      setPendingS3Delete({ ...p, busy: false });
    }
  };

  // Fire a HEAD round-trip when the S3 delete dialog opens so the
  // body can render the object's retention state before the
  // operator confirms.  Re-runs whenever a different export id
  // is set as pending.
  useEffect(() => {
    if (!pendingS3Delete || !selectedContainer) return;
    if (pendingS3Delete.info && !pendingS3Delete.infoLoading) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getLxcSnapshotS3ExportInfo(
          selectedContainer.name, pendingS3Delete.snapshotName, pendingS3Delete.exportId,
        );
        if (cancelled) return;
        setPendingS3Delete((p) => p && p.exportId === pendingS3Delete.exportId
          ? { ...p, info: r, infoLoading: false }
          : p);
      } catch (err) {
        if (cancelled) return;
        setPendingS3Delete((p) => p && p.exportId === pendingS3Delete.exportId
          ? { ...p, info: { error: err?.message || 'inspect failed' }, infoLoading: false }
          : p);
      }
    })();
    return () => { cancelled = true; };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [pendingS3Delete?.exportId]);

  // Download a previously-taken snapshot as a tarball. incus's export
  // accepts <container>/<snapshot>, so the backend just streams that
  // pipe; the UI side reuses the same progress wiring as handleExport.
  const handleDownloadSnapshot = async (snapshotName) => {
    if (!selectedContainer) return;
    setExporting(true);
    const ctName = selectedContainer.name;
    try {
      const loaded = await streamDownload({
        url: `/api/lxc/containers/${ctName}/snapshot/${encodeURIComponent(snapshotName)}/export`,
        filename: `${ctName}-${snapshotName}-backup.tar.gz`,
        fetchEstimate: () => api.getLxcSnapshotExportInfo(ctName, snapshotName),
        label: 'Snapshot download',
        containerName: ctName,
        snapshotName,
      });
      toast({ title: 'Snapshot downloaded', description: `${snapshotName} (${formatSize(loaded)})` });
    } catch (err) {
      if (err?.name === 'AbortError') {
        toast({ title: 'Download cancelled', description: `Snapshot ${snapshotName} cancelled.` });
      } else {
        toast({ title: 'Download failed', description: err.message, variant: 'destructive' });
      }
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  // Import container from backup.
  //
  // Uses XHR (via api.importContainerWithProgress) instead of fetch so
  // the UI can show upload byte progress — fetch's Request body stream
  // doesn't expose upload progress on the wire. Two phases:
  //   - 'uploading'   browser → backend, determinate, % of file size.
  //   - 'processing'  backend ran multer → disk; now streaming temp
  //                   file into `incus import -` and waiting for it to
  //                   finish. Indeterminate; show elapsed time only.
  const handleImport = async () => {
    if (!importName.trim() || !importFile) return;
    setImporting(true);
    const startTime = Date.now();
    setImportProgress({ loaded: 0, total: importFile.size, phase: 'uploading', elapsedMs: 0, throughputBps: null });
    let elapsedTimer = null;
    // 10-second moving window for upload throughput. Same shape as
    // the export streamDownload sampler.
    const samples = [];
    try {
      const startElapsedTimer = () => {
        if (elapsedTimer) return;
        elapsedTimer = setInterval(() => {
          setImportProgress((p) => p ? { ...p, elapsedMs: Date.now() - startTime } : p);
        }, 1000);
      };

      await api.importContainerWithProgress(importName.trim(), importFile, ({ loaded, total, phase }) => {
        const now = Date.now();
        let throughputBps = null;
        if (phase === 'uploading') {
          samples.push({ loaded, t: now });
          while (samples.length > 1 && now - samples[0].t > 10000) samples.shift();
          if (samples.length >= 2) {
            const first = samples[0];
            const last = samples[samples.length - 1];
            const dt = (last.t - first.t) / 1000;
            const dBytes = last.loaded - first.loaded;
            if (dt > 0.25) throughputBps = dBytes / dt;
          }
        }
        setImportProgress({ loaded, total, phase, elapsedMs: now - startTime, throughputBps });
        if (phase === 'processing') startElapsedTimer();
      });
      toast({ title: 'Import complete', description: `Container '${importName}' imported successfully.` });
      setImportOpen(false);
      setImportName('');
      setImportFile(null);
      await fetchContainers();
    } catch (err) {
      toast({ title: 'Import failed', description: err.message, variant: 'destructive' });
    } finally {
      if (elapsedTimer) clearInterval(elapsedTimer);
      setImporting(false);
      setImportProgress(null);
    }
  };

  // Open the cleanup dialog and populate the preview. Default-select
  // every category that has at least one item so the operator's
  // first action is "Clean Up" rather than "click each checkbox" —
  // most operators want everything reclaimed when they bother to
  // open this dialog.
  const openCleanup = async () => {
    setCleanupOpen(true);
    setCleanupPreview(null);
    setCleanupSelected(new Set());
    setCleanupLoading(true);
    try {
      const res = await api.getLxcCleanupPreview();
      setCleanupPreview(res);
      const preselect = new Set((res.categories || []).filter((c) => c.count > 0).map((c) => c.key));
      setCleanupSelected(preselect);
    } catch (err) {
      toast({ title: 'Cleanup preview failed', description: err.message, variant: 'destructive' });
    } finally {
      setCleanupLoading(false);
    }
  };

  const toggleCleanupCategory = (key) => {
    setCleanupSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleRunCleanup = async () => {
    if (cleanupSelected.size === 0) return;
    setCleanupRunning(true);
    try {
      const res = await api.executeLxcCleanup([...cleanupSelected]);
      // Build a single toast description summarizing every category
      // that ran, including a count of any per-item errors so they
      // don't get swallowed when only some items failed.
      const parts = [];
      let totalFreed = 0;
      let totalErrors = 0;
      for (const [key, r] of Object.entries(res.results || {})) {
        if (!r) continue;
        parts.push(`${key}: ${r.removed} removed${r.freedBytes ? ` (${formatSize(r.freedBytes)})` : ''}`);
        totalFreed += r.freedBytes || 0;
        totalErrors += (r.errors || []).length;
      }
      const desc = parts.join(' · ') + (totalErrors ? ` · ${totalErrors} error(s)` : '') + (totalFreed ? ` — ${formatSize(totalFreed)} freed` : '');
      toast({
        title: totalErrors ? 'Cleanup finished with errors' : 'Cleanup complete',
        description: desc || 'Nothing to clean.',
        variant: totalErrors ? 'destructive' : 'default',
      });
      // Refresh the preview so the dialog reflects the post-cleanup
      // state. Operator can run another pass without closing.
      try {
        const fresh = await api.getLxcCleanupPreview();
        setCleanupPreview(fresh);
        setCleanupSelected(new Set());
      } catch {}
    } catch (err) {
      toast({ title: 'Cleanup failed', description: err.message, variant: 'destructive' });
    } finally {
      setCleanupRunning(false);
    }
  };

  // Snapshot creation is async on the backend — POST returns a jobId
  // immediately, then we poll for status. The previous synchronous path
  // SIGTERMed at 5min, which the Postgres LXC consistently outran.
  // While polling we update `snapshotProgress` so the UI can render an
  // elapsed timer and an ETA when one is available.
  const handleCreateSnapshot = async () => {
    if (!selectedContainer || !snapshotName.trim()) return;
    const ctName = selectedContainer.name;
    const sName = snapshotName.trim();
    setSnapshotLoading(true);
    const startedAt = Date.now();
    setSnapshotProgress({
      containerName: ctName,
      snapshotName: sName,
      startedAt,
      elapsedMs: 0,
      estimateMs: null,
      status: 'running',
    });
    try {
      const start = await api.createLxcSnapshot(
        ctName, sName, snapshotNote.trim(),
      );
      const jobId = start?.jobId;
      if (!jobId) {
        // Older backend without async support — treat the response as
        // immediate completion.
        toast({ title: 'Snapshot created', description: `Snapshot "${sName}" created.` });
      } else {
        setSnapshotProgress((p) => p && p.containerName === ctName
          ? { ...p, estimateMs: start.estimateMs ?? null }
          : p);
        // Poll until done/error. 1s cadence is light on the backend
        // (in-memory map lookup) and tight enough for a smooth timer.
        let last;
        while (true) {
          await new Promise((r) => setTimeout(r, 1000));
          last = await api.getLxcSnapshotJob(ctName, jobId).catch(() => null);
          if (!last) continue;
          setSnapshotProgress((p) => p && p.containerName === ctName
            ? { ...p, elapsedMs: last.elapsedMs ?? p.elapsedMs, estimateMs: last.estimateMs ?? p.estimateMs, status: last.status }
            : p);
          if (last.status === 'done' || last.status === 'error') break;
        }
        if (last.status === 'error') {
          throw new Error(last.error || 'Snapshot failed.');
        }
        toast({ title: 'Snapshot created', description: `Snapshot "${sName}" created in ${formatDuration(last.elapsedMs || 0)}.` });
      }
      setSnapshotName('');
      setSnapshotNote('');
      const snapRes = await api.getLxcSnapshots(ctName);
      setSnapshots(snapRes.snapshots || []);
    } catch (err) {
      toast({ title: 'Snapshot failed', description: err.message, variant: 'destructive' });
    } finally {
      setSnapshotLoading(false);
      setSnapshotProgress(null);
    }
  };

  const handleRestoreSnapshot = async (snap) => {
    if (!selectedContainer) return;
    setSnapshotLoading(true);
    try {
      await api.restoreLxcSnapshot(selectedContainer.name, snap);
      toast({ title: 'Snapshot restored', description: `Restored "${snap}" on ${selectedContainer.name}.` });
      // Restore replays the on-disk state to a previous point — that
      // includes the container's IP lease (sometimes stale vs. live),
      // any service-config files inside the LXC, and any process
      // state. Re-pull containers, snapshots, and services so the UI
      // reflects the restored reality instead of the pre-restore one
      // (otherwise the badges/diagnostic stay stuck on whatever was
      // showing before).
      try {
        await fetchContainers();
        const [snapRes, svcRes] = await Promise.all([
          api.getLxcSnapshots(selectedContainer.name).catch(() => ({ snapshots: [] })),
          api.getLxcServices(selectedContainer.name).catch(() => ({ services: [], listening: null })),
        ]);
        setSnapshots(snapRes.snapshots || []);
        setContainerServices(svcRes.services || []);
        setContainerListening(svcRes.listening || null);
      } catch {
        // Best-effort refresh — the restore itself succeeded; if a
        // refresh call fails the operator can hit refresh manually.
      }
    } catch (err) {
      toast({ title: 'Restore failed', description: err.message, variant: 'destructive' });
    } finally {
      setSnapshotLoading(false);
    }
  };

  // Rename the currently-selected container.  Incus requires the
  // container to be stopped; the backend surfaces a 'stop first'
  // hint when the operator forgets, which we relay verbatim.
  const handleRenameContainer = async () => {
    const p = pendingRename;
    if (!p || !selectedContainer) return;
    const trimmed = (p.value || '').trim();
    if (!trimmed || trimmed === selectedContainer.name) {
      setPendingRename(null);
      return;
    }
    setPendingRename({ ...p, busy: true });
    try {
      const r = await api.renameLxcContainer(selectedContainer.name, trimmed);
      toast({ title: 'Container renamed', description: `${selectedContainer.name} → ${r.name}.` });
      setPendingRename(null);
      // Re-fetch container list and re-select the renamed row.
      try { await fetchContainers(); } catch { /* tolerated */ }
      setSelectedContainer((c) => c ? { ...c, name: r.name } : c);
    } catch (err) {
      toast({
        title: 'Rename failed',
        description: err?.hint
          ? `${err.message}  (${err.hint})`
          : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
      setPendingRename({ ...p, busy: false });
    }
  };

  // Transfer every service whose lxc_container_name = the
  // currently-selected container to a different container.
  // After the DB update, regenerate Caddy so the new routes go
  // live (target_ip is cleared by the backend so the regen
  // re-resolves it).
  const handleTransferRoutes = async () => {
    const p = pendingTransfer;
    if (!p || !selectedContainer) return;
    const target = (p.toName || '').trim();
    if (!target || target === selectedContainer.name) return;
    setPendingTransfer({ ...p, busy: true });
    try {
      const r = await api.transferLxcContainerRoutes(selectedContainer.name, target);
      // Regenerate Caddy so the rules pointing at the new
      // container actually take effect.  Best-effort: a regen
      // failure surfaces in its own toast but doesn't undo the
      // DB transfer.
      try {
        await api.regenerateAllConfigs();
      } catch (regenErr) {
        toast({
          title: 'Caddy regen failed',
          description: regenErr?.message || 'Routes moved but Caddy did not reload — click Regenerate Caddy manually.',
          variant: 'destructive',
        });
      }
      toast({
        title: 'Routes transferred',
        description: r.transferred === 0
          ? `${selectedContainer.name} had no routes to move.`
          : `Moved ${r.transferred} route${r.transferred === 1 ? '' : 's'} from ${selectedContainer.name} to ${target}.`,
      });
      setPendingTransfer(null);
    } catch (err) {
      toast({
        title: 'Transfer failed',
        description: err?.message || 'unknown error',
        variant: 'destructive',
      });
      setPendingTransfer({ ...p, busy: false });
    }
  };

  const handleDeleteSnapshot = async (snap) => {
    if (!selectedContainer) return;
    setSnapshotLoading(true);
    try {
      await api.deleteLxcSnapshot(selectedContainer.name, snap);
      toast({ title: 'Snapshot deleted', description: `Removed "${snap}" from every location.` });
      const snapRes = await api.getLxcSnapshots(selectedContainer.name);
      setSnapshots(snapRes.snapshots || []);
      await refreshSnapshotExports();
    } catch (err) {
      toast({ title: 'Delete failed', description: err.message, variant: 'destructive' });
      // The snapshot may still be partially deleted; refresh so
      // the UI reflects whatever did succeed (e.g. local gone but
      // an S3 destination errored).
      try {
        const snapRes = await api.getLxcSnapshots(selectedContainer.name);
        setSnapshots(snapRes.snapshots || []);
        await refreshSnapshotExports();
      } catch { /* tolerated */ }
    } finally {
      setSnapshotLoading(false);
    }
  };

  // Drop the local Incus copy only — every S3 copy stays.  Used
  // when an operator wants to reclaim pool space but keep the
  // off-host backups.  Opens a confirm dialog; the real delete
  // fires from confirmLocalDeleteFromDialog.
  const handleDeleteSnapshotLocal = (snap) => {
    if (!selectedContainer) return;
    setPendingLocalDelete({ snapshotName: snap, busy: false });
  };

  const confirmLocalDeleteFromDialog = async () => {
    const p = pendingLocalDelete;
    if (!p || !selectedContainer) return;
    setPendingLocalDelete({ ...p, busy: true });
    setSnapshotLoading(true);
    try {
      await api.deleteLxcSnapshotLocal(selectedContainer.name, p.snapshotName);
      toast({ title: 'Local copy removed', description: `${p.snapshotName} dropped from the host's pool.` });
      const snapRes = await api.getLxcSnapshots(selectedContainer.name);
      setSnapshots(snapRes.snapshots || []);
      setPendingLocalDelete(null);
    } catch (err) {
      toast({ title: 'Local delete failed', description: err?.message || 'unknown error', variant: 'destructive' });
      setPendingLocalDelete({ ...p, busy: false });
    } finally {
      setSnapshotLoading(false);
    }
  };

  // Re-import a previously-exported S3 copy into the local Incus
  // pool as a snapshot of the same name.  Backend rejects with 409
  // if a local snapshot of that name already exists; the operator
  // is expected to drop the local copy first.  Opens a confirm
  // dialog and tracks per-phase progress (download / import /
  // copy-as-snapshot / cleanup) once the request fires.
  const handlePullFromS3 = (snap, exportRow) => {
    if (!selectedContainer) return;
    setPendingPullFromS3({ snapshotName: snap, exportRow, busy: false, progress: null });
  };

  const confirmPullFromS3FromDialog = async () => {
    const p = pendingPullFromS3;
    if (!p || !selectedContainer) return;
    const destName = p.exportRow.destination_name || 'destination';
    setPendingPullFromS3({ ...p, busy: true, progress: { phase: 'starting', label: 'Starting…' } });
    setSnapshotLoading(true);
    try {
      // Drive a side-channel poll of the import progress while the
      // long-running request is in flight.  The backend writes
      // {phase, bytes_loaded, bytes_total} to a small in-memory map
      // keyed by export id; if that endpoint isn't present we just
      // show a spinner.
      const exportId = p.exportRow.id || p.exportRow.export_id;
      let pollId;
      const poll = async () => {
        try {
          const r = await api.getLxcSnapshotS3ImportProgress(
            selectedContainer.name, p.snapshotName, exportId,
          );
          if (r && r.phase) {
            setPendingPullFromS3((cur) => cur && cur.exportRow && (cur.exportRow.id || cur.exportRow.export_id) === exportId
              ? { ...cur, progress: r }
              : cur);
          }
        } catch { /* tolerated */ }
      };
      pollId = setInterval(poll, 1000);
      try {
        const r = await api.restoreLxcSnapshotFromS3(selectedContainer.name, p.snapshotName, exportId);
        const restoredAs = r?.restored_as || 'restored container';
        toast({
          title: 'Container restored from S3',
          description: r?.snapshot_created
            ? `Created ${restoredAs} with snapshot ${p.snapshotName} preserved.`
            : `Created ${restoredAs}.  Snapshot creation on the new container failed; see backend logs.`,
        });
        setPendingPullFromS3(null);
        // Refresh both snapshot list (in case anything changed)
        // AND the container list (the new restored container
        // should now appear).
        try { await fetchContainers(); } catch { /* tolerated */ }
        const snapRes = await api.getLxcSnapshots(selectedContainer.name);
        setSnapshots(snapRes.snapshots || []);
      } finally {
        if (pollId) clearInterval(pollId);
      }
    } catch (err) {
      toast({
        title: 'Pull from S3 failed',
        description: err?.message || 'unknown error',
        variant: 'destructive',
      });
      setPendingPullFromS3({ ...p, busy: false, progress: null });
    } finally {
      setSnapshotLoading(false);
    }
  };

  const fetchSnapshotNotes = async (snapName) => {
    if (!selectedContainer) return;
    try {
      const res = await api.getSnapshotNotes(selectedContainer.name, snapName);
      setSnapshotNotes(prev => ({ ...prev, [snapName]: res.notes || [] }));
    } catch {}
  };

  const handleAddNote = async (snapName) => {
    if (!selectedContainer || !newNoteText.trim()) return;
    try {
      await api.addSnapshotNote(selectedContainer.name, snapName, newNoteText.trim());
      setNewNoteText('');
      fetchSnapshotNotes(snapName);
    } catch (err) {
      toast({ title: 'Failed to add note', description: err.message, variant: 'destructive' });
    }
  };

  const handleDeleteNote = async (snapName, noteId) => {
    if (!selectedContainer) return;
    try {
      await api.deleteSnapshotNote(selectedContainer.name, snapName, noteId);
      fetchSnapshotNotes(snapName);
    } catch (err) {
      toast({ title: 'Failed to delete note', description: err.message, variant: 'destructive' });
    }
  };

  const toggleSnapshotExpand = (snapName) => {
    if (expandedSnapshot === snapName) {
      setExpandedSnapshot(null);
      setNewNoteText('');
    } else {
      setExpandedSnapshot(snapName);
      setNewNoteText('');
      fetchSnapshotNotes(snapName);
    }
  };

  // Incus not available
  if (incusAvailable === false) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="p-4 bg-orange-500/10 rounded-full">
          <AlertCircle className="h-10 w-10 text-orange-500" />
        </div>
        <div className="text-center space-y-2">
          <h2 className="text-xl font-semibold">Incus Not Available</h2>
          <p className="text-muted-foreground max-w-md">
            Incus is not installed on this server. Install it to manage LXC containers.
          </p>
          <a
            href="https://linuxcontainers.org/incus/docs/main/installing/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 hover:text-blue-400 text-sm underline"
          >
            View installation documentation
          </a>
        </div>
      </div>
    );
  }

  // Loading state
  if (incusAvailable === null || loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 bg-cyan-500/10 rounded-lg shrink-0">
            <Box className="h-6 w-6 text-cyan-500" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold truncate">Incus Instances</h1>
            <p className="text-sm text-muted-foreground">
              {(() => {
                const ctN = containers.filter((c) => (c.type || 'container') === 'container').length;
                const vmN = containers.filter((c) => c.type === 'virtual-machine').length;
                const parts = [];
                if (ctN) parts.push(`${ctN} CT`);
                if (vmN) parts.push(`${vmN} VM`);
                if (parts.length === 0) parts.push('0 instances');
                return parts.join(' \u2022 ');
              })()}
              {incusVersion && ` \u2022 Incus ${incusVersion}`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={fetchContainers}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={openCleanup}>
            <Sparkles className="h-4 w-4 mr-2" />
            Cleanup
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4 mr-2" />
            Import
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Create Instance
          </Button>
        </div>
      </div>

      {/* Type filter chips */}
      {containers.length > 0 && (
        <div className="flex items-center gap-2 text-sm">
          {[
            { id: 'all', label: 'All' },
            { id: 'container', label: 'Containers' },
            { id: 'virtual-machine', label: 'VMs' },
          ].map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => setTypeFilter(chip.id)}
              className={`px-3 py-1 rounded-full border transition-colors ${
                typeFilter === chip.id
                  ? 'bg-cyan-500/20 border-cyan-500/60 text-cyan-300'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {/* Init Warning */}
      {incusInitWarning && (
        <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-yellow-500">Incus not fully initialized</p>
            <p className="text-xs text-muted-foreground mt-1">{incusInitWarning}</p>
          </div>
        </div>
      )}

      {/* Instance Grid */}
      {containers.length === 0 ? (
        <Card className="p-12">
          <div className="flex flex-col items-center justify-center gap-3 text-center">
            <Server className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium">No instances yet</p>
              <p className="text-sm text-muted-foreground">Create your first Incus instance or import a backup to get started.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <Upload className="h-4 w-4 mr-2" />
                Import Backup
              </Button>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Instance
              </Button>
            </div>
          </div>
        </Card>
      ) : (() => {
        const filtered = typeFilter === 'all'
          ? containers
          : containers.filter((c) => (c.type || 'container') === typeFilter);
        if (filtered.length === 0) {
          return (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              No {typeFilter === 'virtual-machine' ? 'VMs' : 'containers'} match this filter.
            </Card>
          );
        }
        return (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((ct) => (
            <Card
              key={ct.name}
              className="border-dashed border-cyan-500/30 cursor-pointer hover:border-cyan-500/60 transition-colors"
              onClick={() => openInfo(ct)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusBadge status={ct.status} />
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wide ${
                        ct.type === 'virtual-machine'
                          ? 'bg-purple-500/15 text-purple-400 border border-purple-500/40'
                          : 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/40'
                      }`}
                      title={ct.type === 'virtual-machine' ? 'Virtual machine' : 'Container'}
                    >
                      {ct.type === 'virtual-machine' ? 'VM' : 'CT'}
                    </span>
                    <CardTitle className="text-lg truncate">{ct.name}</CardTitle>
                  </div>
                  <div className="flex gap-1 flex-wrap justify-end" onClick={(e) => e.stopPropagation()}>
                    {ct.status?.toLowerCase() === 'running' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 w-9 sm:h-7 sm:w-7 p-0 text-cyan-500 hover:text-cyan-600"
                        onClick={() => openInfo(ct, 'terminal')}
                        title="Terminal"
                      >
                        <Terminal className="h-4 w-4" />
                      </Button>
                    )}
                    {ct.status?.toLowerCase() === 'running' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 w-9 sm:h-7 sm:w-7 p-0 text-yellow-500 hover:text-yellow-600"
                        onClick={() => handleAction('stop', ct.name)}
                        disabled={actionLoading[`${ct.name}-stop`]}
                        title="Stop"
                      >
                        {actionLoading[`${ct.name}-stop`] ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 w-9 sm:h-7 sm:w-7 p-0 text-green-500 hover:text-green-600"
                        onClick={() => handleAction('start', ct.name)}
                        disabled={actionLoading[`${ct.name}-start`]}
                        title="Start"
                      >
                        {actionLoading[`${ct.name}-start`] ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-9 w-9 sm:h-7 sm:w-7 p-0 text-blue-500 hover:text-blue-600"
                      onClick={() => handleAction('restart', ct.name)}
                      disabled={actionLoading[`${ct.name}-restart`]}
                      title="Restart"
                    >
                      {actionLoading[`${ct.name}-restart`] ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </Button>
                    {ct.type === 'virtual-machine' && ct.status === 'running' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 w-9 sm:h-7 sm:w-7 p-0 text-cyan-500 hover:text-cyan-600"
                        onClick={() => handleAction('reboot', ct.name)}
                        disabled={actionLoading[`${ct.name}-reboot`]}
                        title="Reboot (graceful, ACPI shutdown)"
                      >
                        {actionLoading[`${ct.name}-reboot`] ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RotateCw className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-9 w-9 sm:h-7 sm:w-7 p-0 text-red-500 hover:text-red-600"
                      onClick={() => { setDeleteTarget(ct.name); setDeleteOpen(true); }}
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <CardDescription>
                  {ct.image || 'Unknown image'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-xs text-muted-foreground space-y-1">
                  {ct.ipv4 && (
                    <div className="flex items-center gap-1.5">
                      <Globe className="h-3 w-3" />
                      <span className="font-mono">{ct.ipv4}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    {ct.config?.cpu && (
                      <span className="flex items-center gap-1">
                        <Cpu className="h-3 w-3" />
                        {ct.config.cpu} CPU
                      </span>
                    )}
                    {ct.config?.memory && (
                      <span className="flex items-center gap-1">
                        <MemoryStick className="h-3 w-3" />
                        {ct.config.memory}
                      </span>
                    )}
                  </div>
                  {ct.created && (
                    <div className="text-muted-foreground/70">
                      Created {formatDate(ct.created)}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        );
      })()}

      {/* Create Instance Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!creating) setCreateOpen(open); }}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg" onInteractOutside={(e) => { if (creating) e.preventDefault(); }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-cyan-500" />
              Create LXC Container
            </DialogTitle>
            <DialogDescription>
              Launch a new system container with Incus.
            </DialogDescription>
          </DialogHeader>

          {/* Progress View (shown during creation) */}
          {creating && createProgress ? (
            <div className="py-4 space-y-4">
              <div className="text-sm font-medium text-center mb-4">
                Creating <span className="text-cyan-500">{createForm.name}</span>
              </div>
              {[
                { key: 'downloading', icon: Download, label: 'Downloading image' },
                { key: 'configuring', icon: Settings, label: 'Configuring container' },
                { key: 'network', icon: Wifi, label: 'Waiting for network' },
                ...(createForm.initScript ? [{ key: 'init-script', icon: Terminal, label: 'Running init script' }] : []),
                ...(createForm.services.some((s) => s.domain.trim()) ? [{ key: 'caddy', icon: Globe, label: 'Setting up reverse proxy' }] : []),
                { key: 'ready', icon: Check, label: 'Ready' },
              ].map((step, idx, arr) => {
                const phaseOrder = ['starting', 'downloading', 'configuring', 'network', 'init-script', 'caddy', 'ready'];
                const currentIdx = phaseOrder.indexOf(createProgress.phase);
                const stepIdx = phaseOrder.indexOf(step.key);
                const isActive = step.key === createProgress.phase;
                const isDone = stepIdx < currentIdx;
                const isFailed = createProgress.phase === 'failed' && isActive;
                const Icon = step.icon;

                return (
                  <div key={step.key} className="flex items-center gap-3">
                    <div className={`flex items-center justify-center w-8 h-8 rounded-full border-2 shrink-0 ${
                      isDone ? 'bg-green-500/20 border-green-500 text-green-500' :
                      isActive ? 'border-cyan-500 text-cyan-500' :
                      isFailed ? 'border-red-500 text-red-500' :
                      'border-muted-foreground/30 text-muted-foreground/30'
                    }`}>
                      {isDone ? (
                        <Check className="h-4 w-4" />
                      ) : isActive ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Icon className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex-1">
                      <p className={`text-sm ${
                        isDone ? 'text-green-500' :
                        isActive ? 'text-foreground font-medium' :
                        'text-muted-foreground/50'
                      }`}>
                        {step.label}
                      </p>
                    </div>
                    {isActive && createProgress.elapsed > 0 && (
                      <span className="text-xs text-muted-foreground">{createProgress.elapsed}s</span>
                    )}
                  </div>
                );
              })}
              {createProgress.phase === 'failed' && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg mt-2">
                  <p className="text-xs text-red-500">{createProgress.error}</p>
                </div>
              )}
            </div>
          ) : (
            /* Form View (shown before creation starts) */
            <>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label>Type *</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: 'container', label: 'Container', hint: 'Lightweight, shares host kernel' },
                      { id: 'virtual-machine', label: 'Virtual machine', hint: 'Full VM with its own kernel' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setCreateForm((f) => ({ ...f, type: opt.id }))}
                        className={`text-left p-3 rounded border transition-colors ${
                          createForm.type === opt.id
                            ? 'border-cyan-500 bg-cyan-500/10 text-foreground'
                            : 'border-border text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        <div className="font-medium text-sm">{opt.label}</div>
                        <div className="text-xs mt-0.5">{opt.hint}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ct-name">Name *</Label>
                  <Input
                    id="ct-name"
                    placeholder={createForm.type === 'virtual-machine' ? 'my-vm' : 'my-container'}
                    value={createForm.name}
                    onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Image *</Label>
                  {(() => {
                    // Build the dropdown options. When the live catalog
                    // loaded, filter by createForm.type using the
                    // backend-annotated supports[] array and sort by
                    // os/release. When the fetch failed, fall back to
                    // PRESET_IMAGES — the operator stays unblocked
                    // during a degraded incus-list condition. Flat
                    // sorted list (not grouped sections) by design;
                    // grouping was deemed out-of-scope for this pass.
                    const liveAvailable = Array.isArray(imageCatalog) && imageCatalog.length > 0;
                    let liveOptions = [];
                    if (liveAvailable) {
                      liveOptions = imageCatalog
                        .filter((img) => Array.isArray(img.supports) && img.supports.includes(createForm.type))
                        .map((img) => {
                          const alias = Array.isArray(img.aliases) && img.aliases[0]?.name;
                          const fp = (img.fingerprint || '').slice(0, 12);
                          const value = alias || img.fingerprint || '';
                          const os = img.properties?.os || '';
                          const release = img.properties?.release || '';
                          const desc = img.properties?.description;
                          const label = desc || alias || fp;
                          return { value, label, os, release, alias, fp };
                        })
                        .filter((o) => o.value)
                        .sort((a, b) => {
                          const oa = (a.os || '~').toLowerCase();
                          const ob = (b.os || '~').toLowerCase();
                          if (oa !== ob) return oa.localeCompare(ob);
                          return String(a.release).localeCompare(String(b.release), undefined, { numeric: true });
                        });
                    }
                    const showFallback = !imageCatalogLoading && (imageCatalogError || !liveAvailable);
                    return (
                      <>
                        <Select
                          value={imageSelection}
                          onValueChange={(val) => {
                            setImageSelection(val);
                            if (val !== '__custom__') {
                              setCreateForm((f) => ({ ...f, image: val }));
                            } else {
                              setCreateForm((f) => ({ ...f, image: '' }));
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={imageCatalogLoading ? 'Loading images...' : 'Select an image...'} />
                          </SelectTrigger>
                          <SelectContent>
                            {imageCatalogLoading && (
                              <div className="px-2 py-3 text-xs text-muted-foreground flex items-center gap-2">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Loading image catalog...
                              </div>
                            )}
                            {!imageCatalogLoading && liveOptions.length > 0 && liveOptions.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                <div className="flex flex-col">
                                  <span>{opt.label}</span>
                                  {opt.alias && opt.alias !== opt.label && (
                                    <span className="text-xs text-muted-foreground">{opt.alias}</span>
                                  )}
                                </div>
                              </SelectItem>
                            ))}
                            {!imageCatalogLoading && liveAvailable && liveOptions.length === 0 && (
                              <div className="px-2 py-3 text-xs text-muted-foreground">
                                No cached {createForm.type === 'virtual-machine' ? 'VM' : 'container'} images. Use Custom image below to pull one.
                              </div>
                            )}
                            {showFallback && PRESET_IMAGES.map((img) => (
                              <SelectItem key={img.value} value={img.value}>
                                {img.label}
                              </SelectItem>
                            ))}
                            <SelectItem value="__custom__">Custom image...</SelectItem>
                          </SelectContent>
                        </Select>
                        {imageCatalogError && (
                          <p className="text-xs text-amber-500">
                            Couldn't load cached image list ({imageCatalogError}). Showing built-in presets.
                          </p>
                        )}
                      </>
                    );
                  })()}
                  {imageSelection === '__custom__' && (
                    <Input
                      placeholder="images:ubuntu/24.04 or ubuntu:24.04"
                      value={createForm.image}
                      onChange={(e) => setCreateForm((f) => ({ ...f, image: e.target.value }))}
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    Cached images appear automatically. For something not yet pulled, use{' '}
                    <span className="font-mono text-foreground/80">Custom image...</span> with an{' '}
                    <a href="https://images.linuxcontainers.org" target="_blank" rel="noopener noreferrer" className="text-cyan-500 hover:underline">
                      images:
                    </a>{' '}
                    reference like <span className="font-mono text-foreground/80">images:ubuntu/24.04</span>.
                  </p>
                </div>
                {/* Services / Port Mappings */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Services</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-cyan-500 hover:text-cyan-400"
                      onClick={() => setCreateForm((f) => ({
                        ...f,
                        services: [...f.services, { domain: '', port: '', obtainCert: true, healthPath: '' }],
                      }))}
                    >
                      <Plus className="h-3 w-3 mr-1" />Add Service
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {createForm.services.map((svc, idx) => (
                      <div key={idx} className="flex items-start gap-2 p-2.5 rounded-lg border border-border/50 bg-muted/30">
                        <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <Input
                            placeholder="myapp.example.com"
                            value={svc.domain}
                            onChange={(e) => setCreateForm((f) => {
                              const services = [...f.services];
                              services[idx] = { ...services[idx], domain: e.target.value };
                              return { ...f, services };
                            })}
                            className="h-8 text-xs"
                          />
                          <Input
                            type="number"
                            placeholder="8080"
                            value={svc.port}
                            onChange={(e) => setCreateForm((f) => {
                              const services = [...f.services];
                              services[idx] = { ...services[idx], port: e.target.value };
                              return { ...f, services };
                            })}
                            className="h-8 text-xs"
                          />
                          <Input
                            placeholder="/healthz (optional)"
                            value={svc.healthPath || ''}
                            onChange={(e) => setCreateForm((f) => {
                              const services = [...f.services];
                              services[idx] = { ...services[idx], healthPath: e.target.value };
                              return { ...f, services };
                            })}
                            className="h-8 text-xs font-mono"
                            title="Optional HTTP HEAD probe path. Leave blank to keep TCP-only health checks."
                          />
                        </div>
                        <div className="flex items-center gap-1.5 pt-1">
                          <Switch
                            checked={svc.obtainCert}
                            onCheckedChange={(checked) => setCreateForm((f) => {
                              const services = [...f.services];
                              services[idx] = { ...services[idx], obtainCert: checked };
                              return { ...f, services };
                            })}
                            className="scale-75"
                          />
                          <Shield className={`h-3.5 w-3.5 ${svc.obtainCert ? 'text-green-500' : 'text-muted-foreground/40'}`} />
                        </div>
                        {createForm.services.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-muted-foreground hover:text-red-500 mt-0.5"
                            onClick={() => setCreateForm((f) => ({
                              ...f,
                              services: f.services.filter((_, i) => i !== idx),
                            }))}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span>Domain + Port per service</span>
                    <span className="flex items-center gap-1"><Shield className="h-3 w-3" /> = obtain TLS cert</span>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="ct-cpu">CPU Limit</Label>
                    <Input
                      id="ct-cpu"
                      type="number"
                      placeholder="2"
                      value={createForm.cpu}
                      onChange={(e) => setCreateForm((f) => ({ ...f, cpu: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ct-memory">Memory (MB)</Label>
                    <Input
                      id="ct-memory"
                      type="number"
                      placeholder={createForm.type === 'virtual-machine' ? '2048 (default)' : '2048'}
                      value={createForm.memory}
                      onChange={(e) => setCreateForm((f) => ({ ...f, memory: e.target.value }))}
                    />
                    {createForm.type === 'virtual-machine' && (
                      <p className="text-xs text-muted-foreground">
                        VMs require a memory cap. Defaults to 2048 MB if left blank;
                        root disk defaults to 20 GiB.
                      </p>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Init Template</Label>
                  <Select
                    value={templateSelection}
                    onValueChange={(val) => {
                      setTemplateSelection(val);
                      if (val === '__custom__') {
                        setCreateForm((f) => ({ ...f, initScript: '', dockerSupport: false, dockerPrivileged: false }));
                      } else if (val === '' || val === 'none') {
                        setCreateForm((f) => ({ ...f, initScript: '', dockerSupport: false, dockerPrivileged: false }));
                      } else {
                        const tpl = INIT_TEMPLATES.find((t) => t.value === val);
                        if (tpl) setCreateForm((f) => ({
                          ...f,
                          initScript: tpl.script,
                          dockerSupport: !!tpl.dockerSupport,
                          dockerPrivileged: false,
                        }));
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="None (bare image)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None (bare image)</SelectItem>
                      {INIT_TEMPLATES.map((tpl) => (
                        <SelectItem key={tpl.value} value={tpl.value}>{tpl.label}</SelectItem>
                      ))}
                      <SelectItem value="__custom__">Custom script...</SelectItem>
                    </SelectContent>
                  </Select>
                  {(templateSelection === '__custom__' || (templateSelection && templateSelection !== 'none' && createForm.initScript)) && (
                    <textarea
                      value={createForm.initScript}
                      onChange={(e) => {
                        setCreateForm((f) => ({ ...f, initScript: e.target.value }));
                        setTemplateSelection('__custom__');
                      }}
                      placeholder="#!/bin/sh&#10;apt-get update && apt-get install -y ..."
                      rows={4}
                      className="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono resize-y min-h-[80px]"
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    Runs automatically after container is created and has network. Takes up to 5 minutes.
                  </p>
                  {createForm.type !== 'virtual-machine' && (
                    <>
                      <label className="flex items-start gap-2 pt-1 cursor-pointer">
                        <input
                          type="checkbox"
                          className="mt-0.5 cursor-pointer"
                          checked={createForm.dockerSupport}
                          onChange={(e) => setCreateForm((f) => ({
                            ...f,
                            dockerSupport: e.target.checked,
                            dockerPrivileged: e.target.checked ? f.dockerPrivileged : false,
                          }))}
                        />
                        <span className="text-xs text-muted-foreground">
                          <span className="text-foreground">Enable Docker support</span> — adds <code className="font-mono">security.nesting=true</code> + the mknod / setxattr / bpf / bpf.devices syscall intercepts so dockerd + BuildKit can mount overlayfs and run native-postinstall packages (bcrypt, sharp, node-pty, etc.). Auto-enabled by the Docker-in-LXC template.
                        </span>
                      </label>
                      {createForm.dockerSupport && (
                        <label className="flex items-start gap-2 pl-6 pt-1 cursor-pointer">
                          <input
                            type="checkbox"
                            className="mt-0.5 cursor-pointer"
                            checked={createForm.dockerPrivileged}
                            onChange={(e) => setCreateForm((f) => ({ ...f, dockerPrivileged: e.target.checked }))}
                          />
                          <span className="text-xs text-muted-foreground">
                            <span className="text-yellow-500">Privileged Docker (advanced)</span> — sets <code className="font-mono">security.privileged=true</code> <span className="text-foreground">and</span> <code className="font-mono">raw.lxc=lxc.apparmor.profile=unconfined</code>. Required for Docker images that touch sysctls during init (n8n, most node:N-alpine bases — the "open sysctl … reopen fd N: permission denied" runc error) and BuildKit syscalls like <code className="font-mono">spawn sh</code> with bcrypt-style native postinstalls. The container runs at host-root capability with no AppArmor profile — only enable on hosts where you trust everything inside this LXC.
                          </span>
                        </label>
                      )}
                    </>
                  )}
                  {createForm.type === 'virtual-machine' && (
                    <p className="text-xs text-muted-foreground pt-1">
                      Docker-in-LXC syscall intercepts don't apply to virtual machines.
                      Run Docker inside the VM the normal way after install.
                    </p>
                  )}
                </div>
                {createForm.services.some((s) => s.domain.trim()) && (
                  <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                    <p className="text-xs text-green-500">
                      Caddy will configure reverse proxy routing for {createForm.services.filter((s) => s.domain.trim()).length} service{createForm.services.filter((s) => s.domain.trim()).length > 1 ? 's' : ''}.
                      {createForm.services.some((s) => s.domain.trim() && s.obtainCert) && ' TLS certificates will be provisioned for domains with SSL enabled.'}
                    </p>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={!createForm.name || !createForm.image}>
                  <Plus className="h-4 w-4 mr-2" />Create
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Container Info Dialog with Tabs */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:w-[95vw] sm:max-w-[95vw] sm:h-[90vh] sm:max-h-[90vh] sm:rounded-lg overflow-hidden flex flex-col p-4 gap-2">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Info className="h-5 w-5 text-cyan-500" />
              <span className="truncate">{selectedContainer?.name}</span>
              {selectedContainer && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs ml-2 text-muted-foreground hover:text-foreground"
                    onClick={() => setPendingRename({ value: selectedContainer.name, busy: false })}
                    title="Rename container (must be stopped)"
                  >
                    <Pencil className="h-3 w-3 mr-1" />
                    Rename
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setPendingTransfer({
                      fromName: selectedContainer.name, toName: '', busy: false,
                    })}
                    title="Move all HTTP routes from this container to another"
                  >
                    <MoveRight className="h-3 w-3 mr-1" />
                    Transfer routes
                  </Button>
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              Container details and management
            </DialogDescription>
          </DialogHeader>
          {selectedContainer && (
            <Tabs value={infoDefaultTab} onValueChange={setInfoDefaultTab} className="w-full flex-1 flex flex-col min-h-0 overflow-hidden">
              {/* Four triggers: two rows on a phone, one from sm up
                  (MOBILE_FIRST rule 7 — never squash a label to 60px). */}
              <TabsList className="w-full grid grid-cols-2 sm:grid-cols-4 shrink-0 h-auto">
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="terminal">Terminal</TabsTrigger>
                <TabsTrigger value="files">Files</TabsTrigger>
                <TabsTrigger value="delegated">Sharing</TabsTrigger>
              </TabsList>

              {/* Details Tab */}
              <TabsContent value="details" className="space-y-4 flex-1 overflow-y-auto min-h-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">Status</span>
                    <div className="mt-0.5"><StatusBadge status={selectedContainer.status} /></div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Image</span>
                    <div className="mt-0.5 font-mono text-xs">{selectedContainer.image || '-'}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">IP Address</span>
                    <div className="mt-0.5 font-mono text-xs">{selectedContainer.ipv4 || '-'}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Created</span>
                    <div className="mt-0.5 text-xs">{formatDate(selectedContainer.created)}</div>
                  </div>
                </div>

                {/* Resource Limits */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-medium">Resource Limits</h4>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        setResizeForm({
                          cpu: selectedContainer.config?.cpu || '',
                          memory: selectedContainer.config?.memory?.replace(/[^0-9]/g, '') || '',
                        });
                        setResizeOpen(true);
                      }}
                    >
                      Resize
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Card className="p-3">
                      <div className="flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-blue-500" />
                        <div>
                          <div className="text-sm font-medium">{selectedContainer.config?.cpu || 'Unlimited'}</div>
                          <div className="text-xs text-muted-foreground">CPU Cores</div>
                        </div>
                      </div>
                    </Card>
                    <Card className="p-3">
                      <div className="flex items-center gap-2">
                        <MemoryStick className="h-4 w-4 text-green-500" />
                        <div>
                          <div className="text-sm font-medium">{selectedContainer.config?.memory || 'Unlimited'}</div>
                          <div className="text-xs text-muted-foreground">Memory</div>
                        </div>
                      </div>
                    </Card>
                  </div>
                </div>

                {/* Live Resource Usage */}
                {containerState && (
                  <div>
                    <h4 className="text-sm font-medium mb-2">Live Usage</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {containerState.cpu?.usage !== undefined && (
                        <Card className="p-3">
                          <div className="flex items-center gap-2">
                            <Cpu className="h-4 w-4 text-blue-400" />
                            <div>
                              <div className="text-sm font-medium">{(containerState.cpu.usage / 1e9).toFixed(2)}s</div>
                              <div className="text-xs text-muted-foreground">CPU Time</div>
                            </div>
                          </div>
                        </Card>
                      )}
                      {containerState.memory?.usage !== undefined && (
                        <Card className="p-3">
                          <div className="flex items-center gap-2">
                            <MemoryStick className="h-4 w-4 text-green-400" />
                            <div>
                              <div className="text-sm font-medium">{(containerState.memory.usage / 1024 / 1024).toFixed(0)} MB</div>
                              <div className="text-xs text-muted-foreground">Memory Used</div>
                            </div>
                          </div>
                        </Card>
                      )}
                      {containerState.disk?.root?.usage !== undefined && (
                        <Card className="p-3">
                          <div className="flex items-center gap-2">
                            <HardDrive className="h-4 w-4 text-orange-400" />
                            <div>
                              <div className="text-sm font-medium">{(containerState.disk.root.usage / 1024 / 1024).toFixed(0)} MB</div>
                              <div className="text-xs text-muted-foreground">Disk Used</div>
                            </div>
                          </div>
                        </Card>
                      )}
                    </div>
                  </div>
                )}

                {/* Services / Reverse Proxy */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-medium flex items-center gap-2">
                      <Globe className="h-4 w-4" />
                      Services
                    </h4>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => fetchContainerServices(selectedContainer.name)}
                      disabled={servicesLoading}
                    >
                      {servicesLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    </Button>
                  </div>

                  {/* Current services list */}
                  {containerServices.length > 0 ? (
                    <div className="space-y-1.5 mb-3">
                      {containerServices.map((svc) => (
                        <div
                          key={svc.id || `${svc.source || 'file'}-${svc.domain}-${svc.pathPrefix || '/'}`}
                          className="rounded-lg border border-border/50 bg-muted/30 text-xs overflow-hidden"
                        >
                          <div className="flex items-center gap-2 p-2">
                          {editingService === (svc.id || `${svc.domain}|${svc.pathPrefix || '/'}`) ? (
                            <div className="flex-1 flex flex-col gap-2">
                              {/* Phase 2c: routes-table rows get a 4-col grid
                                  with a path field; legacy file rows stay
                                  3-col (no path concept). */}
                              <div className="flex items-center gap-2">
                                <div className={`flex-1 grid ${svc.source === 'db' ? 'grid-cols-4' : 'grid-cols-3'} gap-1.5`}>
                                  <Input
                                    value={editServiceForm.domain}
                                    onChange={(e) => setEditServiceForm((f) => ({ ...f, domain: e.target.value }))}
                                    className="h-7 text-xs"
                                    placeholder="domain"
                                  />
                                  {svc.source === 'db' && (
                                    <Input
                                      value={editServiceForm.pathPrefix || '/'}
                                      onChange={(e) => setEditServiceForm((f) => ({ ...f, pathPrefix: e.target.value }))}
                                      className="h-7 text-xs font-mono"
                                      placeholder="/ (or /api)"
                                      title="Route only this path on the domain."
                                    />
                                  )}
                                  <Input
                                    type="number"
                                    value={editServiceForm.port}
                                    onChange={(e) => setEditServiceForm((f) => ({ ...f, port: e.target.value }))}
                                    className="h-7 text-xs"
                                    placeholder="port"
                                  />
                                  <Input
                                    value={editServiceForm.healthPath || ''}
                                    onChange={(e) => setEditServiceForm((f) => ({ ...f, healthPath: e.target.value }))}
                                    className="h-7 text-xs font-mono"
                                    placeholder="/healthz"
                                    title="Optional HTTP HEAD probe path. Leave blank to keep TCP-only health checks."
                                  />
                                </div>
                                <div className="flex items-center gap-1">
                                  <Switch
                                    checked={editServiceForm.obtainCert}
                                    onCheckedChange={(checked) => setEditServiceForm((f) => ({ ...f, obtainCert: checked }))}
                                    className="scale-[0.65]"
                                  />
                                  <Shield className={`h-3 w-3 ${editServiceForm.obtainCert ? 'text-green-500' : 'text-muted-foreground/40'}`} />
                                </div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-1.5 text-green-500 hover:text-green-400"
                                  onClick={() => handleUpdateService(svc)}
                                >
                                  <Check className="h-3 w-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-1.5 text-muted-foreground"
                                  onClick={() => setEditingService(null)}
                                >
                                  <X className="h-3 w-3" />
                                </Button>
                              </div>
                              {/* Phase 2c: strip/WS toggles. Hidden for
                                  legacy file rows (those flags don't round-
                                  trip through the file pipeline) and for
                                  root paths (where strip is a no-op). */}
                              {svc.source === 'db' && editServiceForm.pathPrefix && editServiceForm.pathPrefix !== '/' && (
                                <div className="flex items-center gap-4 px-1 text-[11px] text-muted-foreground">
                                  <label className="flex items-center gap-1.5 cursor-pointer">
                                    <Switch
                                      checked={!!editServiceForm.stripPrefix}
                                      onCheckedChange={(checked) => setEditServiceForm((f) => ({ ...f, stripPrefix: checked }))}
                                      className="scale-[0.65]"
                                    />
                                    <span>strip prefix</span>
                                  </label>
                                  <label className="flex items-center gap-1.5 cursor-pointer">
                                    <Switch
                                      checked={!!editServiceForm.websocketEnabled}
                                      onCheckedChange={(checked) => setEditServiceForm((f) => ({ ...f, websocketEnabled: checked }))}
                                      className="scale-[0.65]"
                                    />
                                    <span>websocket / streaming</span>
                                  </label>
                                </div>
                              )}
                            </div>
                          ) : (
                            <>
                              <Globe className="h-3.5 w-3.5 text-cyan-500 shrink-0" />
                              <span className="font-mono flex-1 truncate">
                                {svc.domain}
                                {svc.pathPrefix && svc.pathPrefix !== '/' && (
                                  <span className="text-muted-foreground">{svc.pathPrefix}</span>
                                )}
                              </span>
                              {svc.stripPrefix && (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border/50"
                                  title="handle_path: prefix removed before forwarding"
                                >
                                  strip
                                </span>
                              )}
                              {svc.websocketEnabled && (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30"
                                  title="WebSocket / streaming: flush_interval -1 + 24h timeouts"
                                >
                                  ws
                                </span>
                              )}
                              {svc.allowFraming && (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30"
                                  title="Allow framing: site emits -X-Frame-Options + Content-Security-Policy frame-ancestors"
                                >
                                  iframe
                                </span>
                              )}
                              <span className="text-muted-foreground">:{svc.port}</span>
                              {svc.reachable === false && (
                                <span
                                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30"
                                  title={(() => {
                                    const target = `${svc.upstreamIp || '?'}:${svc.port}`;
                                    if (svc.boundLoopbackOnly) {
                                      return `Caddy can't reach ${target} — port ${svc.port} is bound to 127.0.0.1 only inside the container. Rebind it to 0.0.0.0:${svc.port} so Caddy can reach it from the host.`;
                                    }
                                    const open = containerListening?.reachable || [];
                                    const loop = containerListening?.loopbackOnly || [];
                                    const parts = [`Caddy can't reach ${target} — nothing answered the TCP handshake.`];
                                    if (open.length) {
                                      parts.push(`Reachable ports inside container: ${open.join(', ')}.`);
                                    } else {
                                      parts.push('No TCP ports are listening on a non-loopback interface inside the container.');
                                    }
                                    if (loop.length) {
                                      parts.push(`Bound to 127.0.0.1 only (Caddy can't reach these): ${loop.join(', ')}.`);
                                    }
                                    return parts.join(' ');
                                  })()}
                                >
                                  502
                                </span>
                              )}
                              {svc.reachable === true && (svc.httpHealthy === false ? (
                                <span
                                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 border border-yellow-500/30"
                                  title={(() => {
                                    const target = `${svc.upstreamIp || '?'}:${svc.port}`;
                                    const path = svc.healthPath || '';
                                    if (svc.httpStatus) {
                                      return `Reached ${target} but HEAD ${path} returned HTTP ${svc.httpStatus}. The TCP listener is up; the application is replying with errors.`;
                                    }
                                    return `Reached ${target} but HEAD ${path} failed (${svc.httpError || 'no response'}). The TCP listener is up; the application isn't responding to HTTP.`;
                                  })()}
                                >
                                  TCP
                                </span>
                              ) : (
                                <span
                                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/30"
                                  title={(() => {
                                    const target = `${svc.upstreamIp || ''}:${svc.port}`;
                                    if (svc.healthPath) {
                                      return `Upstream ${target} is reachable; HEAD ${svc.healthPath} returned HTTP ${svc.httpStatus || '2xx'}.`;
                                    }
                                    return `Upstream ${target} is reachable.`;
                                  })()}
                                >
                                  OK
                                </span>
                              ))}
                              {svc.staleIp && (
                                <span
                                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 border border-yellow-500/30"
                                  title={`Caddy config still points at ${svc.upstreamIp}, but the container's current IP is different. Edit and save to regenerate.`}
                                >
                                  stale IP
                                </span>
                              )}
                              <Shield className={`h-3 w-3 ${svc.obtainCert ? 'text-green-500' : 'text-muted-foreground/40'}`} />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-1.5 text-muted-foreground hover:text-cyan-500"
                                onClick={() => {
                                  // Phase 2c: editing key is the row's
                                  // unique id (db rows) or a (domain, path)
                                  // tuple (legacy file rows). Avoids the
                                  // earlier bug where multiple rows on the
                                  // same domain all flipped into edit mode
                                  // because the key was just `svc.domain`.
                                  const key = svc.id || `${svc.domain}|${svc.pathPrefix || '/'}`;
                                  setEditingService(key);
                                  setEditServiceForm({
                                    domain: svc.domain,
                                    port: String(svc.port || ''),
                                    obtainCert: svc.obtainCert,
                                    healthPath: svc.healthPath || '',
                                    pathPrefix: svc.pathPrefix || '/',
                                    stripPrefix: !!svc.stripPrefix,
                                    websocketEnabled: !!svc.websocketEnabled,
                                  });
                                }}
                              >
                                <Settings className="h-3 w-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-1.5 text-muted-foreground hover:text-red-500"
                                onClick={() => handleDeleteService(svc)}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </>
                          )}
                          </div>
                          {svc.reachable === false && (
                            <div className="px-2 pb-2 -mt-1 text-[10.5px] leading-snug text-red-300/90">
                              {(() => {
                                const target = `${svc.upstreamIp || '?'}:${svc.port}`;
                                if (svc.boundLoopbackOnly) {
                                  return (
                                    <>
                                      Port {svc.port} is bound to <span className="font-mono">127.0.0.1</span> only inside the container —
                                      Caddy on the host can't reach it. Rebind the upstream to <span className="font-mono">0.0.0.0:{svc.port}</span> (Docker:
                                      use <span className="font-mono">"{svc.port}:{svc.port}"</span>, not <span className="font-mono">"127.0.0.1:{svc.port}:{svc.port}"</span>).
                                    </>
                                  );
                                }
                                const open = containerListening?.reachable || [];
                                const loop = containerListening?.loopbackOnly || [];
                                const introErr = containerListening?.error;
                                if (introErr && open.length === 0 && loop.length === 0) {
                                  return (
                                    <>
                                      Caddy can't reach <span className="font-mono">{target}</span>. Couldn't introspect the container's
                                      listening sockets ({introErr}).
                                    </>
                                  );
                                }
                                return (
                                  <>
                                    Caddy can't reach <span className="font-mono">{target}</span>.{' '}
                                    {open.length
                                      ? <>Listening on a reachable interface inside the container: <span className="font-mono">{open.join(', ')}</span>.</>
                                      : <>Nothing is listening on a non-loopback interface inside the container.</>}
                                    {loop.length ? <> Bound to <span className="font-mono">127.0.0.1</span> only: <span className="font-mono">{loop.join(', ')}</span>.</> : null}
                                  </>
                                );
                              })()}
                            </div>
                          )}
                          {svc.staleIp && svc.reachable !== false && (
                            <div className="px-2 pb-2 -mt-1 text-[10.5px] leading-snug text-yellow-300/90">
                              Caddy config still points at <span className="font-mono">{svc.upstreamIp}</span>, but the container's current IP is different. Edit the entry and click ✓ to regenerate.
                            </div>
                          )}
                          {svc.reachable === true && svc.httpHealthy === false && (
                            <div className="px-2 pb-2 -mt-1 text-[10.5px] leading-snug text-yellow-300/90">
                              Reached <span className="font-mono">{svc.upstreamIp || '?'}:{svc.port}</span> but{' '}
                              <span className="font-mono">GET {svc.healthPath}</span>{' '}
                              {svc.httpStatus
                                ? <>returned HTTP <span className="font-mono">{svc.httpStatus}</span>.</>
                                : <>failed ({svc.httpError || 'no response'}).</>}
                              {' '}The TCP listener is up; the application is replying with errors.
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground mb-3">
                      {servicesLoading ? 'Loading services...' : 'No services configured. Add a domain to route traffic to this container.'}
                    </p>
                  )}

                  {/* Phase 2c: exposed-port chip row. Always visible
                      when the container reports any listeners; clicking
                      a chip seeds the port input below. Single-port
                      chips are clickable; range chips render as
                      info-only since Caddy can't reverse-proxy a port
                      range — those are L4-forward territory and surface
                      in the service-detail panel instead. */}
                  {(exposedPorts.tcp.length > 0 || exposedPorts.udp.length > 0 || exposedPortsLoading) && (
                    <div className="mb-2">
                      <div className="text-[11px] text-muted-foreground mb-1 flex items-center gap-2">
                        Detected listeners inside the container
                        {exposedPortsScannedAt && (
                          <span className="opacity-60">· last {new Date(exposedPortsScannedAt).toLocaleTimeString()}</span>
                        )}
                        <button
                          type="button"
                          className="underline opacity-70 hover:opacity-100"
                          onClick={() => fetchExposedPorts(selectedContainer.name)}
                        >
                          rescan
                        </button>
                        <button
                          type="button"
                          className="underline opacity-70 hover:opacity-100"
                          title="Force-rebuild every merged Caddyfile this LXC owns and reload Caddy. Use when on-disk state has drifted from what the UI shows (a missed reload, a stale edit)."
                          onClick={async () => {
                            try {
                              const r = await api.regenerateLxcCaddy(selectedContainer.name);
                              if (r?.warning) {
                                toast({ title: 'Regenerated with warning', description: r.warning, variant: 'destructive' });
                              } else if (r?.errors?.length) {
                                toast({
                                  title: 'Regenerated with errors',
                                  description: r.errors.map((e) => `${e.domain}: ${e.error}`).join('; '),
                                  variant: 'destructive',
                                });
                              } else {
                                toast({
                                  title: 'Caddy reloaded',
                                  description: r?.domains?.length
                                    ? `Rebuilt ${r.domains.length} site file(s).`
                                    : 'No domains owned by this LXC.',
                                });
                              }
                              fetchContainerServices(selectedContainer.name);
                            } catch (err) {
                              toast({ title: 'Regenerate failed', description: err.message, variant: 'destructive' });
                            }
                          }}
                        >
                          regenerate Caddy
                        </button>
                        {/* Phase 2c: when the listening-port set is a
                            superset of MEET's required TCP ports
                            (3000/7880/7881/8080), surface a one-click
                            "Quick add MEET" button that lays down all
                            four HTTP routes + both L4 forwards from
                            a single domain entry. Hidden otherwise so
                            the panel stays generic. */}
                        {meetPortsDetected && (
                          <button
                            type="button"
                            className="ml-auto px-2 py-0.5 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 cursor-pointer"
                            onClick={() => setMeetQuickAddOpen(true)}
                            title="Pre-fill the four MEET HTTP routes (/livekit, /api, /ws, /) and the two L4 forwards (tcp/7881, udp/50000-60000) from a single domain entry."
                          >
                            ⚡ Quick add MEET
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {exposedPortsLoading && exposedPorts.tcp.length === 0 && exposedPorts.udp.length === 0 && (
                          <span className="text-[11px] text-muted-foreground italic">Probing…</span>
                        )}
                        {exposedPorts.tcp.map((p, i) => {
                          const isRange = p.portEnd && p.portEnd !== p.port;
                          const label = isRange ? `${p.port}-${p.portEnd}` : String(p.port);
                          return (
                            <button
                              key={`tcp-${p.port}-${p.portEnd ?? ''}-${i}`}
                              type="button"
                              disabled={isRange}
                              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-mono transition-colors ${
                                isRange
                                  ? 'opacity-60 cursor-not-allowed border-border/40'
                                  : 'border-blue-500/40 bg-blue-500/5 hover:bg-blue-500/15 cursor-pointer'
                              }`}
                              title={
                                isRange
                                  ? "Caddy can't reverse-proxy a port range — use an L4 forward in the service detail panel"
                                  : 'Click to fill the port field'
                              }
                              onClick={() => {
                                if (isRange) return;
                                setAddServiceForm((f) => ({ ...f, port: String(p.port) }));
                              }}
                            >
                              tcp/{label}
                            </button>
                          );
                        })}
                        {exposedPorts.udp.map((p, i) => {
                          const isRange = p.portEnd && p.portEnd !== p.port;
                          const label = isRange ? `${p.port}-${p.portEnd}` : String(p.port);
                          return (
                            <span
                              key={`udp-${p.port}-${p.portEnd ?? ''}-${i}`}
                              className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-muted/30 px-2 py-0.5 text-[11px] font-mono opacity-70"
                              title="Caddy can't reverse-proxy UDP — use an L4 forward in the service detail panel"
                            >
                              udp/{label}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Phase 2c: when the operator sets a non-root
                      path, expose strip-prefix + WS toggles. Hidden
                      otherwise so the simple "domain → one port"
                      flow stays a single row. */}
                  {addServiceForm.pathPrefix && addServiceForm.pathPrefix !== '/' && (
                    <div className="flex items-center gap-4 px-1 mb-1.5 text-[11px] text-muted-foreground">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <Switch
                          checked={!!addServiceForm.stripPrefix}
                          onCheckedChange={(checked) => setAddServiceForm((f) => ({ ...f, stripPrefix: checked }))}
                          className="scale-[0.65]"
                        />
                        <span>strip prefix</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <Switch
                          checked={!!addServiceForm.websocketEnabled}
                          onCheckedChange={(checked) => setAddServiceForm((f) => ({ ...f, websocketEnabled: checked }))}
                          className="scale-[0.65]"
                        />
                        <span>websocket / streaming</span>
                      </label>
                    </div>
                  )}

                  {/* Add new service form. Path defaults to / for the
                      common single-port case; setting it to /api,
                      /livekit, etc. routes that path to a different
                      port on the same domain (MEET-style fan-out). */}
                  <div className="flex items-center gap-2 p-2 rounded-lg border border-dashed border-border/50 bg-muted/20">
                    <div className="flex-1 grid grid-cols-4 gap-1.5">
                      <Input
                        placeholder="domain.example.com"
                        value={addServiceForm.domain}
                        onChange={(e) => setAddServiceForm((f) => ({ ...f, domain: e.target.value }))}
                        className="h-7 text-xs"
                        onKeyDown={(e) => e.key === 'Enter' && handleAddService()}
                      />
                      <Input
                        placeholder="/ (or /api)"
                        value={addServiceForm.pathPrefix}
                        onChange={(e) => setAddServiceForm((f) => ({ ...f, pathPrefix: e.target.value }))}
                        className="h-7 text-xs font-mono"
                        title="Route only this path on the domain. Use / for the catch-all, /api for path-routed sub-services."
                        onKeyDown={(e) => e.key === 'Enter' && handleAddService()}
                      />
                      <Input
                        type="number"
                        placeholder="8080"
                        value={addServiceForm.port}
                        onChange={(e) => setAddServiceForm((f) => ({ ...f, port: e.target.value }))}
                        className="h-7 text-xs"
                        list={`lxc-ports-${selectedContainer?.name || 'x'}`}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddService()}
                      />
                      {/* Datalist hooks the port input up to the
                          chip-row data: typing 8 narrows to 8080,
                          dropdown shows every detected single-port
                          listener. Range entries are skipped — Caddy
                          can't route ranges. */}
                      <datalist id={`lxc-ports-${selectedContainer?.name || 'x'}`}>
                        {exposedPorts.tcp
                          .filter((p) => !p.portEnd || p.portEnd === p.port)
                          .map((p, i) => (
                            <option key={`opt-${p.port}-${i}`} value={String(p.port)} />
                          ))}
                      </datalist>
                      <Input
                        placeholder="/healthz"
                        value={addServiceForm.healthPath}
                        onChange={(e) => setAddServiceForm((f) => ({ ...f, healthPath: e.target.value }))}
                        className="h-7 text-xs font-mono"
                        title="Optional HTTP HEAD probe path. Leave blank to keep TCP-only health checks."
                        onKeyDown={(e) => e.key === 'Enter' && handleAddService()}
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <Switch
                        checked={addServiceForm.obtainCert}
                        onCheckedChange={(checked) => setAddServiceForm((f) => ({ ...f, obtainCert: checked }))}
                        className="scale-[0.65]"
                      />
                      <Shield className={`h-3 w-3 ${addServiceForm.obtainCert ? 'text-green-500' : 'text-muted-foreground/40'}`} />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={handleAddService}
                      disabled={!addServiceForm.domain.trim() || addingService}
                    >
                      {addingService ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
                      Add
                    </Button>
                  </div>
                </div>

                {/* TLS cert bind-mounts. Lets the operator attach the
                    Caddy-issued cert directory for this LXC's
                    service(s) as a read-only `disk` device on the LXC,
                    so consumers (coturn, custom apps) can read the
                    same inode the host's Caddy is rotating. Renders
                    nothing useful when the LXC has no service bound,
                    so it's safe to keep visible by default. */}
                <LxcCertMounts
                  container={selectedContainer}
                  api={api}
                  toast={toast}
                />

                {/* Export / Backup */}
                <div>
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <Download className="h-4 w-4" />
                    Backup
                  </h4>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleExport}
                      disabled={exporting}
                    >
                      {exporting && exportProgress?.containerName === selectedContainer.name ? (
                        <><Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          {exportProgress.snapshotName ? 'Downloading snapshot...' : 'Exporting...'}
                        </>
                      ) : (
                        <><Download className="h-3 w-3 mr-1" />Export Container Backup</>
                      )}
                    </Button>
                    {exporting && exportProgress?.containerName === selectedContainer.name && exportProgress?.abortController && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-red-500 hover:text-red-400 border-red-500/30 hover:border-red-500/60"
                        onClick={() => exportProgress.abortController.abort()}
                      >
                        <X className="h-3 w-3 mr-1" />Cancel
                      </Button>
                    )}
                  </div>
                  {exportProgress && exportProgress.containerName === selectedContainer.name && (
                    <div className="mt-2 space-y-1">
                      {exportProgress.phase === 'streaming' && exportProgress.total ? (
                        <div className="h-1.5 bg-muted rounded overflow-hidden">
                          <div
                            className="h-full bg-cyan-500 transition-[width] duration-200"
                            style={{ width: `${Math.min(100, Math.round((exportProgress.loaded / exportProgress.total) * 100))}%` }}
                          />
                        </div>
                      ) : (
                        <div className="h-1.5 bg-muted rounded overflow-hidden">
                          <div className="h-full w-1/3 bg-cyan-500/60 animate-pulse" />
                        </div>
                      )}
                      <p className="text-[10.5px] text-muted-foreground font-mono">
                        {exportProgress.phase === 'streaming' ? (
                          <>
                            {formatSize(exportProgress.loaded)}
                            {exportProgress.total ? ` / ~${formatSize(exportProgress.total)}` : ''}
                            {exportProgress.throughputBps && <> · {formatSize(exportProgress.throughputBps)}/s</>}
                            {' · '}{formatDuration(exportProgress.elapsedMs)} elapsed
                            {exportProgress.total && exportProgress.throughputBps && exportProgress.loaded < exportProgress.total && (
                              <> · ~{formatDuration(((exportProgress.total - exportProgress.loaded) / exportProgress.throughputBps) * 1000)} remaining</>
                            )}
                          </>
                        ) : (
                          // 'preparing' (and the rare 'stalled' edge case
                          // mid-stream) collapse to the same UI: incus
                          // isn't producing tarball bytes right now.
                          <>Preparing snapshot... {formatDuration(exportProgress.elapsedMs)} elapsed</>
                        )}
                      </p>
                      {exportProgress.phase !== 'streaming' && (
                        <p className="text-[10.5px] text-muted-foreground">
                          incus is taking a consistent point-in-time view of the container's filesystem.
                          On <span className="font-mono">dir</span> storage this requires a full copy to a temp area
                          before tarball bytes can flow — typically several minutes for Docker-in-LXC containers.
                          On ZFS/btrfs/LVM-thin this phase is near-instant.
                        </p>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    Downloads a full backup (.tar.gz) of this container including filesystem and config.
                  </p>
                </div>

                {/* Snapshots */}
                <div>
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <Camera className="h-4 w-4" />
                    Snapshots
                  </h4>
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <div className="flex-1 space-y-1">
                        <Input
                          placeholder="Snapshot name"
                          value={snapshotName}
                          onChange={(e) => setSnapshotName(e.target.value)}
                          className="h-8 text-sm"
                        />
                        <Input
                          placeholder="Notes (optional)"
                          value={snapshotNote}
                          onChange={(e) => setSnapshotNote(e.target.value)}
                          className="h-7 text-xs"
                        />
                      </div>
                      <Button
                        size="sm"
                        className="h-8 shrink-0"
                        onClick={handleCreateSnapshot}
                        disabled={snapshotLoading || !snapshotName.trim() || isContainerBusyForExport(selectedContainer.name)}
                        title={isContainerBusyForExport(selectedContainer.name) ? exportBusyTooltip : undefined}
                      >
                        {snapshotLoading ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <><Camera className="h-3 w-3 mr-1" />Create</>
                        )}
                      </Button>
                    </div>
                    {/* In-flight snapshot progress: elapsed timer plus a
                        remaining-time hint when the backend has prior
                        durations to estimate from. Stays scoped to the
                        currently-selected container so opening another
                        LXC mid-snapshot doesn't inherit the indicator. */}
                    {snapshotProgress && selectedContainer && snapshotProgress.containerName === selectedContainer.name && (
                      <div className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-blue-400 flex items-center gap-1.5">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Creating snapshot "{snapshotProgress.snapshotName}"…
                          </span>
                          <span className="font-mono text-muted-foreground">
                            {formatDuration(snapshotProgress.elapsedMs || 0)}
                            {Number.isFinite(snapshotProgress.estimateMs) && snapshotProgress.estimateMs > 0 && (
                              <> / ~{formatDuration(snapshotProgress.estimateMs)}</>
                            )}
                          </span>
                        </div>
                        {Number.isFinite(snapshotProgress.estimateMs) && snapshotProgress.estimateMs > 0 ? (
                          <>
                            <div className="h-1 w-full overflow-hidden rounded bg-muted">
                              <div
                                className="h-full bg-blue-500 transition-[width] duration-700"
                                style={{
                                  width: `${Math.min(99, Math.max(2, ((snapshotProgress.elapsedMs || 0) / snapshotProgress.estimateMs) * 100))}%`,
                                }}
                              />
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              {snapshotProgress.elapsedMs >= snapshotProgress.estimateMs
                                ? 'Taking longer than usual — large or busy containers can need several minutes.'
                                : `~${formatDuration(Math.max(0, snapshotProgress.estimateMs - (snapshotProgress.elapsedMs || 0)))} remaining (estimate)`}
                            </p>
                          </>
                        ) : (
                          <p className="text-[11px] text-muted-foreground">
                            No prior runs for this container — duration depends on size and storage backend.
                          </p>
                        )}
                      </div>
                    )}
                    {snapshots.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-2">No snapshots yet.</p>
                    ) : (
                      <div className="space-y-1.5 max-h-60 overflow-y-auto">
                        {snapshots.map((snap) => {
                          const sName = snap.name || snap;
                          const isExpanded = expandedSnapshot === sName;
                          const notes = snapshotNotes[sName] || [];
                          return (
                            <div
                              key={sName}
                              className="border rounded-md p-2 text-xs"
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => toggleSnapshotExpand(sName)}
                                    className="p-0.5 hover:bg-muted rounded transition-colors"
                                  >
                                    {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                  </button>
                                  <span className="font-medium">{sName}</span>
                                  {snap.created_at && (
                                    <span className="ml-1 text-muted-foreground">{formatDate(snap.created_at)}</span>
                                  )}
                                  {/* Inline size next to the date.  Prefers the
                                      local-storage measurement (snap.size from
                                      the backend's storage-volume enrichment)
                                      and falls back to the S3 export's
                                      bytes_total when local sizing isn't
                                      exposed (older Incus / certain storage
                                      backends).  Hidden when no signal is
                                      available either way. */}
                                  {(() => {
                                    const localSize = snap.size > 0 ? snap.size : null;
                                    const exportBytes = (snapshotS3Exports[sName] || [])
                                      .map((e) => e.bytes_total || e.size_bytes)
                                      .find((v) => v && v > 0);
                                    const sizeBytes = localSize ?? exportBytes ?? null;
                                    if (!sizeBytes) return null;
                                    return (
                                      <span
                                        className="ml-1.5 px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground text-[10px] font-mono"
                                        title={localSize
                                          ? 'Local snapshot disk usage'
                                          : 'Compressed tarball size from S3 export (local size not exposed by storage backend)'}
                                      >
                                        {formatSize(sizeBytes)}
                                      </span>
                                    );
                                  })()}
                                  {notes.length > 0 && (
                                    <span className="ml-1 text-muted-foreground flex items-center gap-0.5">
                                      <StickyNote className="h-3 w-3" />
                                      {notes.length}
                                    </span>
                                  )}
                                  {/* Per-location chips.  A snapshot can
                                      live on the local Incus pool, in any
                                      number of S3 destinations, or any
                                      combination — the row stays visible
                                      as long as any copy exists.  Each
                                      chip carries an inline 🗑 to drop
                                      that location only; the trash icon
                                      in the action column wipes ALL
                                      locations after a confirm. */}
                                  {snap.has_local !== false && (
                                    <span
                                      title="Stored on the host's Incus pool"
                                      className="ml-1 inline-flex items-center gap-0.5 text-[10px] px-1 rounded border bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30"
                                    >
                                      ✓ Local
                                      <button
                                        type="button"
                                        onClick={(ev) => { ev.stopPropagation(); handleDeleteSnapshotLocal(sName); }}
                                        disabled={snapshotLoading}
                                        className="ml-1 hover:text-red-500 opacity-60 disabled:opacity-30"
                                        title="Drop the local copy only — keeps any S3 copies"
                                      >
                                        🗑
                                      </button>
                                    </span>
                                  )}
                                  {(snapshotS3Exports[sName] || []).map((e) => {
                                    const pct = (e.bytes_total && e.bytes_total > 0)
                                      ? Math.min(99, Math.round((e.bytes_uploaded / e.bytes_total) * 100))
                                      : null;
                                    const labelText = `${e.destination_name || e.destination_id}${e.destination_bucket ? ` · ${e.destination_bucket}` : ''}${e.error ? ` — ${e.error}` : ''}`;
                                    return (
                                      <span
                                        key={e.id}
                                        title={labelText}
                                        className={`ml-1 inline-flex items-center gap-0.5 text-[10px] px-1 rounded border ${
                                          e.status === 'exported'
                                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                                            : e.status === 'failed'
                                            ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30'
                                            : e.status === 'deleted'
                                            ? 'bg-muted text-muted-foreground border-border'
                                            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
                                        }`}
                                      >
                                        {e.status === 'pending' ? (
                                          e.cancel_requested
                                            ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                            : <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                        ) : e.status === 'exported' ? '✓' : e.status === 'failed' ? '✕' : '·'}
                                        {' '}
                                        {(e.destination_name || 'S3').slice(0, 12)}
                                        {e.status === 'pending' && pct !== null && (
                                          <span className="font-mono ml-1">{pct}%</span>
                                        )}
                                        {e.status === 'pending' && !e.cancel_requested && (
                                          <button
                                            type="button"
                                            onClick={(ev) => { ev.stopPropagation(); cancelSnapshotExport(sName, e.id); }}
                                            disabled={cancelingExportIds.has(e.id)}
                                            className="ml-1 hover:text-foreground disabled:opacity-50"
                                            title="Cancel this upload"
                                          >
                                            ✕
                                          </button>
                                        )}
                                        {e.status === 'exported' && (
                                          <button
                                            type="button"
                                            onClick={(ev) => { ev.stopPropagation(); deleteSnapshotS3Copy(sName, e.id, e.destination_name); }}
                                            className="ml-1 hover:text-red-500 opacity-60"
                                            title={`Remove from ${e.destination_name || 'destination'}`}
                                          >
                                            🗑
                                          </button>
                                        )}
                                      </span>
                                    );
                                  })}
                                </div>
                                <div className="flex gap-1">
                                  {/* Local-only actions: download tarball,
                                      push to additional S3 destinations,
                                      restore the container to this point.
                                      Hidden for ghost rows (S3-only) — the
                                      operator must Pull to local first. */}
                                  {snap.has_local !== false && (
                                    <>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 w-6 p-0 text-muted-foreground hover:text-cyan-500"
                                        onClick={() => handleDownloadSnapshot(sName)}
                                        disabled={snapshotLoading || exporting}
                                        title="Download snapshot as .tar.gz"
                                      >
                                        <Download className="h-3 w-3" />
                                      </Button>
                                      {backupDestinations.length > 0 && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-6 px-2 text-xs text-sky-500 hover:text-sky-600"
                                          onClick={() => openPushDialog(sName)}
                                          disabled={exportQueueBusy}
                                          title={exportQueueBusy ? exportBusyTooltip : 'Push this snapshot to one or more S3 destinations'}
                                        >
                                          Push to S3
                                        </Button>
                                      )}
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-2 text-xs text-blue-500 hover:text-blue-600"
                                        onClick={() => handleRestoreSnapshot(sName)}
                                        disabled={snapshotLoading}
                                      >
                                        Restore
                                      </Button>
                                    </>
                                  )}
                                  {/* Pull to local: only meaningful when
                                      no local copy exists.  When the
                                      snapshot has multiple S3 copies the
                                      operator picks which one to pull
                                      from via the per-chip 'Pull' link
                                      below; this top-level button uses
                                      the first available exported row. */}
                                  {snap.has_local === false && (() => {
                                    const exported = (snapshotS3Exports[sName] || (snap.s3_locations || []))
                                      .filter((e) => e.status === 'exported');
                                    if (exported.length === 0) return null;
                                    const first = exported[0];
                                    return (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-2 text-xs text-emerald-500 hover:text-emerald-600"
                                        onClick={() => handlePullFromS3(sName, {
                                          id: first.id || first.export_id,
                                          destination_name: first.destination_name,
                                        })}
                                        disabled={snapshotLoading}
                                        title={`Re-import this snapshot from ${first.destination_name || 'S3'} into the local Incus pool`}
                                      >
                                        <Download className="h-3 w-3 mr-1" />
                                        Pull to local
                                      </Button>
                                    );
                                  })()}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs text-red-500 hover:text-red-600"
                                    onClick={() => setConfirmDeleteSnap(sName)}
                                    disabled={snapshotLoading || (selectedContainer && isContainerBusyForExport(selectedContainer.name))}
                                    title={
                                      (selectedContainer && isContainerBusyForExport(selectedContainer.name))
                                        ? exportBusyTooltip
                                        : 'Delete snapshot from EVERY location (local + every S3 destination)'
                                    }
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                              {/* Per-export status detail row.  Visible
                                  inline (no hover required) so operators
                                  immediately see what happened.  Renders
                                  a thin progress bar for each pending
                                  upload + the full error message for
                                  each failure + a Retry button that
                                  re-opens the push dialog with that
                                  destination preselected.  Sits
                                  underneath the row's flex (chips +
                                  actions) rather than inside it so the
                                  layout stays clean. */}
                              {(snapshotS3Exports[sName] || []).filter(
                                (e) => e.status === 'pending' || e.status === 'failed'
                              ).length > 0 && (
                                <div className="ml-5 mt-1 space-y-1">
                                  {(snapshotS3Exports[sName] || [])
                                    .filter((e) => e.status === 'pending' || e.status === 'failed')
                                    .map((e) => {
                                      if (e.status === 'pending') {
                                        return (
                                          <PendingSnapshotExportRow
                                            key={`status-${e.id}`}
                                            exportRow={e}
                                            snapshotName={sName}
                                            onCancel={cancelSnapshotExport}
                                            cancelDisabled={cancelingExportIds.has(e.id)}
                                          />
                                        );
                                      }
                                      // status === 'failed'
                                      return (
                                        <div key={`status-${e.id}`} className="flex items-start gap-2 text-[10.5px] text-red-500">
                                          <span className="min-w-[5rem] truncate text-red-500/70 shrink-0">
                                            → {e.destination_name || e.destination_id}
                                          </span>
                                          <span className="flex-1 break-words">
                                            {e.error || 'failed without error message'}
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setPushSnapshotName(sName);
                                              setPushDestinationIds([e.destination_id]);
                                            }}
                                            className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-muted/40 text-foreground shrink-0"
                                            title="Retry this upload"
                                          >
                                            Retry
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => dismissSnapshotS3Export(sName, e.id)}
                                            className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-muted/40 text-muted-foreground shrink-0"
                                            title="Clear this failed entry from the dashboard. The S3 bucket isn't touched (the upload never finished)."
                                          >
                                            Dismiss
                                          </button>
                                        </div>
                                      );
                                    })}
                                </div>
                              )}
                              {/* Snapshot detail row: stateful, expiry,
                                  architecture.  Size moved inline next to
                                  the snapshot name so an operator scanning
                                  the list sees disk impact at a glance
                                  without expanding details. */}
                              {(snap.stateful || (snap.expires_at && !snap.expires_at.startsWith('0001')) || snap.architecture) && (
                                <div className="flex flex-wrap items-center gap-1.5 mt-1 ml-5 text-[10.5px] text-muted-foreground">
                                  {snap.stateful && (
                                    <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/30" title="Captured running memory state in addition to filesystem">
                                      stateful
                                    </span>
                                  )}
                                  {snap.expires_at && !snap.expires_at.startsWith('0001') && (
                                    <span className="px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 border border-yellow-500/30" title="Auto-deletion time">
                                      expires {formatDate(snap.expires_at)}
                                    </span>
                                  )}
                                  {snap.architecture && (
                                    <span className="px-1.5 py-0.5 rounded bg-muted/60 font-mono">{snap.architecture}</span>
                                  )}
                                </div>
                              )}
                              {snap.description && (
                                <p className="text-muted-foreground mt-1 italic ml-5">{snap.description}</p>
                              )}

                              {/* Expanded notes section */}
                              {isExpanded && (
                                <div className="mt-2 ml-5 space-y-2">
                                  {/* Existing notes */}
                                  {notes.length > 0 && (
                                    <div className="space-y-1">
                                      {notes.map((n) => (
                                        <div key={n.id} className="flex items-start justify-between gap-2 bg-muted/50 rounded px-2 py-1.5">
                                          <div className="min-w-0 flex-1">
                                            <p className="text-xs whitespace-pre-wrap break-words">{n.note}</p>
                                            <p className="text-[10px] text-muted-foreground mt-0.5">{formatDate(n.created_at)}</p>
                                          </div>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-5 w-5 p-0 text-muted-foreground hover:text-red-500 shrink-0"
                                            onClick={() => handleDeleteNote(sName, n.id)}
                                          >
                                            <Trash2 className="h-2.5 w-2.5" />
                                          </Button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {/* Add new note */}
                                  <div className="flex gap-1">
                                    <Input
                                      placeholder="Add a note..."
                                      value={newNoteText}
                                      onChange={(e) => setNewNoteText(e.target.value)}
                                      onKeyDown={(e) => e.key === 'Enter' && handleAddNote(sName)}
                                      className="h-7 text-xs flex-1"
                                    />
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 px-2 text-xs shrink-0"
                                      onClick={() => handleAddNote(sName)}
                                      disabled={!newNoteText.trim()}
                                    >
                                      Add
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              {/* Terminal Tab — live PTY via WebSocket. forceMount keeps
                  the InteractiveTerminal mounted (just CSS-hidden) when
                  the user clicks Details/Files; without it, Radix unmounts
                  inactive tab content and tears down the PTY/WebSocket. */}
              <TabsContent forceMount value="terminal" className="flex-1 flex flex-col min-h-0 overflow-hidden data-[state=inactive]:hidden">
                <LxcTerminalPanel
                  containerName={selectedContainer.name}
                  initialCwd={terminalCwd}
                  instanceType={selectedContainer.type}
                />
              </TabsContent>

              {/* Files Tab */}
              <TabsContent value="files" className="flex-1 flex flex-col min-h-0 overflow-y-auto">
                <ContainerFiles
                  containerName={selectedContainer.name}
                  onOpenTerminal={(path) => {
                    setTerminalCwd(path);
                    setInfoDefaultTab('terminal');
                  }}
                />
              </TabsContent>

              {/* Delegated editing — hand one directory of this container to
                  somebody else's AI, with a revocable key. Not force-mounted:
                  it fetches its own state on open, which is also what keeps the
                  key list honest after a revoke elsewhere. */}
              <TabsContent value="delegated" className="flex-1 min-h-0 overflow-y-auto">
                <DelegatedEditing containerName={selectedContainer.name} />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {/* Phase 2c: Quick-add MEET preset dialog. Triggered from the
          chip-row button when the LXC's listening ports look like a
          MEET install. Single domain input → backend lays down the
          full single-domain layout (4 HTTP routes + 2 L4 forwards)
          in one call. */}
      <Dialog
        open={meetQuickAddOpen}
        onOpenChange={(open) => { if (!meetQuickAddSaving) setMeetQuickAddOpen(open); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Quick add MEET</DialogTitle>
            <DialogDescription>
              Lays down MEET's single-domain reverse-proxy layout on this LXC: four HTTP routes (/livekit/*, /api/*, /ws/*, catch-all → frontend) plus two L4 forwards (tcp/7881, udp/50000-60000). The domain you enter must already point DNS at this host.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="meet-quickadd-domain">Public domain</Label>
              <Input
                id="meet-quickadd-domain"
                value={meetQuickAddDomain}
                onChange={(e) => setMeetQuickAddDomain(e.target.value)}
                placeholder="meet.example.com"
                autoFocus
                disabled={meetQuickAddSaving}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && meetQuickAddDomain.trim()) submitMeetQuickAdd();
                }}
              />
            </div>
            <div className="text-[11px] text-muted-foreground space-y-1">
              <div>Will create:</div>
              <ul className="list-disc list-inside space-y-0.5 pl-1">
                <li><code className="font-mono">/livekit/* → :7880</code> (strip prefix, WebSocket, 24h timeouts)</li>
                <li><code className="font-mono">/api/*     → :8080</code> (50 MiB body cap)</li>
                <li><code className="font-mono">/ws/*      → :8080</code> (WebSocket)</li>
                <li><code className="font-mono">/          → :3000</code> (frontend catch-all, allow iframe embedding)</li>
                <li><code className="font-mono">tcp/7881</code> L4 forward (LiveKit RTC TCP fallback)</li>
                <li><code className="font-mono">udp/50000-60000</code> L4 forward (WebRTC media)</li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMeetQuickAddOpen(false)}
              disabled={meetQuickAddSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={submitMeetQuickAdd}
              disabled={!meetQuickAddDomain.trim() || meetQuickAddSaving}
            >
              {meetQuickAddSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Install'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Host Cleanup Dialog. Two-stage UX: preview lists every
          category with counts/sizes; operator selects what to clean,
          confirms, executes. Categories with count=0 stay greyed out
          so the operator can see the host is already tidy without
          guessing. */}
      <Dialog open={cleanupOpen} onOpenChange={(open) => { if (!cleanupRunning) setCleanupOpen(open); }}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-2xl sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-cyan-500" />
              Host Cleanup
            </DialogTitle>
            <DialogDescription>
              Reclaim disk by removing unused image cache, orphaned export temp containers, and stale upload temp files.
              {' '}Operator data (containers, snapshots, attached storage volumes) is never touched.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {cleanupLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Scanning host...
              </div>
            )}
            {!cleanupLoading && cleanupPreview?.categories?.map((cat) => {
              const checked = cleanupSelected.has(cat.key);
              const empty = cat.count === 0;
              return (
                <label
                  key={cat.key}
                  className={`flex items-start gap-3 p-3 rounded-lg border ${empty ? 'opacity-50 cursor-not-allowed border-border/30' : 'cursor-pointer border-border/60 hover:border-cyan-500/40'} ${checked && !empty ? 'bg-cyan-500/5 border-cyan-500/40' : 'bg-muted/20'}`}
                >
                  <input
                    type="checkbox"
                    className="mt-1 cursor-pointer"
                    checked={checked}
                    disabled={empty || cleanupRunning}
                    onChange={() => toggleCleanupCategory(cat.key)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-sm font-medium">{cat.label}</span>
                      <span className="text-xs text-muted-foreground font-mono">
                        {cat.count} item{cat.count === 1 ? '' : 's'}
                        {cat.bytes > 0 ? ` · ${formatSize(cat.bytes)}` : ''}
                      </span>
                    </div>
                    {cat.description && (
                      <p className="text-xs text-muted-foreground mt-1">{cat.description}</p>
                    )}
                    {cat.error && (
                      <p className="text-xs text-red-400 mt-1 font-mono">Scan error: {cat.error}</p>
                    )}
                    {cat.items?.length > 0 && (
                      <details className="mt-1.5">
                        <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground">
                          Show items
                        </summary>
                        <ul className="mt-1 space-y-0.5 text-[11px] font-mono text-muted-foreground max-h-32 overflow-y-auto">
                          {cat.items.map((item) => (
                            <li key={item.id} className="flex justify-between gap-2">
                              <span className="truncate">
                                {item.label}
                                {item.sublabel && <span className="text-muted-foreground/60"> · {item.sublabel}</span>}
                              </span>
                              {item.size > 0 && <span className="shrink-0">{formatSize(item.size)}</span>}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                </label>
              );
            })}
            {!cleanupLoading && cleanupPreview && cleanupPreview.categories?.every((c) => c.count === 0) && (
              <div className="text-center py-6 text-sm text-muted-foreground">
                Host is already tidy — nothing to clean.
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCleanupOpen(false)} disabled={cleanupRunning}>
              {cleanupRunning ? 'Running...' : 'Close'}
            </Button>
            <Button
              onClick={handleRunCleanup}
              disabled={cleanupRunning || cleanupLoading || cleanupSelected.size === 0}
            >
              {cleanupRunning ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Cleaning up...</>
              ) : (
                <><Sparkles className="h-4 w-4 mr-2" />Clean Up{cleanupSelected.size > 0 ? ` (${cleanupSelected.size})` : ''}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Container Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5 text-cyan-500" />
              Import Container
            </DialogTitle>
            <DialogDescription>
              Restore a container from a backup (.tar.gz) file.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Container Name *</Label>
              <Input
                placeholder="my-container"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Backup File *</Label>
              <Input
                type="file"
                accept=".tar.gz,.tar,.gz"
                onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                disabled={importing}
              />
              <p className="text-xs text-muted-foreground">
                Upload a .tar.gz backup file created by the export feature.
                {importFile && <> Selected: <span className="font-mono">{importFile.name}</span> ({formatSize(importFile.size)}).</>}
              </p>
            </div>
            {importProgress && (
              <div className="space-y-1.5">
                {importProgress.phase === 'uploading' && importProgress.total ? (
                  <div className="h-2 bg-muted rounded overflow-hidden">
                    <div
                      className="h-full bg-cyan-500 transition-[width] duration-200"
                      style={{ width: `${Math.min(100, Math.round((importProgress.loaded / importProgress.total) * 100))}%` }}
                    />
                  </div>
                ) : (
                  <div className="h-2 bg-muted rounded overflow-hidden">
                    <div className="h-full w-1/3 bg-cyan-500/60 animate-pulse" />
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground font-mono">
                  {importProgress.phase === 'uploading' ? (
                    <>
                      Uploading: {formatSize(importProgress.loaded)} / {formatSize(importProgress.total)}
                      {' '}({Math.round((importProgress.loaded / importProgress.total) * 100)}%)
                      {importProgress.throughputBps && <> · {formatSize(importProgress.throughputBps)}/s</>}
                      {' · '}{formatDuration(importProgress.elapsedMs)} elapsed
                      {importProgress.throughputBps && importProgress.loaded < importProgress.total && (
                        <> · ~{formatDuration(((importProgress.total - importProgress.loaded) / importProgress.throughputBps) * 1000)} remaining</>
                      )}
                    </>
                  ) : (
                    <>Processing on host (incus import + start)... {formatDuration(importProgress.elapsedMs)} elapsed</>
                  )}
                </p>
                {importProgress.phase === 'processing' && (
                  <p className="text-[10.5px] text-muted-foreground">
                    Upload complete; the host is now unpacking the tarball and registering the container with incus. This can take several minutes for large backups.
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)} disabled={importing}>
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={importing || !importName.trim() || !importFile}>
              {importing ? (
                importProgress?.phase === 'processing'
                  ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Processing...</>
                  : <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Uploading...</>
              ) : (
                <><Upload className="h-4 w-4 mr-2" />Import</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-500">
              <Trash2 className="h-5 w-5" />
              Delete Container
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete container &apos;{deleteTarget}&apos;? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-sm text-red-500 font-medium">Warning:</p>
            <p className="text-xs text-muted-foreground mt-1">
              All data, configurations, and snapshots inside this container will be permanently lost.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Deleting...</>
              ) : (
                <><Trash2 className="h-4 w-4 mr-2" />Delete</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resize Dialog */}
      <Dialog open={resizeOpen} onOpenChange={setResizeOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-sm sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Cpu className="h-5 w-5 text-blue-500" />
              Resize Container
            </DialogTitle>
            <DialogDescription>
              Update resource limits for {selectedContainer?.name}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="resize-cpu">CPU Cores</Label>
              <Input
                id="resize-cpu"
                type="number"
                placeholder="2"
                value={resizeForm.cpu}
                onChange={(e) => setResizeForm((f) => ({ ...f, cpu: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="resize-memory">Memory (MB)</Label>
              <Input
                id="resize-memory"
                type="number"
                placeholder="2048"
                value={resizeForm.memory}
                onChange={(e) => setResizeForm((f) => ({ ...f, memory: e.target.value }))}
              />
              {selectedContainer?.type === 'virtual-machine' && (
                <p className="text-xs text-muted-foreground">
                  VM memory changes apply on next boot. Use Reboot to apply now.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResizeOpen(false)} disabled={resizing}>
              Cancel
            </Button>
            <Button onClick={handleResize} disabled={resizing}>
              {resizing ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Applying...</>
              ) : (
                'Apply Changes'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Push-to-S3 dialog: scoped to one snapshot row.  Default-
          selects every destination not already exported to so
          common-case clicks ('push to all configured') are
          one-click.  Operator can deselect; submit posts to the
          retroactive S3 export route.  Live progress + cancel
          surface back on the snapshot row's chips via the
          polling effect. */}
      <Dialog
        open={!!pushSnapshotName}
        onOpenChange={(o) => { if (!o && !pushBusy) setPushSnapshotName(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Push snapshot to S3</DialogTitle>
            <DialogDescription>
              Push <code className="font-mono text-xs">{pushSnapshotName}</code> to one or more
              S3 destinations.  Local snapshot stays where it is — this is an additional
              off-host copy.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {backupDestinations.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No destinations configured.  Add one under Housekeeping → Storage first.
              </p>
            ) : (
              <div className="border rounded p-2 max-h-48 overflow-y-auto text-xs space-y-1">
                {backupDestinations.map((d) => {
                  const exported = (snapshotS3Exports[pushSnapshotName] || [])
                    .find((e) => e.destination_id === d.id
                      && (e.status === 'exported' || e.status === 'pending'));
                  return (
                    <label
                      key={d.id}
                      className={`flex items-center gap-2 py-0.5 rounded px-1 ${
                        exported ? 'opacity-60' : 'cursor-pointer hover:bg-muted/40'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={pushDestinationIds.includes(d.id)}
                        disabled={!!exported}
                        onChange={() => setPushDestinationIds((prev) =>
                          prev.includes(d.id)
                            ? prev.filter((x) => x !== d.id)
                            : [...prev, d.id]
                        )}
                      />
                      <span className="font-medium truncate flex-1">
                        {d.name}{d.is_default ? ' (default)' : ''}
                      </span>
                      <span className="text-muted-foreground font-mono text-[10px] truncate">
                        {exported ? `(${exported.status})` : d.bucket}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Already-exported / in-flight destinations are pre-disabled.  The push runs
              asynchronously — leaving the page is safe; progress chips on the snapshot
              row resume on return.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPushSnapshotName(null)} disabled={pushBusy}>
              Cancel
            </Button>
            <Button
              onClick={submitPushDialog}
              disabled={pushBusy || pushDestinationIds.length === 0 || backupDestinations.length === 0}
            >
              {pushBusy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Push to {pushDestinationIds.length === 0 ? 'S3' : `${pushDestinationIds.length} destination${pushDestinationIds.length === 1 ? '' : 's'}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Snapshot delete confirm.  Pre-this commit the trash icon
          fired the delete immediately — easy to mis-click on a
          snapshot row that has many other small icons.  Confirm
          dialog now mediates; existing handleDeleteSnapshot is
          unchanged. */}
      <Dialog
        open={!!confirmDeleteSnap}
        onOpenChange={(o) => { if (!o && !snapshotLoading) setConfirmDeleteSnap(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete snapshot</DialogTitle>
            <DialogDescription>
              Permanently delete <code className="font-mono text-xs text-foreground">{confirmDeleteSnap}</code>
              {' '}from every location?
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const snapRow = snapshots.find((s) => (s.name || s) === confirmDeleteSnap);
            const hasLocal = snapRow ? snapRow.has_local !== false : true;
            const exportedDests = (snapshotS3Exports[confirmDeleteSnap] || [])
              .filter((e) => e.status === 'exported')
              .map((e) => e.destination_name || e.destination_id);
            const pendingDests = (snapshotS3Exports[confirmDeleteSnap] || [])
              .filter((e) => e.status === 'pending')
              .map((e) => e.destination_name || e.destination_id);
            if (!hasLocal && exportedDests.length === 0 && pendingDests.length === 0) {
              return (
                <p className="text-sm text-muted-foreground">
                  This snapshot has no copies left — the row will simply disappear.
                </p>
              );
            }
            return (
              <div className="space-y-2 text-sm">
                <p className="font-medium">This will remove:</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {hasLocal && <li>the local copy on this host's Incus pool</li>}
                  {exportedDests.length > 0 && (
                    <li>S3 copies in: <span className="font-medium text-foreground">{exportedDests.join(', ')}</span></li>
                  )}
                  {pendingDests.length > 0 && (
                    <li>cancel any in-flight upload to: <span className="font-medium text-foreground">{pendingDests.join(', ')}</span></li>
                  )}
                </ul>
                <p className="text-xs text-muted-foreground">
                  Use the chip 🗑 buttons instead to drop a single location only. Cannot be undone.
                </p>
              </div>
            );
          })()}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmDeleteSnap(null)}
              disabled={snapshotLoading}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                const name = confirmDeleteSnap;
                setConfirmDeleteSnap(null);
                await handleDeleteSnapshot(name);
              }}
              disabled={snapshotLoading}
            >
              {snapshotLoading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Delete snapshot
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Per-S3-destination delete confirm dialog.  Replaces the
          old window.confirm (which an operator on the LXC tab
          described as 'lxc.fractionate.ai says...' — jarring on a
          modern admin UI).  Also shows object-lock / retention
          info from a HEAD round-trip so 'looks deleted but the
          bucket secretly retained it' can't happen silently. */}
      <Dialog
        open={!!pendingS3Delete}
        onOpenChange={(o) => { if (!o && !pendingS3Delete?.busy) setPendingS3Delete(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete S3 copy</DialogTitle>
            <DialogDescription>
              Remove the S3 copy of{' '}
              <code className="font-mono text-xs text-foreground">{pendingS3Delete?.snapshotName}</code>
              {' '}from{' '}
              <span className="font-medium text-foreground">{pendingS3Delete?.destinationName || 'this destination'}</span>?
              The local snapshot stays.
            </DialogDescription>
          </DialogHeader>
          {pendingS3Delete?.infoLoading && (
            <p className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Checking object lock state…
            </p>
          )}
          {pendingS3Delete?.info?.error && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Could not verify lock state: {pendingS3Delete.info.error}.
              Delete will be attempted; an explicit lock error will surface in this dialog.
            </p>
          )}
          {pendingS3Delete?.info && pendingS3Delete.info.found === false && (
            <p className="text-xs text-muted-foreground">
              Object is already gone from the bucket — this will just
              clear the dashboard row.
            </p>
          )}
          {pendingS3Delete?.info?.locked && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs space-y-1">
              <p className="font-medium text-amber-700 dark:text-amber-300">
                This object is locked and cannot be deleted.
              </p>
              {pendingS3Delete.info.legal_hold && (
                <p>• Legal hold is <span className="font-medium">ON</span>.</p>
              )}
              {pendingS3Delete.info.retention_until && (
                <p>
                  • Retained until{' '}
                  <span className="font-mono">
                    {new Date(pendingS3Delete.info.retention_until).toISOString().split('T')[0]}
                  </span>
                  {pendingS3Delete.info.retention_mode && (
                    <> (mode: <span className="font-mono">{pendingS3Delete.info.retention_mode}</span>)</>
                  )}.
                </p>
              )}
              <p className="text-muted-foreground">
                Lift the bucket's Object Lock or wait for retention to expire,
                then try again.
              </p>
            </div>
          )}
          {pendingS3Delete?.info && pendingS3Delete.info.found && !pendingS3Delete.info.locked && (
            <p className="text-xs text-muted-foreground">
              Object is unlocked — delete will fire on confirm.
              {pendingS3Delete.info.content_length
                ? ` (${(pendingS3Delete.info.content_length / 1024 / 1024).toFixed(1)} MB)`
                : ''}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingS3Delete(null)}
              disabled={!!pendingS3Delete?.busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmS3DeleteFromDialog}
              disabled={!!pendingS3Delete?.busy || !!pendingS3Delete?.info?.locked}
            >
              {pendingS3Delete?.busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              {pendingS3Delete?.info?.locked ? 'Locked' : 'Delete S3 copy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Local-only delete confirm. */}
      <Dialog
        open={!!pendingLocalDelete}
        onOpenChange={(o) => { if (!o && !pendingLocalDelete?.busy) setPendingLocalDelete(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete local copy</DialogTitle>
            <DialogDescription>
              Drop the local Incus copy of{' '}
              <code className="font-mono text-xs text-foreground">{pendingLocalDelete?.snapshotName}</code>?
              Any S3 copies stay where they are — use a chip's 🗑 to drop those individually.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingLocalDelete(null)}
              disabled={!!pendingLocalDelete?.busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmLocalDeleteFromDialog}
              disabled={!!pendingLocalDelete?.busy}
            >
              {pendingLocalDelete?.busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Delete local copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pull-from-S3 confirm + progress.  The actual import dance
          can take minutes (download tarball + incus import + copy
          to snapshot), so we keep the dialog open while it runs
          and poll the backend's import-progress endpoint to drive
          a phase + percentage indicator. */}
      <Dialog
        open={!!pendingPullFromS3}
        onOpenChange={(o) => { if (!o && !pendingPullFromS3?.busy) setPendingPullFromS3(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Pull snapshot from S3</DialogTitle>
            <DialogDescription>
              Create a new container from{' '}
              <code className="font-mono text-xs text-foreground">{pendingPullFromS3?.snapshotName}</code>
              {' '}on{' '}
              <span className="font-medium text-foreground">
                {pendingPullFromS3?.exportRow?.destination_name || 'S3'}
              </span>?
              The new container will be named{' '}
              <code className="font-mono text-xs text-foreground">
                {selectedContainer?.name || '<container>'}-{pendingPullFromS3?.snapshotName}
              </code>
              {' '}(with{' '}
              <code className="font-mono text-xs">-2</code>,{' '}
              <code className="font-mono text-xs">-3</code>… on collision)
              and the snapshot is preserved on the new container.
            </DialogDescription>
          </DialogHeader>
          {pendingPullFromS3?.busy && (() => {
            const p = pendingPullFromS3.progress || {};
            const total = p.bytes_total;
            const loaded = p.bytes_loaded || 0;
            const pct = (total && total > 0) ? Math.min(99, Math.round((loaded / total) * 100)) : null;
            return (
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{p.label || 'Working…'}</span>
                  {pct !== null && <span className="font-mono ml-auto">{pct}%</span>}
                </div>
                {pct !== null && (
                  <div className="h-1 w-full overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-emerald-500 transition-[width] duration-700"
                      style={{ width: `${Math.max(2, pct)}%` }}
                    />
                  </div>
                )}
                {p.phase && p.phase !== 'downloading' && (
                  <p className="text-[10.5px] text-muted-foreground">
                    Phase: <span className="font-mono">{p.phase}</span>
                    {p.phase === 'importing' || p.phase === 'snapshotting-temp' || p.phase === 'landing-snapshot'
                      ? ' — incus is staging the snapshot; no client-side progress is exposed for this step.'
                      : ''}
                  </p>
                )}
              </div>
            );
          })()}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingPullFromS3(null)}
              disabled={!!pendingPullFromS3?.busy}
            >
              {pendingPullFromS3?.busy ? 'Running…' : 'Cancel'}
            </Button>
            <Button
              variant="default"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={confirmPullFromS3FromDialog}
              disabled={!!pendingPullFromS3?.busy}
            >
              {pendingPullFromS3?.busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Pull to local
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename container dialog. */}
      <Dialog
        open={!!pendingRename}
        onOpenChange={(o) => { if (!o && !pendingRename?.busy) setPendingRename(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename container</DialogTitle>
            <DialogDescription>
              Rename{' '}
              <code className="font-mono text-xs text-foreground">{selectedContainer?.name}</code>?
              Incus requires the container to be stopped first; if it isn't,
              the rename will fail with a clear error.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-input">New name</Label>
            <Input
              id="rename-input"
              autoFocus
              value={pendingRename?.value || ''}
              disabled={!!pendingRename?.busy}
              onChange={(e) => setPendingRename((p) => p ? { ...p, value: e.target.value } : p)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !pendingRename?.busy) handleRenameContainer(); }}
              placeholder="alphanumeric + hyphens only"
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingRename(null)}
              disabled={!!pendingRename?.busy}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRenameContainer}
              disabled={
                !!pendingRename?.busy
                || !pendingRename?.value
                || !pendingRename.value.trim()
                || pendingRename.value.trim() === selectedContainer?.name
              }
            >
              {pendingRename?.busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transfer routes dialog.  Operator picks one of the other
          existing containers as the target; on confirm, every
          services row pointing at the source moves to the target
          and Caddy is regenerated. */}
      <Dialog
        open={!!pendingTransfer}
        onOpenChange={(o) => { if (!o && !pendingTransfer?.busy) setPendingTransfer(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Transfer routes</DialogTitle>
            <DialogDescription>
              Move every HTTP route currently pointing at{' '}
              <code className="font-mono text-xs text-foreground">{pendingTransfer?.fromName}</code>
              {' '}over to a different container.  This is a MOVE — the source
              container will have no routes after.  Caddy is regenerated
              automatically; the target container's IP is re-resolved on the
              next regeneration.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="transfer-target">Target container</Label>
            <select
              id="transfer-target"
              className="w-full border rounded px-2 py-1.5 bg-background text-sm"
              value={pendingTransfer?.toName || ''}
              disabled={!!pendingTransfer?.busy}
              onChange={(e) => setPendingTransfer((p) => p ? { ...p, toName: e.target.value } : p)}
            >
              <option value="">— pick a container —</option>
              {containers
                .filter((c) => c.name !== pendingTransfer?.fromName)
                .map((c) => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
            </select>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingTransfer(null)}
              disabled={!!pendingTransfer?.busy}
            >
              Cancel
            </Button>
            <Button
              onClick={handleTransferRoutes}
              disabled={!!pendingTransfer?.busy || !pendingTransfer?.toName}
            >
              {pendingTransfer?.busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Transfer routes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
