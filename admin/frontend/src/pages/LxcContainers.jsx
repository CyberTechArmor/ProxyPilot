import { useState, useEffect, useCallback } from 'react';
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
import {
  Server, Play, Square, RefreshCw, Trash2, Plus, Info,
  Cpu, MemoryStick, HardDrive, Globe, Camera, Loader2,
  Box, AlertCircle
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resizeOpen, setResizeOpen] = useState(false);

  // Selected container
  const [selectedContainer, setSelectedContainer] = useState(null);
  const [containerState, setContainerState] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotName, setSnapshotName] = useState('');
  const [snapshotLoading, setSnapshotLoading] = useState(false);

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

  // Create container
  const handleCreate = async () => {
    if (!createForm.name || !createForm.image) {
      toast({ title: 'Validation error', description: 'Name and image are required.', variant: 'destructive' });
      return;
    }
    setCreating(true);
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
      toast({ title: 'Container created', description: `${createForm.name} has been created successfully.` });
      setCreateOpen(false);
      setCreateForm({ name: '', image: '', domain: '', port: '', cpu: '', memory: '' });
      setImageSelection('');
      await fetchContainers();
    } catch (err) {
      toast({ title: 'Creation failed', description: err.message, variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  // Open info dialog
  const openInfo = async (container) => {
    setSelectedContainer(container);
    setContainerState(null);
    setSnapshots([]);
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
  const handleCreateSnapshot = async () => {
    if (!selectedContainer || !snapshotName.trim()) return;
    setSnapshotLoading(true);
    try {
      await api.createLxcSnapshot(selectedContainer.name, snapshotName.trim());
      toast({ title: 'Snapshot created', description: `Snapshot "${snapshotName}" created.` });
      setSnapshotName('');
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
            <Card key={ct.name} className="border-dashed border-cyan-500/30">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={ct.status} />
                    <CardTitle
                      className="text-lg cursor-pointer hover:text-cyan-400 transition-colors"
                      onClick={() => openInfo(ct)}
                    >
                      {ct.name}
                    </CardTitle>
                  </div>
                  <div className="flex gap-1">
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
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => openInfo(ct)}
                      title="Info"
                    >
                      <Info className="h-4 w-4" />
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
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-cyan-500" />
              Create LXC Container
            </DialogTitle>
            <DialogDescription>
              Launch a new system container with Incus.
            </DialogDescription>
          </DialogHeader>
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
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !createForm.name || !createForm.image}>
              {creating ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Creating...</>
              ) : (
                <><Plus className="h-4 w-4 mr-2" />Create</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Container Info Dialog */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Info className="h-5 w-5 text-cyan-500" />
              {selectedContainer?.name}
            </DialogTitle>
            <DialogDescription>
              Container details and management
            </DialogDescription>
          </DialogHeader>
          {selectedContainer && (
            <div className="space-y-4 py-2">
              {/* Details */}
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
                            <div className="text-sm font-medium">
                              {(containerState.cpu.usage / 1e9).toFixed(2)}s
                            </div>
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
                            <div className="text-sm font-medium">
                              {(containerState.memory.usage / 1024 / 1024).toFixed(0)} MB
                            </div>
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
                            <div className="text-sm font-medium">
                              {(containerState.disk.root.usage / 1024 / 1024).toFixed(0)} MB
                            </div>
                            <div className="text-xs text-muted-foreground">Disk Used</div>
                          </div>
                        </div>
                      </Card>
                    )}
                  </div>
                </div>
              )}

              {/* Snapshots */}
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <Camera className="h-4 w-4" />
                  Snapshots
                </h4>
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Snapshot name"
                      value={snapshotName}
                      onChange={(e) => setSnapshotName(e.target.value)}
                      className="h-8 text-sm"
                    />
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
                          className="flex items-center justify-between border rounded-md p-2 text-xs"
                        >
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
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
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
