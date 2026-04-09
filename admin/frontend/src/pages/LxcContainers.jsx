import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
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
  Server, Play, Square, RefreshCw, Trash2, Plus, Info,
  Cpu, MemoryStick, HardDrive, Globe, Camera, Loader2,
  Box, AlertCircle, Check, Download, Settings, Wifi,
  Terminal, FolderOpen, File, Upload, ChevronRight, ArrowLeft, FolderUp
} from 'lucide-react';

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

// Terminal component with streaming output, cd persistence, tab completion
function ContainerTerminal({ containerName }) {
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState([]);
  const [running, setRunning] = useState(false);
  const [cmdHistory, setCmdHistory] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [cwd, setCwd] = useState('/root');
  const outputRef = useRef(null);
  const inputRef = useRef(null);

  const scrollToBottom = () => {
    setTimeout(() => {
      if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }, 30);
  };

  const runCommand = async () => {
    const cmd = command.trim();
    if (!cmd || running) return;
    setRunning(true);
    setCommand('');
    setCmdHistory(prev => [cmd, ...prev]);
    setHistoryIdx(-1);

    setHistory(prev => [...prev, { type: 'input', text: `${cwd}$ ${cmd}` }]);
    scrollToBottom();

    // Handle cd locally to track cwd
    const cdMatch = cmd.match(/^cd\s+(.*)/);

    try {
      const response = await api.execInContainer(containerName, cmd, cwd);

      if (!response.ok) {
        let errMsg = `Command failed (HTTP ${response.status})`;
        try {
          const errData = await response.json();
          if (errData.error) errMsg = errData.error;
        } catch {}
        setHistory(prev => [...prev, { type: 'stderr', text: errMsg }]);
        scrollToBottom();
        setRunning(false);
        inputRef.current?.focus();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
          if (!jsonStr) continue;
          try {
            const evt = JSON.parse(jsonStr);
            if (evt.type === 'stdout' && evt.text) {
              setHistory(prev => [...prev, { type: 'stdout', text: evt.text }]);
              scrollToBottom();
            } else if (evt.type === 'stderr' && evt.text) {
              setHistory(prev => [...prev, { type: 'stderr', text: evt.text }]);
              scrollToBottom();
            } else if (evt.type === 'exit') {
              // Update cwd if cd was successful
              if (cdMatch && evt.code === 0) {
                const target = cdMatch[1].trim().replace(/^['"]|['"]$/g, '');
                if (target.startsWith('/')) {
                  setCwd(target);
                } else if (target === '~' || target === '') {
                  setCwd('/root');
                } else if (target === '..') {
                  setCwd(prev => prev.split('/').slice(0, -1).join('/') || '/');
                } else {
                  setCwd(prev => (prev === '/' ? `/${target}` : `${prev}/${target}`));
                }
              }
            }
          } catch {}
        }
      }
    } catch (err) {
      setHistory(prev => [...prev, { type: 'stderr', text: err.message }]);
    } finally {
      setRunning(false);
      scrollToBottom();
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = async (e) => {
    if (e.key === 'Enter') {
      runCommand();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // Tab completion: get the last word and try to complete it
      const parts = command.split(/\s+/);
      const partial = parts[parts.length - 1] || '';
      if (!partial) return;
      try {
        const res = await api.tabComplete(containerName, partial, cwd);
        if (res.completions?.length === 1) {
          parts[parts.length - 1] = partial.includes('/')
            ? partial.substring(0, partial.lastIndexOf('/') + 1) + res.completions[0]
            : res.completions[0];
          setCommand(parts.join(' '));
        } else if (res.completions?.length > 1) {
          setHistory(prev => [...prev, { type: 'stdout', text: res.completions.join('  ') }]);
          scrollToBottom();
        }
      } catch {}
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdHistory.length > 0) {
        const newIdx = Math.min(historyIdx + 1, cmdHistory.length - 1);
        setHistoryIdx(newIdx);
        setCommand(cmdHistory[newIdx]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx > 0) {
        setHistoryIdx(historyIdx - 1);
        setCommand(cmdHistory[historyIdx - 1]);
      } else {
        setHistoryIdx(-1);
        setCommand('');
      }
    }
  };

  const handlePaste = (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (text.includes('\n')) {
      e.preventDefault();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      setCommand(prev => prev + (lines.length > 1 ? lines.join(' && ') : lines[0]));
    }
  };

  return (
    <div className="flex flex-col gap-2 flex-1 min-h-0 h-full overflow-hidden">
      <div className="flex items-center justify-between shrink-0">
        <span className="text-xs text-muted-foreground font-mono">{cwd}</span>
        {history.length > 0 && (
          <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => setHistory([])}>
            Clear
          </Button>
        )}
      </div>
      <div
        ref={outputRef}
        className="bg-black rounded-lg p-3 flex-1 min-h-0 overflow-y-auto font-mono text-xs leading-relaxed"
        onClick={() => inputRef.current?.focus()}
      >
        <div className="text-green-500 mb-2">Connected to {containerName}</div>
        {history.map((entry, i) => (
          <div key={i} className={`whitespace-pre-wrap break-all ${
            entry.type === 'input' ? 'text-cyan-400' :
            entry.type === 'stderr' ? 'text-red-400' :
            'text-gray-300'
          }`}>
            {entry.text}
          </div>
        ))}
        {running && (
          <div className="flex items-center gap-1 text-yellow-500">
            <Loader2 className="h-3 w-3 animate-spin" />
          </div>
        )}
      </div>
      <div className="flex gap-2 shrink-0">
        <div className="flex-1 flex items-center bg-black rounded-lg px-3 font-mono text-xs">
          <span className="text-green-500 mr-1 shrink-0">$</span>
          <input
            ref={inputRef}
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Enter command..."
            disabled={running}
            className="flex-1 bg-transparent border-none outline-none text-gray-300 py-2 text-xs font-mono placeholder:text-gray-600"
            autoFocus
          />
        </div>
        <Button size="sm" onClick={runCommand} disabled={running || !command.trim()}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Run'}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground shrink-0">Tab to autocomplete · Up/Down for history · Paste multi-line to auto-join with &amp;&amp;</p>
    </div>
  );
}

// File manager component for browsing, uploading, and downloading files
function ContainerFiles({ containerName }) {
  const { toast } = useToast();
  const [currentPath, setCurrentPath] = useState('/root');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
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
    const token = localStorage.getItem('token');
    // Fetch with auth and trigger download
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
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
      </div>

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

  // Incus availability
  const [incusAvailable, setIncusAvailable] = useState(null);
  const [incusVersion, setIncusVersion] = useState('');
  const [incusInitWarning, setIncusInitWarning] = useState(null);

  // Containers
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState({});

  // Dialogs
  const [createOpen, setCreateOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoDefaultTab, setInfoDefaultTab] = useState('details');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resizeOpen, setResizeOpen] = useState(false);

  // Selected container
  const [selectedContainer, setSelectedContainer] = useState(null);
  const [containerState, setContainerState] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotName, setSnapshotName] = useState('');
  const [snapshotNote, setSnapshotNote] = useState('');
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState('');
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);

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

  // Create form
  const [imageSelection, setImageSelection] = useState('');
  const [createForm, setCreateForm] = useState({
    name: '', image: '', domain: '', port: '', cpu: '', memory: '',
  });
  const [creating, setCreating] = useState(false);
  const [createProgress, setCreateProgress] = useState(null); // { phase, message, elapsed, error, ip }
  const pollRef = useRef(null);

  // Resize form
  const [resizeForm, setResizeForm] = useState({ cpu: '', memory: '' });
  const [resizing, setResizing] = useState(false);

  // Delete target
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

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
      const data = {
        name: createForm.name,
        image: createForm.image,
        ...(createForm.domain && { domain: createForm.domain }),
        ...(createForm.port && { port: parseInt(createForm.port, 10) }),
        ...(createForm.cpu && { cpu: parseInt(createForm.cpu, 10) }),
        ...(createForm.memory && { memory: parseInt(createForm.memory, 10) }),
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
            setCreateForm({ name: '', image: '', domain: '', port: '', cpu: '', memory: '' });
            setImageSelection('');
            toast({
              title: 'Container created',
              description: `${containerName} is running${status.ip ? ` (IP: ${status.ip})` : ''}`,
            });
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
  const openInfo = async (container, tab = 'details') => {
    setSelectedContainer(container);
    setContainerState(null);
    setSnapshots([]);
    setInfoDefaultTab(tab);
    setInfoOpen(true);
    try {
      const [stateRes, snapRes] = await Promise.all([
        api.getLxcContainerState(container.name).catch(() => null),
        api.getLxcSnapshots(container.name).catch(() => ({ snapshots: [] })),
      ]);
      if (stateRes) setContainerState(stateRes.state);
      setSnapshots(snapRes.snapshots || []);
    } catch {
      // Silently fail for detail fetch
    }
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

  // Snapshot actions
  // Export container as tarball
  const handleExport = async () => {
    if (!selectedContainer) return;
    setExporting(true);
    toast({ title: 'Exporting...', description: `Exporting ${selectedContainer.name} — this may take a while.` });
    try {
      const url = `/api/lxc/containers/${selectedContainer.name}/export`;
      const token = localStorage.getItem('token');
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Export failed');
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${selectedContainer.name}-backup.tar.gz`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast({ title: 'Export complete', description: `${selectedContainer.name} backup downloaded.` });
    } catch (err) {
      toast({ title: 'Export failed', description: err.message, variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  };

  // Import container from backup
  const handleImport = async () => {
    if (!importName.trim() || !importFile) return;
    setImporting(true);
    try {
      await api.importContainer(importName.trim(), importFile);
      toast({ title: 'Import complete', description: `Container '${importName}' imported successfully.` });
      setImportOpen(false);
      setImportName('');
      setImportFile(null);
      await fetchContainers();
    } catch (err) {
      toast({ title: 'Import failed', description: err.message, variant: 'destructive' });
    } finally {
      setImporting(false);
    }
  };

  const handleCreateSnapshot = async () => {
    if (!selectedContainer || !snapshotName.trim()) return;
    setSnapshotLoading(true);
    try {
      await api.createLxcSnapshot(selectedContainer.name, snapshotName.trim(), snapshotNote.trim());
      toast({ title: 'Snapshot created', description: `Snapshot "${snapshotName}" created.` });
      setSnapshotName('');
      setSnapshotNote('');
      const snapRes = await api.getLxcSnapshots(selectedContainer.name);
      setSnapshots(snapRes.snapshots || []);
    } catch (err) {
      toast({ title: 'Snapshot failed', description: err.message, variant: 'destructive' });
    } finally {
      setSnapshotLoading(false);
    }
  };

  const handleRestoreSnapshot = async (snap) => {
    if (!selectedContainer) return;
    setSnapshotLoading(true);
    try {
      await api.restoreLxcSnapshot(selectedContainer.name, snap);
      toast({ title: 'Snapshot restored', description: `Restored "${snap}" on ${selectedContainer.name}.` });
    } catch (err) {
      toast({ title: 'Restore failed', description: err.message, variant: 'destructive' });
    } finally {
      setSnapshotLoading(false);
    }
  };

  const handleDeleteSnapshot = async (snap) => {
    if (!selectedContainer) return;
    setSnapshotLoading(true);
    try {
      await api.deleteLxcSnapshot(selectedContainer.name, snap);
      toast({ title: 'Snapshot deleted', description: `Removed "${snap}".` });
      const snapRes = await api.getLxcSnapshots(selectedContainer.name);
      setSnapshots(snapRes.snapshots || []);
    } catch (err) {
      toast({ title: 'Delete failed', description: err.message, variant: 'destructive' });
    } finally {
      setSnapshotLoading(false);
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cyan-500/10 rounded-lg">
            <Box className="h-6 w-6 text-cyan-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">LXC Containers</h1>
            <p className="text-sm text-muted-foreground">
              {containers.length} container{containers.length !== 1 ? 's' : ''}
              {incusVersion && ` \u2022 Incus ${incusVersion}`}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchContainers}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4 mr-2" />
            Import
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Create Container
          </Button>
        </div>
      </div>

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

      {/* Container Grid */}
      {containers.length === 0 ? (
        <Card className="p-12">
          <div className="flex flex-col items-center justify-center gap-3 text-center">
            <Server className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium">No containers yet</p>
              <p className="text-sm text-muted-foreground">Create your first LXC container to get started.</p>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Container
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {containers.map((ct) => (
            <Card
              key={ct.name}
              className="border-dashed border-cyan-500/30 cursor-pointer hover:border-cyan-500/60 transition-colors"
              onClick={() => openInfo(ct)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={ct.status} />
                    <CardTitle className="text-lg">{ct.name}</CardTitle>
                  </div>
                  <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                    {ct.status?.toLowerCase() === 'running' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-cyan-500 hover:text-cyan-600"
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
                        className="h-7 w-7 p-0 text-yellow-500 hover:text-yellow-600"
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
                        className="h-7 w-7 p-0 text-green-500 hover:text-green-600"
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
                      className="h-7 w-7 p-0 text-blue-500 hover:text-blue-600"
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
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
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
      )}

      {/* Create Container Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!creating) setCreateOpen(open); }}>
        <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => { if (creating) e.preventDefault(); }}>
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
                { key: 'caddy', icon: Globe, label: 'Setting up reverse proxy' },
                { key: 'ready', icon: Check, label: 'Ready' },
              ].map((step, idx, arr) => {
                const phaseOrder = ['starting', 'downloading', 'configuring', 'network', 'caddy', 'ready'];
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
                  <Label htmlFor="ct-name">Name *</Label>
                  <Input
                    id="ct-name"
                    placeholder="my-container"
                    value={createForm.name}
                    onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Image *</Label>
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
                      <SelectValue placeholder="Select an image..." />
                    </SelectTrigger>
                    <SelectContent>
                      {PRESET_IMAGES.map((img) => (
                        <SelectItem key={img.value} value={img.value}>
                          {img.label}
                        </SelectItem>
                      ))}
                      <SelectItem value="__custom__">Custom image...</SelectItem>
                    </SelectContent>
                  </Select>
                  {imageSelection === '__custom__' && (
                    <Input
                      placeholder="images:ubuntu/24.04 or ubuntu:24.04"
                      value={createForm.image}
                      onChange={(e) => setCreateForm((f) => ({ ...f, image: e.target.value }))}
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    Images are pulled from the{' '}
                    <a href="https://images.linuxcontainers.org" target="_blank" rel="noopener noreferrer" className="text-cyan-500 hover:underline">
                      linuxcontainers.org
                    </a>{' '}
                    image server.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="ct-domain">Domain</Label>
                    <Input
                      id="ct-domain"
                      placeholder="myapp.example.com"
                      value={createForm.domain}
                      onChange={(e) => setCreateForm((f) => ({ ...f, domain: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ct-port">Port</Label>
                    <Input
                      id="ct-port"
                      type="number"
                      placeholder="8080"
                      value={createForm.port}
                      onChange={(e) => setCreateForm((f) => ({ ...f, port: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
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
                      placeholder="2048"
                      value={createForm.memory}
                      onChange={(e) => setCreateForm((f) => ({ ...f, memory: e.target.value }))}
                    />
                  </div>
                </div>
                {createForm.domain && (
                  <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                    <p className="text-xs text-green-500">
                      Caddy will automatically provision a TLS certificate for the domain.
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
        <DialogContent className="w-[95vw] max-w-[95vw] h-[90vh] max-h-[90vh] overflow-hidden flex flex-col p-4 gap-2">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Info className="h-5 w-5 text-cyan-500" />
              {selectedContainer?.name}
            </DialogTitle>
            <DialogDescription>
              Container details and management
            </DialogDescription>
          </DialogHeader>
          {selectedContainer && (
            <Tabs defaultValue={infoDefaultTab} key={infoDefaultTab} className="w-full flex-1 flex flex-col min-h-0 overflow-hidden">
              <TabsList className="w-full grid grid-cols-3 shrink-0">
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="terminal">Terminal</TabsTrigger>
                <TabsTrigger value="files">Files</TabsTrigger>
              </TabsList>

              {/* Details Tab */}
              <TabsContent value="details" className="space-y-4 flex-1 overflow-y-auto min-h-0">
                <div className="grid grid-cols-2 gap-3 text-sm">
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
                  <div className="grid grid-cols-2 gap-3">
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
                    <div className="grid grid-cols-2 gap-3">
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

                {/* Export / Backup */}
                <div>
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <Download className="h-4 w-4" />
                    Backup
                  </h4>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleExport}
                    disabled={exporting}
                  >
                    {exporting ? (
                      <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Exporting...</>
                    ) : (
                      <><Download className="h-3 w-3 mr-1" />Export Container Backup</>
                    )}
                  </Button>
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
                        disabled={snapshotLoading || !snapshotName.trim()}
                      >
                        {snapshotLoading ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <><Camera className="h-3 w-3 mr-1" />Create</>
                        )}
                      </Button>
                    </div>
                    {snapshots.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-2">No snapshots yet.</p>
                    ) : (
                      <div className="space-y-1.5 max-h-40 overflow-y-auto">
                        {snapshots.map((snap) => (
                          <div
                            key={snap.name || snap}
                            className="border rounded-md p-2 text-xs"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="font-medium">{snap.name || snap}</span>
                                {snap.created_at && (
                                  <span className="ml-2 text-muted-foreground">{formatDate(snap.created_at)}</span>
                                )}
                              </div>
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-xs text-blue-500 hover:text-blue-600"
                                  onClick={() => handleRestoreSnapshot(snap.name || snap)}
                                  disabled={snapshotLoading}
                                >
                                  Restore
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-xs text-red-500 hover:text-red-600"
                                  onClick={() => handleDeleteSnapshot(snap.name || snap)}
                                  disabled={snapshotLoading}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                              </div>
                            </div>
                            {snap.description && (
                              <p className="text-muted-foreground mt-1 italic">{snap.description}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              {/* Terminal Tab */}
              <TabsContent value="terminal" className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <ContainerTerminal containerName={selectedContainer.name} />
              </TabsContent>

              {/* Files Tab */}
              <TabsContent value="files" className="flex-1 flex flex-col min-h-0 overflow-y-auto">
                <ContainerFiles containerName={selectedContainer.name} />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {/* Import Container Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-md">
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
              />
              <p className="text-xs text-muted-foreground">
                Upload a .tar.gz backup file created by the export feature.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)} disabled={importing}>
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={importing || !importName.trim() || !importFile}>
              {importing ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Importing...</>
              ) : (
                <><Upload className="h-4 w-4 mr-2" />Import</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
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
        <DialogContent className="sm:max-w-sm">
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
    </div>
  );
}
