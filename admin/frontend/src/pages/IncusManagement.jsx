import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Network,
  HardDrive,
  UserCog,
  Image,
  RefreshCw,
  Trash2,
  Settings,
  Check,
  X,
  Loader2,
  ChevronDown,
  ChevronRight,
  Info,
  Shield,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Networks Tab ────────────────────────────────────────────────────────────

function NetworksTab() {
  const [networks, setNetworks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedNet, setExpandedNet] = useState(null);
  const [editingNet, setEditingNet] = useState(null);
  const [editConfig, setEditConfig] = useState({});
  const [saving, setSaving] = useState(false);

  const fetchNetworks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getIncusNetworks();
      setNetworks(data.networks || []);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchNetworks(); }, [fetchNetworks]);

  const handleEdit = (net) => {
    setEditingNet(net);
    setEditConfig({ ...net.config });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Find changed keys
      const changes = {};
      for (const [key, value] of Object.entries(editConfig)) {
        if (editingNet.config[key] !== value) {
          changes[key] = value;
        }
      }
      if (Object.keys(changes).length > 0) {
        await api.updateIncusNetwork(editingNet.name, changes);
        toast({ title: 'Network Updated', description: `'${editingNet.name}' configuration saved.` });
      }
      setEditingNet(null);
      fetchNetworks();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: err.message });
    } finally {
      setSaving(false);
    }
  };

  const toggleNat = async (net) => {
    const currentNat = net.config?.['ipv4.nat'] === 'true';
    try {
      await api.updateIncusNetwork(net.name, { 'ipv4.nat': currentNat ? 'false' : 'true' });
      toast({ title: 'NAT Updated', description: `NAT ${currentNat ? 'disabled' : 'enabled'} on '${net.name}'.` });
      fetchNetworks();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: err.message });
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const importantKeys = ['ipv4.address', 'ipv4.nat', 'ipv4.dhcp', 'ipv4.dhcp.ranges', 'ipv6.address', 'ipv6.nat', 'dns.domain', 'dns.mode'];

  // Separate managed Incus networks from host interfaces
  const managedNetworks = networks.filter(n => n.managed);
  const hostInterfaces = networks.filter(n => !n.managed);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{managedNetworks.length} managed network{managedNetworks.length !== 1 ? 's' : ''}{hostInterfaces.length > 0 ? `, ${hostInterfaces.length} host interface${hostInterfaces.length !== 1 ? 's' : ''}` : ''}</p>
        <Button size="sm" variant="outline" onClick={fetchNetworks}><RefreshCw className="h-3.5 w-3.5 mr-1" />Refresh</Button>
      </div>

      {managedNetworks.length === 0 && hostInterfaces.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No networks found.</CardContent></Card>
      ) : (
        <>
          {/* Managed Incus Networks */}
          {managedNetworks.map((net) => (
            <Card key={net.name} className="overflow-hidden">
              <div
                className="flex items-center justify-between gap-2 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors flex-wrap"
                onClick={() => setExpandedNet(expandedNet === net.name ? null : net.name)}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {expandedNet === net.name ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                  <Network className="h-4 w-4 text-primary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{net.name}</span>
                      <span className="text-xs text-muted-foreground">{net.type}</span>
                      <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded">managed</span>
                    </div>
                    {net.config?.['ipv4.address'] && (
                      <div className="text-xs font-mono text-muted-foreground truncate sm:hidden">
                        {net.config['ipv4.address']}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {net.config?.['ipv4.address'] && (
                    <span className="hidden sm:inline text-xs font-mono text-muted-foreground">{net.config['ipv4.address']}</span>
                  )}
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <span className="text-xs text-muted-foreground">NAT</span>
                    <Switch
                      checked={net.config?.['ipv4.nat'] === 'true'}
                      onCheckedChange={() => toggleNat(net)}
                      className="scale-75"
                    />
                  </div>
                </div>
              </div>

              {expandedNet === net.name && (
                <div className="border-t px-4 py-3 bg-muted/10">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Configuration</span>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleEdit(net)}>
                      <Settings className="h-3 w-3 mr-1" />Edit
                    </Button>
                  </div>
                  {net.config && Object.keys(net.config).length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                      {Object.entries(net.config)
                        .sort(([a], [b]) => {
                          const ai = importantKeys.indexOf(a);
                          const bi = importantKeys.indexOf(b);
                          if (ai !== -1 && bi !== -1) return ai - bi;
                          if (ai !== -1) return -1;
                          if (bi !== -1) return 1;
                          return a.localeCompare(b);
                        })
                        .map(([key, value]) => (
                          <div key={key} className="flex items-baseline gap-2 py-0.5 min-w-0">
                            <span className={cn("text-xs font-mono shrink-0", importantKeys.includes(key) ? 'text-foreground font-medium' : 'text-muted-foreground')}>{key}:</span>
                            <span className="text-xs font-mono text-primary break-all min-w-0">{value || '(empty)'}</span>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No configuration.</p>
                  )}
                  {net.status && (
                    <div className="mt-2 pt-2 border-t">
                      <span className="text-xs text-muted-foreground">Status: </span>
                      <span className={cn("text-xs font-medium", net.status === 'Created' ? 'text-green-500' : 'text-yellow-500')}>{net.status}</span>
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}

          {/* Host Interfaces (collapsed section) */}
          {hostInterfaces.length > 0 && (
            <div className="pt-2">
              <button
                className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
                onClick={() => setExpandedNet(expandedNet === '__host__' ? null : '__host__')}
              >
                {expandedNet === '__host__' ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Host Interfaces ({hostInterfaces.length})
              </button>
              {expandedNet === '__host__' && (
                <div className="space-y-1">
                  {hostInterfaces.map((net) => (
                    <div key={net.name} className="flex items-center gap-3 px-4 py-2 rounded-md bg-muted/20 text-sm">
                      <Network className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-mono text-sm">{net.name}</span>
                      <span className="text-xs text-muted-foreground">{net.type}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Edit Network Dialog */}
      <Dialog open={!!editingNet} onOpenChange={(open) => !open && setEditingNet(null)}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:max-h-[80vh] sm:rounded-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Network: {editingNet?.name}</DialogTitle>
            <DialogDescription>Modify configuration key-value pairs.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {editConfig && Object.entries(editConfig)
              .sort(([a], [b]) => {
                const ai = importantKeys.indexOf(a);
                const bi = importantKeys.indexOf(b);
                if (ai !== -1 && bi !== -1) return ai - bi;
                if (ai !== -1) return -1;
                if (bi !== -1) return 1;
                return a.localeCompare(b);
              })
              .map(([key, value]) => (
                <div key={key} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                  <label className="text-xs font-mono w-full sm:w-44 sm:shrink-0 truncate" title={key}>{key}</label>
                  <Input
                    value={value}
                    onChange={(e) => setEditConfig(prev => ({ ...prev, [key]: e.target.value }))}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingNet(null)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Check className="h-4 w-4 mr-1" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Storage Pools Tab ───────────────────────────────────────────────────────

function StorageTab() {
  const [pools, setPools] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchPools = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getIncusStoragePools();
      setPools(data.pools || []);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPools(); }, [fetchPools]);

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const formatBytes = (bytes) => {
    if (!bytes) return '-';
    const num = parseInt(bytes);
    if (isNaN(num)) return bytes;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = num;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(1)} ${units[i]}`;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{pools.length} storage pool{pools.length !== 1 ? 's' : ''}</p>
        <Button size="sm" variant="outline" onClick={fetchPools}><RefreshCw className="h-3.5 w-3.5 mr-1" />Refresh</Button>
      </div>

      {pools.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No storage pools found.</CardContent></Card>
      ) : (
        pools.map((pool) => {
          const totalSpace = pool.info?.resources?.space?.total;
          const usedSpace = pool.info?.resources?.space?.used;
          const usedPct = totalSpace && usedSpace ? ((usedSpace / totalSpace) * 100).toFixed(1) : null;

          return (
            <Card key={pool.name}>
              <CardContent className="py-4 px-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <HardDrive className="h-4 w-4 text-primary" />
                    <span className="font-medium text-sm">{pool.name}</span>
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{pool.driver}</span>
                    <span className={cn("text-xs font-medium", pool.status === 'Created' ? 'text-green-500' : 'text-yellow-500')}>{pool.status}</span>
                  </div>
                </div>

                {usedPct !== null && (
                  <div className="mb-3">
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>Used: {formatBytes(usedSpace)}</span>
                      <span>Total: {formatBytes(totalSpace)}</span>
                    </div>
                    <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={cn("h-full rounded-full transition-all", parseFloat(usedPct) > 90 ? 'bg-red-500' : parseFloat(usedPct) > 70 ? 'bg-yellow-500' : 'bg-primary')}
                        style={{ width: `${Math.min(parseFloat(usedPct), 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 text-right">{usedPct}% used</p>
                  </div>
                )}

                {pool.config && Object.keys(pool.config).length > 0 && (
                  <div className="border-t pt-2 mt-2">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Config</span>
                    <div className="mt-1 space-y-0.5">
                      {Object.entries(pool.config).map(([key, value]) => (
                        <div key={key} className="flex items-baseline gap-2">
                          <span className="text-xs font-mono text-muted-foreground">{key}:</span>
                          <span className="text-xs font-mono text-primary">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}

// ─── Profiles Tab ────────────────────────────────────────────────────────────

function ProfilesTab() {
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedProfile, setExpandedProfile] = useState(null);
  const [profileDetail, setProfileDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getIncusProfiles();
      setProfiles(data.profiles || []);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  const handleExpand = async (name) => {
    if (expandedProfile === name) {
      setExpandedProfile(null);
      setProfileDetail(null);
      return;
    }
    setExpandedProfile(name);
    setLoadingDetail(true);
    try {
      const data = await api.getIncusProfile(name);
      setProfileDetail(data.profile);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: err.message });
    } finally {
      setLoadingDetail(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{profiles.length} profile{profiles.length !== 1 ? 's' : ''}</p>
        <Button size="sm" variant="outline" onClick={fetchProfiles}><RefreshCw className="h-3.5 w-3.5 mr-1" />Refresh</Button>
      </div>

      {profiles.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No profiles found.</CardContent></Card>
      ) : (
        profiles.map((profile) => (
          <Card key={profile.name} className="overflow-hidden">
            <div
              className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
              onClick={() => handleExpand(profile.name)}
            >
              <div className="flex items-center gap-3">
                {expandedProfile === profile.name ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                <UserCog className="h-4 w-4 text-primary" />
                <div>
                  <span className="font-medium text-sm">{profile.name}</span>
                  {profile.description && <span className="ml-2 text-xs text-muted-foreground">{profile.description}</span>}
                </div>
              </div>
              {profile.used_by && (
                <span className="text-xs text-muted-foreground">{profile.used_by.length} container{profile.used_by.length !== 1 ? 's' : ''}</span>
              )}
            </div>

            {expandedProfile === profile.name && (
              <div className="border-t px-4 py-3 bg-muted/10">
                {loadingDetail ? (
                  <div className="flex items-center justify-center py-4"><Loader2 className="h-4 w-4 animate-spin" /></div>
                ) : profileDetail ? (
                  <div className="space-y-3">
                    {/* Devices */}
                    {profileDetail.devices && Object.keys(profileDetail.devices).length > 0 && (
                      <div>
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Devices</span>
                        <div className="mt-1 space-y-2">
                          {Object.entries(profileDetail.devices).map(([devName, dev]) => (
                            <div key={devName} className="bg-muted/30 rounded p-2">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-xs font-medium">{devName}</span>
                                <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded">{dev.type}</span>
                              </div>
                              <div className="space-y-0.5">
                                {Object.entries(dev).filter(([k]) => k !== 'type').map(([key, value]) => (
                                  <div key={key} className="flex gap-2">
                                    <span className="text-xs font-mono text-muted-foreground">{key}:</span>
                                    <span className="text-xs font-mono text-primary">{value}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Config */}
                    {profileDetail.config && Object.keys(profileDetail.config).length > 0 && (
                      <div>
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Config</span>
                        <div className="mt-1 space-y-0.5">
                          {Object.entries(profileDetail.config).map(([key, value]) => (
                            <div key={key} className="flex gap-2">
                              <span className="text-xs font-mono text-muted-foreground">{key}:</span>
                              <span className="text-xs font-mono text-primary break-all">{value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

// ─── Images Tab ──────────────────────────────────────────────────────────────

function ImagesTab() {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const fetchImages = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getIncusCachedImages();
      setImages(data.images || []);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchImages(); }, [fetchImages]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteIncusCachedImage(deleteTarget.fingerprint);
      toast({ title: 'Image Deleted', description: `Image removed from cache.` });
      setDeleteTarget(null);
      fetchImages();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Error', description: err.message });
    } finally {
      setDeleting(false);
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes) return '-';
    const num = parseInt(bytes);
    if (isNaN(num)) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = num;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(1)} ${units[i]}`;
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    try {
      return new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return dateStr; }
  };

  const getImageLabel = (img) => {
    const props = img.properties || {};
    if (props.description) return props.description;
    if (props.os && props.release) return `${props.os} ${props.release} (${props.architecture || img.architecture})`;
    return img.fingerprint?.substring(0, 12) || 'Unknown';
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{images.length} cached image{images.length !== 1 ? 's' : ''}</p>
        <Button size="sm" variant="outline" onClick={fetchImages}><RefreshCw className="h-3.5 w-3.5 mr-1" />Refresh</Button>
      </div>

      {images.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No cached images. Images are cached when you create containers.</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {images.map((img) => (
            <Card key={img.fingerprint}>
              <CardContent className="py-3 px-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <Image className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium break-words">{getImageLabel(img)}</p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
                        <span className="text-xs text-muted-foreground font-mono">{img.fingerprint?.substring(0, 12)}</span>
                        <span className="text-xs text-muted-foreground">{formatBytes(img.size)}</span>
                        <span className="text-xs text-muted-foreground">{img.type || 'container'}</span>
                        {img.cached && <span className="text-[10px] bg-blue-500/10 text-blue-500 px-1.5 py-0.5 rounded">cached</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                    <div className="text-left sm:text-right">
                      <p className="text-xs text-muted-foreground">Uploaded</p>
                      <p className="text-xs">{formatDate(img.uploaded_at)}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-500 hover:text-red-600 hover:bg-red-500/10 h-11 w-11 sm:h-8 sm:w-8 p-0"
                      onClick={() => setDeleteTarget(img)}
                    >
                      <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Delete Confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Delete Cached Image</DialogTitle>
            <DialogDescription>
              Remove "{deleteTarget ? getImageLabel(deleteTarget) : ''}" from the local cache? Containers using this image will not be affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Trash2 className="h-4 w-4 mr-1" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function IncusManagement() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Incus</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage networks, storage pools, profiles, and cached images.</p>
      </div>

      <Tabs defaultValue="networks">
        <TabsList className="w-full justify-start overflow-x-auto flex-nowrap">
          <TabsTrigger value="networks" className="gap-1.5 shrink-0"><Network className="h-3.5 w-3.5" />Networks</TabsTrigger>
          <TabsTrigger value="storage" className="gap-1.5 shrink-0"><HardDrive className="h-3.5 w-3.5" />Storage</TabsTrigger>
          <TabsTrigger value="profiles" className="gap-1.5 shrink-0"><UserCog className="h-3.5 w-3.5" />Profiles</TabsTrigger>
          <TabsTrigger value="images" className="gap-1.5 shrink-0"><Image className="h-3.5 w-3.5" />Images</TabsTrigger>
        </TabsList>

        <TabsContent value="networks"><NetworksTab /></TabsContent>
        <TabsContent value="storage"><StorageTab /></TabsContent>
        <TabsContent value="profiles"><ProfilesTab /></TabsContent>
        <TabsContent value="images"><ImagesTab /></TabsContent>
      </Tabs>
    </div>
  );
}
