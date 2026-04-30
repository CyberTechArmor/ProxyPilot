import { useState, useEffect, useMemo } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Loader2, KeyRound, Copy, Check, Trash2, RefreshCw, ShieldOff } from 'lucide-react';
import { Navigate } from 'react-router-dom';

const TYPED_PHRASE = 'i have another way into this account';

function fmtRelative(iso) {
  if (!iso) return '—';
  const ageSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

function shortFp(fp) {
  if (!fp) return '';
  if (fp.length <= 24) return fp;
  return fp.slice(0, 18) + '…' + fp.slice(-3);
}

export default function SshAccess() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';
  const { toast } = useToast();

  const [filter, setFilter] = useState('active');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reconciling, setReconciling] = useState(false);
  const [userFilter, setUserFilter] = useState('');
  const [labelFilter, setLabelFilter] = useState('');

  const [addOpen, setAddOpen] = useState(false);
  const [addTab, setAddTab] = useState('bootstrap'); // 'bootstrap' | 'paste'
  const [bootstrapId, setBootstrapId] = useState('');
  const [bootstrapUser, setBootstrapUser] = useState('root');
  const [bootstrapServer, setBootstrapServer] = useState(window.location.host);
  const [bootstrapShell, setBootstrapShell] = useState('bash');
  const [bootstrapScript, setBootstrapScript] = useState('');
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [scriptCopied, setScriptCopied] = useState(false);
  const [bootstrapPubkey, setBootstrapPubkey] = useState('');
  const [bootstrapLabel, setBootstrapLabel] = useState('');
  const [bootstrapSubmitting, setBootstrapSubmitting] = useState(false);

  const [pasteForm, setPasteForm] = useState({ id: '', unix_user: 'root', label: '', public_key: '' });
  const [adding, setAdding] = useState(false);

  const [revokeRow, setRevokeRow] = useState(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeWarning, setRevokeWarning] = useState(null);
  const [revokePhrase, setRevokePhrase] = useState('');
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    if (isAdmin) loadEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, filter]);

  if (!isAdmin) return <Navigate to="/" replace />;

  async function loadEntries() {
    setLoading(true);
    try {
      const r = await api.listSshAccess(filter);
      setEntries(r.entries || []);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to load SSH access entries', description: e.message });
    } finally {
      setLoading(false);
    }
  }

  async function handleReconcile() {
    setReconciling(true);
    try {
      const r = await api.reconcileSshAccess(false);
      const changed = (r.users || []).filter(u => u.changed);
      toast({
        title: changed.length === 0 ? 'Reconcile no-op' : `Reconciled ${changed.length} user(s)`,
        description: changed.length === 0
          ? 'authorized_keys is already in sync.'
          : changed.map(u => `${u.user}: ${u.before_count}→${u.after_count}`).join(', '),
      });
      loadEntries();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Reconcile failed', description: e.message });
    } finally {
      setReconciling(false);
    }
  }

  function openAdd() {
    setAddTab('bootstrap');
    setBootstrapId('');
    setBootstrapScript('');
    setBootstrapPubkey('');
    setBootstrapLabel('');
    setBootstrapShell('bash');
    setPasteForm({ id: '', unix_user: 'root', label: '', public_key: '' });
    setAddOpen(true);
  }

  async function handleGenerateBootstrap() {
    if (!bootstrapId) {
      toast({ variant: 'destructive', title: 'id required' });
      return;
    }
    setBootstrapLoading(true);
    try {
      const r = await api.getSshAccessBootstrapScript(bootstrapId, {
        user: bootstrapUser,
        server: bootstrapServer,
        shell: bootstrapShell,
      });
      setBootstrapScript(r.script || '');
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to render bootstrap script', description: e.message });
    } finally {
      setBootstrapLoading(false);
    }
  }

  // Submit just the public key the operator copied from their device
  // shell after running the bootstrap script. id + unix user already
  // live on the form fields above; label is an optional human tag.
  async function handleBootstrapSubmit() {
    const trimmed = bootstrapPubkey.trim();
    if (!bootstrapId || !bootstrapUser || !trimmed) {
      toast({ variant: 'destructive', title: 'id, unix user, and public key are required' });
      return;
    }
    setBootstrapSubmitting(true);
    try {
      await api.addSshAccess({
        id: bootstrapId,
        unix_user: bootstrapUser,
        public_key: trimmed,
        label: bootstrapLabel.trim() || null,
      });
      toast({ title: `Added "${bootstrapId}"` });
      setAddOpen(false);
      loadEntries();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Add failed', description: e.message });
    } finally {
      setBootstrapSubmitting(false);
    }
  }

  async function copyBootstrap() {
    try {
      await navigator.clipboard.writeText(bootstrapScript);
      setScriptCopied(true);
      setTimeout(() => setScriptCopied(false), 2000);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Clipboard write failed', description: e.message });
    }
  }

  async function handlePasteSubmit() {
    if (!pasteForm.id || !pasteForm.unix_user || !pasteForm.public_key) {
      toast({ variant: 'destructive', title: 'id, unix user, and public key are required' });
      return;
    }
    setAdding(true);
    try {
      await api.addSshAccess({
        id: pasteForm.id,
        unix_user: pasteForm.unix_user,
        public_key: pasteForm.public_key,
        label: pasteForm.label || null,
      });
      toast({ title: `Added "${pasteForm.id}"` });
      setAddOpen(false);
      loadEntries();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Add failed', description: e.message });
    } finally {
      setAdding(false);
    }
  }

  function openRevoke(row) {
    setRevokeRow(row);
    setRevokeReason('');
    setRevokeWarning(null);
    setRevokePhrase('');
  }

  async function handleRevoke(force = false) {
    if (!revokeRow) return;
    setRevoking(true);
    try {
      await api.revokeSshAccess(revokeRow.id, {
        reason: revokeReason || null,
        force,
      });
      toast({ title: `Revoked "${revokeRow.id}"` });
      setRevokeRow(null);
      loadEntries();
    } catch (e) {
      // 409 with WOULD_STRAND surfaces here as ApiError with `code` set.
      if (e instanceof ApiError && e.status === 409 && e.code === 'WOULD_STRAND') {
        setRevokeWarning({
          message: e.message || 'This revoke would strand the unix user.',
          fallbacks: e.fallbacks || [],
          remaining_managed: e.remaining_managed ?? 0,
          unix_user: e.unix_user,
        });
      } else {
        toast({ variant: 'destructive', title: 'Revoke failed', description: e.message });
      }
    } finally {
      setRevoking(false);
    }
  }

  const filteredEntries = useMemo(() => {
    return entries.filter(e => {
      if (userFilter && !e.unix_user.includes(userFilter)) return false;
      if (labelFilter && !(e.device_label || '').toLowerCase().includes(labelFilter.toLowerCase())) return false;
      return true;
    });
  }, [entries, userFilter, labelFilter]);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" /> SSH Access
            </CardTitle>
            <CardDescription>
              Per-device authorized_keys ledger. Add a device, copy the bootstrap script,
              run it on the device, then paste the resulting <code>proxypilot ssh access add</code>
              heredoc back into a server shell. The private key never leaves the device.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleReconcile} disabled={reconciling}>
              {reconciling ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Reconcile
            </Button>
            <Button onClick={openAdd}>+ Add device</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <Tabs value={filter} onValueChange={setFilter}>
              <TabsList>
                <TabsTrigger value="active">Active</TabsTrigger>
                <TabsTrigger value="revoked">Revoked</TabsTrigger>
                <TabsTrigger value="all">All</TabsTrigger>
              </TabsList>
            </Tabs>
            <Input
              placeholder="filter by unix user"
              value={userFilter}
              onChange={e => setUserFilter(e.target.value)}
              className="w-48"
            />
            <Input
              placeholder="filter by label"
              value={labelFilter}
              onChange={e => setLabelFilter(e.target.value)}
              className="w-56"
            />
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : filteredEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No entries.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-3">ID</th>
                    <th className="py-2 pr-3">User</th>
                    <th className="py-2 pr-3">Label</th>
                    <th className="py-2 pr-3" title="SHA256 fingerprint of the registered public key">Fingerprint</th>
                    <th className="py-2 pr-3">Added</th>
                    <th className="py-2 pr-3">By</th>
                    <th
                      className="py-2 pr-3"
                      title="Best-effort, parsed from `last`. Shows the most recent login per unix user — not per key. Updates every 5 min and on dashboard load."
                    >
                      Last seen
                    </th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map(row => (
                    <tr key={row.id} className="border-b last:border-b-0">
                      <td className="py-2 pr-3 font-mono">{row.id}</td>
                      <td className="py-2 pr-3">{row.unix_user}</td>
                      <td className="py-2 pr-3">{row.device_label || '—'}</td>
                      <td className="py-2 pr-3 font-mono text-xs" title={row.fingerprint}>{shortFp(row.fingerprint)}</td>
                      <td className="py-2 pr-3" title={row.added_at}>{fmtRelative(row.added_at)}</td>
                      <td className="py-2 pr-3">{row.added_by || '—'}</td>
                      <td className="py-2 pr-3" title={row.last_seen_at || 'never observed'}>{fmtRelative(row.last_seen_at)}</td>
                      <td className="py-2 pr-3">
                        {row.revoked_at
                          ? <span className="inline-flex items-center gap-1 text-amber-600"><ShieldOff className="h-3 w-3" /> revoked</span>
                          : <span className="text-emerald-600">active</span>}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {!row.revoked_at && (
                          <Button size="sm" variant="outline" onClick={() => openRevoke(row)}>
                            <Trash2 className="h-3.5 w-3.5 mr-1" /> Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add device modal */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-[95vw] max-h-[90vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader>
            <DialogTitle>Add device</DialogTitle>
            <DialogDescription>
              Generate a bootstrap script the operator runs on the new device, or paste a public key
              they've already generated.
            </DialogDescription>
          </DialogHeader>

          <Tabs value={addTab} onValueChange={setAddTab}>
            <TabsList>
              <TabsTrigger value="bootstrap">Bootstrap script</TabsTrigger>
              <TabsTrigger value="paste">Paste public key</TabsTrigger>
            </TabsList>

            {addTab === 'bootstrap' && (
              <div className="space-y-3 mt-4">
                <div className="grid grid-cols-4 gap-3">
                  <div>
                    <Label htmlFor="bs-id">id</Label>
                    <Input id="bs-id" value={bootstrapId} onChange={e => setBootstrapId(e.target.value)} placeholder="alice-laptop" />
                  </div>
                  <div>
                    <Label htmlFor="bs-user">unix user</Label>
                    <Input id="bs-user" value={bootstrapUser} onChange={e => setBootstrapUser(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="bs-server">server</Label>
                    <Input id="bs-server" value={bootstrapServer} onChange={e => setBootstrapServer(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="bs-shell">shell</Label>
                    <select
                      id="bs-shell"
                      value={bootstrapShell}
                      onChange={e => setBootstrapShell(e.target.value)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="bash">bash / zsh (Linux/macOS/WSL/git-bash)</option>
                      <option value="powershell">PowerShell (Windows)</option>
                    </select>
                  </div>
                </div>
                <Button onClick={handleGenerateBootstrap} disabled={bootstrapLoading || !bootstrapId}>
                  {bootstrapLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Generate
                </Button>
                {bootstrapScript && (
                  <>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {bootstrapShell === 'powershell'
                          ? 'Copy this snippet and run it in PowerShell on the device (5.1 or 7+). Save it as a .ps1 if your execution policy blocks paste-and-run. It generates a keypair locally and prints the public key + the proxypilot ssh access add command to paste back here.'
                          : 'Copy this snippet and run it on the device (bash/zsh, including git-bash on Windows). It generates a keypair locally and prints the public key + the proxypilot ssh access add command to paste back here.'}
                      </p>
                      <Button size="sm" variant="ghost" onClick={copyBootstrap}>
                        {scriptCopied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
                        {scriptCopied ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <pre className="bg-muted p-3 rounded text-xs overflow-auto max-h-[55vh] max-w-full min-w-0 whitespace-pre">{bootstrapScript}</pre>

                    <div className="space-y-2 rounded border border-dashed p-3">
                      <p className="text-xs text-muted-foreground">
                        After running the script on the device, copy the <code>ssh-...</code>{' '}
                        public key line it printed and paste it here. Hit Submit to register the
                        device under <code>{bootstrapId}</code> for unix user{' '}
                        <code>{bootstrapUser}</code>.
                      </p>
                      <div>
                        <Label htmlFor="bs-label">label (optional)</Label>
                        <Input
                          id="bs-label"
                          value={bootstrapLabel}
                          onChange={e => setBootstrapLabel(e.target.value)}
                          placeholder="Alice's MacBook Pro"
                        />
                      </div>
                      <div>
                        <Label htmlFor="bs-pubkey">public key</Label>
                        <textarea
                          id="bs-pubkey"
                          className="w-full h-24 rounded border bg-background p-2 font-mono text-xs"
                          value={bootstrapPubkey}
                          onChange={e => setBootstrapPubkey(e.target.value)}
                          placeholder="ssh-ed25519 AAAAC3Nza... proxypilot:device@host"
                        />
                      </div>
                      <Button
                        onClick={handleBootstrapSubmit}
                        disabled={bootstrapSubmitting || !bootstrapPubkey.trim()}
                      >
                        {bootstrapSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                        Submit public key
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}

            {addTab === 'paste' && (
              <div className="space-y-3 mt-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="p-id">id</Label>
                    <Input id="p-id" value={pasteForm.id} onChange={e => setPasteForm({ ...pasteForm, id: e.target.value })} placeholder="alice-laptop" />
                  </div>
                  <div>
                    <Label htmlFor="p-user">unix user</Label>
                    <Input id="p-user" value={pasteForm.unix_user} onChange={e => setPasteForm({ ...pasteForm, unix_user: e.target.value })} />
                  </div>
                </div>
                <div>
                  <Label htmlFor="p-label">label (optional)</Label>
                  <Input id="p-label" value={pasteForm.label} onChange={e => setPasteForm({ ...pasteForm, label: e.target.value })} placeholder="Alice's MacBook Pro" />
                </div>
                <div>
                  <Label htmlFor="p-key">public key</Label>
                  <textarea
                    id="p-key"
                    className="w-full h-28 rounded border bg-background p-2 font-mono text-xs"
                    value={pasteForm.public_key}
                    onChange={e => setPasteForm({ ...pasteForm, public_key: e.target.value })}
                    placeholder="ssh-ed25519 AAAAC3Nza... user@host"
                  />
                </div>
                <Button onClick={handlePasteSubmit} disabled={adding}>
                  {adding ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Add
                </Button>
              </div>
            )}
          </Tabs>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke modal */}
      <Dialog open={!!revokeRow} onOpenChange={(o) => { if (!o) setRevokeRow(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke "{revokeRow?.id}"?</DialogTitle>
            <DialogDescription>
              Drops the line from <code>{revokeRow?.unix_user}</code>'s <code>authorized_keys</code> on the next reconcile.
              Existing SSH sessions stay alive — sshd consults <code>authorized_keys</code> at connect time only.
            </DialogDescription>
          </DialogHeader>
          {!revokeWarning && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="rev-reason">reason (optional)</Label>
                <Input id="rev-reason" value={revokeReason} onChange={e => setRevokeReason(e.target.value)} placeholder="lost device" />
              </div>
            </div>
          )}
          {revokeWarning && (
            <div className="space-y-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="font-semibold text-amber-700 dark:text-amber-400">
                ⚠ This would strand unix user "{revokeWarning.unix_user}".
              </p>
              <p className="text-xs">
                There are no operator-added authorized_keys lines and {revokeWarning.remaining_managed} other managed entr{revokeWarning.remaining_managed === 1 ? 'y' : 'ies'} will remain.
                Make sure you have console access or a sealed recovery key before proceeding.
              </p>
              <div>
                <Label htmlFor="rev-phrase">type to confirm: <code>{TYPED_PHRASE}</code></Label>
                <Input
                  id="rev-phrase"
                  value={revokePhrase}
                  onChange={e => setRevokePhrase(e.target.value)}
                  placeholder={TYPED_PHRASE}
                  className="font-mono"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeRow(null)}>Cancel</Button>
            {!revokeWarning && (
              <Button variant="destructive" onClick={() => handleRevoke(false)} disabled={revoking}>
                {revoking ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Revoke
              </Button>
            )}
            {revokeWarning && (
              <Button
                variant="destructive"
                disabled={revoking || revokePhrase !== TYPED_PHRASE}
                onClick={() => handleRevoke(true)}
              >
                {revoking ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Force revoke
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
