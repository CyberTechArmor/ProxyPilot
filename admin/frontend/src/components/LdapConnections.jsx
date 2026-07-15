import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  Loader2, Plus, Trash2, Pencil, PlugZap, RefreshCw,
  CheckCircle2, XCircle, ShieldAlert, Network,
} from 'lucide-react';

const DEFAULT_USER_FILTER = '(|(uid={username})(sAMAccountName={username}))';

const emptyForm = {
  name: '',
  host: '',
  port: 636,
  bindDn: '',
  bindPassword: '',
  baseDn: '',
  userFilter: DEFAULT_USER_FILTER,
  tlsVerify: true,
  caCert: '',
  enabled: true,
};

// LDAPS directory connections tab on the Users page. Users who
// authenticate through a connection here are created automatically
// with no role — an admin assigns one from the Users tab afterwards.
export default function LdapConnections() {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null); // connection being edited, or null for create
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const { toast } = useToast();

  const fetchConnections = async () => {
    setLoading(true);
    try {
      const result = await api.getLdapConnections();
      setConnections(result.connections || []);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load LDAPS connections: ' + error.message,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (conn) => {
    setEditing(conn);
    setForm({
      name: conn.name,
      host: conn.host,
      port: conn.port,
      bindDn: conn.bindDn || '',
      bindPassword: '', // write-only; empty = keep stored password
      baseDn: conn.baseDn,
      userFilter: conn.userFilter || DEFAULT_USER_FILTER,
      tlsVerify: conn.tlsVerify,
      caCert: '', // write-only; leave untouched unless retyped
      enabled: conn.enabled,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.host.trim() || !form.baseDn.trim()) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Name, host, and base DN are required',
      });
      return;
    }
    if (!form.userFilter.includes('{username}')) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'The user filter must contain the {username} placeholder',
      });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 636,
        bindDn: form.bindDn.trim() || undefined,
        bindPassword: form.bindPassword || undefined,
        baseDn: form.baseDn.trim(),
        userFilter: form.userFilter.trim(),
        tlsVerify: form.tlsVerify,
        // Empty CA field means "keep stored" on edit — only sent when
        // the operator pasted something.
        caCert: form.caCert || undefined,
        enabled: form.enabled,
      };
      if (editing) {
        await api.updateLdapConnection(editing.id, payload);
      } else {
        await api.createLdapConnection(payload);
      }
      toast({
        title: 'Success',
        description: editing ? 'Connection updated' : 'Connection saved',
      });
      setDialogOpen(false);
      fetchConnections();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (conn) => {
    setTestingId(conn.id);
    try {
      const result = await api.testLdapConnection(conn.id);
      if (result.success) {
        toast({ title: 'Connection OK', description: `${conn.name}: bind + base DN lookup succeeded` });
      } else {
        toast({
          variant: 'destructive',
          title: 'Connection failed',
          description: result.error || 'Unknown error',
        });
      }
      fetchConnections();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteLdapConnection(deleteTarget.id);
      toast({ title: 'Success', description: 'Connection deleted' });
      setDeleteTarget(null);
      fetchConnections();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Network className="h-5 w-5" />
                LDAPS Connections
              </CardTitle>
              <CardDescription>
                Directory users sign in with their LDAP credentials. New accounts start with
                no role — assign one from the Users tab after their first login.
              </CardDescription>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={fetchConnections} disabled={loading}>
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
              <Button size="sm" className="h-11 sm:h-9" onClick={openCreate}>
                <Plus className="h-4 w-4 mr-2" />
                Add Connection
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : connections.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No LDAPS connections configured yet
            </p>
          ) : (
            <div className="space-y-2">
              {connections.map((conn) => (
                <div key={conn.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border rounded-lg">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-lg truncate">{conn.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        conn.enabled
                          ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                      }`}>
                        {conn.enabled ? 'enabled' : 'disabled'}
                      </span>
                      {!conn.tlsVerify && (
                        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                          <ShieldAlert className="h-3 w-3" /> TLS verify off
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-sm text-muted-foreground">
                      <span className="font-mono">ldaps://{conn.host}:{conn.port}</span>
                      <span className="truncate">Base: {conn.baseDn}</span>
                      {conn.lastTestStatus === 'ok' && (
                        <span className="flex items-center gap-1 text-green-500">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Test OK{conn.lastTestAt ? ` (${new Date(conn.lastTestAt).toLocaleString()})` : ''}
                        </span>
                      )}
                      {conn.lastTestStatus === 'fail' && (
                        <span className="flex items-center gap-1 text-red-500" title={conn.lastTestError || ''}>
                          <XCircle className="h-3.5 w-3.5" />
                          Test failed
                        </span>
                      )}
                    </div>
                    {conn.lastTestStatus === 'fail' && conn.lastTestError && (
                      <p className="mt-1 text-xs text-red-500 break-all">{conn.lastTestError}</p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-11 w-11 sm:h-9 sm:w-9 p-0"
                      onClick={() => handleTest(conn)}
                      disabled={testingId === conn.id}
                      title="Test connection"
                    >
                      {testingId === conn.id
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <PlugZap className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-11 w-11 sm:h-9 sm:w-9 p-0"
                      onClick={() => openEdit(conn)}
                      title="Edit connection"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-11 w-11 sm:h-9 sm:w-9 p-0"
                      onClick={() => setDeleteTarget(conn)}
                      title="Delete connection"
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create / Edit Connection Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-2xl sm:h-auto sm:max-h-[90vh] sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit LDAPS Connection' : 'Add LDAPS Connection'}</DialogTitle>
            <DialogDescription>
              Connections always use LDAP over TLS (ldaps://). Users are looked up with the
              service account, then verified by binding as their own entry.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ldap-name">Name</Label>
                <Input
                  id="ldap-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Corporate AD"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 space-y-2">
                  <Label htmlFor="ldap-host">Host</Label>
                  <Input
                    id="ldap-host"
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                    placeholder="dc01.example.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ldap-port">Port</Label>
                  <Input
                    id="ldap-port"
                    type="number"
                    inputMode="numeric"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                    placeholder="636"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ldap-bind-dn">Bind DN (service account)</Label>
                <Input
                  id="ldap-bind-dn"
                  value={form.bindDn}
                  onChange={(e) => setForm({ ...form, bindDn: e.target.value })}
                  placeholder="cn=svc-proxypilot,ou=services,dc=example,dc=com"
                />
                <p className="text-xs text-muted-foreground">Leave blank for anonymous lookup.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ldap-bind-password">Bind Password</Label>
                <Input
                  id="ldap-bind-password"
                  type="password"
                  autoComplete="new-password"
                  value={form.bindPassword}
                  onChange={(e) => setForm({ ...form, bindPassword: e.target.value })}
                  placeholder={editing && editing.hasBindPassword ? '•••••• (unchanged)' : ''}
                />
                {editing && (
                  <p className="text-xs text-muted-foreground">Leave blank to keep the stored password.</p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ldap-base-dn">Base DN</Label>
              <Input
                id="ldap-base-dn"
                value={form.baseDn}
                onChange={(e) => setForm({ ...form, baseDn: e.target.value })}
                placeholder="ou=people,dc=example,dc=com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ldap-user-filter">User Filter</Label>
              <Input
                id="ldap-user-filter"
                className="font-mono"
                value={form.userFilter}
                onChange={(e) => setForm({ ...form, userFilter: e.target.value })}
                placeholder={DEFAULT_USER_FILTER}
              />
              <p className="text-xs text-muted-foreground">
                {'{username}'} is replaced with the login name (special characters are escaped).
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ldap-ca-cert">CA Certificate (PEM, optional)</Label>
              <textarea
                id="ldap-ca-cert"
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={form.caCert}
                onChange={(e) => setForm({ ...form, caCert: e.target.value })}
                placeholder={editing && editing.hasCaCert
                  ? '(stored CA kept — paste to replace)'
                  : '-----BEGIN CERTIFICATE-----'}
              />
              <p className="text-xs text-muted-foreground">
                Needed when the directory uses a private CA.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="ldap-tls-verify"
                  checked={form.tlsVerify}
                  onCheckedChange={(checked) => setForm({ ...form, tlsVerify: checked })}
                />
                <Label htmlFor="ldap-tls-verify">Verify TLS certificate</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="ldap-enabled"
                  checked={form.enabled}
                  onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
                />
                <Label htmlFor="ldap-enabled">Enabled</Label>
              </div>
            </div>
            {!form.tlsVerify && (
              <p className="flex items-center gap-1 text-xs text-amber-500">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                Disabling certificate verification allows man-in-the-middle attacks. Lab use only.
              </p>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>
              ) : (
                editing ? 'Save Changes' : 'Save Connection'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Connection Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Delete LDAPS Connection</DialogTitle>
            <DialogDescription>
              Delete <strong>{deleteTarget?.name}</strong>? Directory users will no longer be
              able to sign in through it. Already-provisioned accounts are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Deleting...</>
              ) : (
                'Delete Connection'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
