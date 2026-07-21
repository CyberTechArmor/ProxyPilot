import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Shield, Users, UserPlus, Trash2, RefreshCw, Copy, Check, Settings, Eye, Edit3, Folder, Network, UserCog, Coins } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import LdapConnections from '@/components/LdapConnections';

// Per-user AI-usage drill-down (admin): totals, per-project spend with a
// per-step breakdown, and VS Code (external push) activity. Data comes from
// the mock2 spend ledger; a host without the Projects module 404s and the
// dialog says so instead of guessing.
function AiUsageDialog({ user, open, onOpenChange }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open || !user) return;
    setData(null);
    setErr('');
    api.mock2UserAiUsage(user.id)
      .then(setData)
      .catch((e) => setErr(e?.message || 'Could not load AI usage (is the Projects module enabled on this host?)'));
  }, [open, user]);
  const dollars = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-2xl sm:h-auto sm:max-h-[90vh] sm:rounded-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coins className="h-4 w-4" /> AI usage — {user?.username}
          </DialogTitle>
          <DialogDescription>
            All AI credits this user has spent, by project and step, plus their VS Code push activity.
          </DialogDescription>
        </DialogHeader>
        {err ? (
          <p className="text-sm text-muted-foreground">{err}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Total spend</p>
                <p className="text-lg font-semibold tabular-nums">{dollars(data.totals?.cents)}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Model calls</p>
                <p className="text-lg font-semibold tabular-nums">{Number(data.totals?.calls || 0).toLocaleString()}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Tokens (in+out)</p>
                <p className="text-lg font-semibold tabular-nums">{Number(data.totals?.tokens || 0).toLocaleString()}</p>
              </div>
            </div>
            <div>
              <p className="mb-1 text-sm font-medium">By project (in-platform AI spend)</p>
              {data.projects?.length ? (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full border-collapse text-xs sm:text-sm">
                    <thead>
                      <tr>
                        <th className="border-b bg-muted/50 px-2 py-1.5 text-left font-medium">Project</th>
                        <th className="border-b bg-muted/50 px-2 py-1.5 text-right font-medium">Spend</th>
                        <th className="border-b bg-muted/50 px-2 py-1.5 text-right font-medium">Calls</th>
                        <th className="border-b bg-muted/50 px-2 py-1.5 text-right font-medium">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.projects.map((row) => (
                        <tr key={row.project_id}>
                          <td className="border-b px-2 py-1.5 align-top">
                            <span className="font-medium">{row.name || `project ${row.project_id}`}</span>
                            {row.steps?.length ? (
                              <span className="block text-[11px] text-muted-foreground">
                                {row.steps.slice(0, 4).map((s) => `${s.step} ${dollars(s.cents)}`).join(' · ')}
                                {row.steps.length > 4 ? ` · +${row.steps.length - 4} more` : ''}
                              </span>
                            ) : null}
                          </td>
                          <td className="border-b px-2 py-1.5 text-right tabular-nums align-top">{dollars(row.cents)}</td>
                          <td className="border-b px-2 py-1.5 text-right tabular-nums align-top">{Number(row.calls).toLocaleString()}</td>
                          <td className="border-b px-2 py-1.5 text-right tabular-nums align-top">{Number(row.tokens).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-sm text-muted-foreground">No AI spend attributed to this user yet.</p>}
            </div>
            <div>
              <p className="mb-1 text-sm font-medium">Through VS Code (external git pushes)</p>
              {data.vscode?.projects?.length ? (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full border-collapse text-xs sm:text-sm">
                    <thead>
                      <tr>
                        <th className="border-b bg-muted/50 px-2 py-1.5 text-left font-medium">Project</th>
                        <th className="border-b bg-muted/50 px-2 py-1.5 text-right font-medium">Pushes</th>
                        <th className="border-b bg-muted/50 px-2 py-1.5 text-right font-medium">Last push</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.vscode.projects.map((row) => (
                        <tr key={row.project_id}>
                          <td className="border-b px-2 py-1.5">{row.name || `project ${row.project_id}`}</td>
                          <td className="border-b px-2 py-1.5 text-right tabular-nums">{row.pushes}</td>
                          <td className="border-b px-2 py-1.5 text-right">{row.last_at ? new Date(row.last_at).toLocaleDateString() : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-sm text-muted-foreground">No external pushes by this user.</p>}
              {data.note ? <p className="mt-1 text-[11px] text-muted-foreground">{data.note}</p> : null}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function UsersPage() {
  const [aiUsageUser, setAiUsageUser] = useState(null);
  const { user: authUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [services, setServices] = useState([]);
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [createdUser, setCreatedUser] = useState(null);
  const [newUserForm, setNewUserForm] = useState({ username: '', displayName: '', role: 'user' });
  const [deleteUserOpen, setDeleteUserOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState(null);
  const [deletingUser, setDeletingUser] = useState(false);
  const [roleDialogUser, setRoleDialogUser] = useState(null);
  const [roleToAssign, setRoleToAssign] = useState('user');
  const [assigningRole, setAssigningRole] = useState(false);
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [userAccess, setUserAccess] = useState([]);
  const [userFolderAccess, setUserFolderAccess] = useState([]);
  const [userPermissions, setUserPermissions] = useState([]);
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [savingAccess, setSavingAccess] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [accessTab, setAccessTab] = useState('services'); // 'services' | 'folders' | 'projects'
  // Mock2 projects the user can be a member of: [{ projectId, name, url,
  // role: 'none'|'viewer'|'editor', originalRole }] — null when the Projects
  // module is off/unavailable (tab hidden).
  const [userProjects, setUserProjects] = useState(null);
  const [serviceFolders, setServiceFolders] = useState(() => {
    const saved = localStorage.getItem('serviceFolders');
    return saved ? JSON.parse(saved) : {};
  });

  const { toast } = useToast();

  const isAdmin = authUser?.role === 'admin' || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';

  useEffect(() => {
    if (isAdmin) {
      fetchUsers();
    }
  }, [isAdmin]);

  const fetchUsers = async () => {
    setLoadingUsers(true);
    try {
      const [usersRes, servicesRes] = await Promise.all([
        api.getUsers(),
        api.getServices(),
      ]);
      setUsers(usersRes.users || []);
      setServices(servicesRes.services || []);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load users: ' + error.message,
      });
    } finally {
      setLoadingUsers(false);
    }
  };

  const handleCreateUser = async () => {
    if (!newUserForm.username || newUserForm.username.length < 3) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Username must be at least 3 characters',
      });
      return;
    }

    setCreatingUser(true);
    try {
      const result = await api.createUser(newUserForm);
      // Prefer the one-time sign-in link over reading out a generated
      // password: the user opens it, chooses their OWN password, then the
      // normal first-login TOTP enrollment runs. Fall back to showing the
      // generated password only if the link could not be issued.
      let link = null;
      try {
        const l = await api.createUserLoginLink(result.user.id);
        link = { url: window.location.origin + l.path, expiresAt: l.expiresAt };
      } catch { /* fall back to the password display */ }
      setCreatedUser({ ...result.user, link });
      fetchUsers();
      toast({
        title: 'Success',
        description: 'User created successfully',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setCreatingUser(false);
    }
  };

  // Deletion is protected by the sudo gate — if the grant is stale the
  // global sudo modal prompts for password+TOTP (or passkey) and the
  // request is replayed automatically. No per-dialog TOTP entry.
  const handleDeleteUser = async () => {
    if (!userToDelete) return;

    setDeletingUser(true);
    try {
      await api.deleteUser(userToDelete.id);
      toast({
        title: 'Success',
        description: 'User deleted successfully',
      });
      setDeleteUserOpen(false);
      setUserToDelete(null);
      fetchUsers();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setDeletingUser(false);
    }
  };

  const openRoleDialog = (user) => {
    setRoleDialogUser(user);
    setRoleToAssign(user.role === 'pending' ? 'user' : user.role);
  };

  const handleAssignRole = async () => {
    if (!roleDialogUser) return;
    setAssigningRole(true);
    try {
      await api.updateUser(roleDialogUser.id, { role: roleToAssign });
      toast({
        title: 'Success',
        description: `Role "${roleToAssign}" assigned to ${roleDialogUser.username}`,
      });
      setRoleDialogUser(null);
      fetchUsers();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setAssigningRole(false);
    }
  };

  const openAccessDialog = async (user) => {
    setSelectedUser(user);
    setAccessDialogOpen(true);
    setLoadingAccess(true);
    setAccessTab('services');

    try {
      // Projects (Mock2) memberships ride alongside services — best-effort so
      // an install with the module off just hides the tab.
      setUserProjects(null);
      if (user.role !== 'admin') {
        Promise.all([api.mock2ListProjects(), api.mock2UserMemberships(user.id)])
          .then(([pl, ml]) => {
            const roleByProject = new Map((ml.memberships || []).map((m) => [m.project_id, m.role]));
            setUserProjects((pl.projects || []).map((p) => {
              const role = roleByProject.get(p.id) || 'none';
              return { projectId: p.id, name: p.name, url: p.url || null, role, originalRole: role };
            }));
          })
          .catch(() => setUserProjects(null));
      }

      const result = await api.getUserAccess(user.id);
      if (result.isAdmin) {
        setUserAccess([]);
        setUserFolderAccess([]);
        setUserPermissions([]);
      } else {
        setUserPermissions(result.permissions || []);
        // Service access
        const accessMap = {};
        result.access.forEach(a => {
          accessMap[a.serviceId] = { canView: a.canView, canWrite: a.canWrite };
        });
        setUserAccess(services.map(s => ({
          serviceId: s.id,
          serviceName: s.name,
          domain: s.domain,
          canView: accessMap[s.id]?.canView || false,
          canWrite: accessMap[s.id]?.canWrite || false,
        })));

        // Folder access
        const folderAccessMap = {};
        (result.folderAccess || []).forEach(f => {
          folderAccessMap[f.folderPath] = { canView: f.canView, canWrite: f.canWrite };
        });
        setUserFolderAccess(Object.entries(serviceFolders).map(([path, folder]) => ({
          folderPath: path,
          folderName: folder.name,
          serviceCount: folder.services?.length || 0,
          canView: folderAccessMap[path]?.canView || false,
          canWrite: folderAccessMap[path]?.canWrite || false,
        })));
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setLoadingAccess(false);
    }
  };

  const handleSaveAccess = async () => {
    if (!selectedUser) return;

    setSavingAccess(true);
    try {
      // Project membership changes: only rows the admin actually touched.
      const projectOps = (userProjects || [])
        .filter((p) => p.role !== p.originalRole)
        .map((p) => (p.role === 'none'
          ? api.mock2RemoveProjectMember(p.projectId, selectedUser.id)
          : api.mock2SetProjectMember(p.projectId, { user_id: String(selectedUser.id), role: p.role })));
      // Save service access, folder access, feature permissions, and projects
      await Promise.all([
        api.updateUserAccess(selectedUser.id, userAccess.map(a => ({
          serviceId: a.serviceId,
          canView: a.canView,
          canWrite: a.canWrite,
        }))),
        api.updateUserFolderAccess(selectedUser.id, userFolderAccess.map(f => ({
          folderPath: f.folderPath,
          canView: f.canView,
          canWrite: f.canWrite,
        }))),
        api.updateUserPermissions(selectedUser.id, userPermissions),
        ...projectOps,
      ]);
      toast({
        title: 'Success',
        description: 'User access updated — changes are live immediately',
      });
      setAccessDialogOpen(false);
      fetchUsers();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSavingAccess(false);
    }
  };

  const togglePermission = (permission, granted) => {
    setUserPermissions((prev) => granted
      ? [...new Set([...prev, permission])]
      : prev.filter((p) => p !== permission));
  };

  const copyPassword = (password) => {
    navigator.clipboard.writeText(password);
    setCopiedPassword(true);
    setTimeout(() => setCopiedPassword(false), 2000);
  };

  const handleResetPassword = async (userId) => {
    try {
      // Reset = issue a fresh one-time sign-in link. The user's old password
      // keeps working until they use the link (so a reset can never lock an
      // account); local accounts only. Falls back to a generated password if
      // the link can't be issued (e.g. LDAP account).
      try {
        const l = await api.createUserLoginLink(userId);
        setCreatedUser({ ...users.find(u => u.id === userId), link: { url: window.location.origin + l.path, expiresAt: l.expiresAt } });
        setCreateUserOpen(true);
        toast({
          title: 'Sign-in link ready',
          description: 'Send it to the user — they will choose a new password.',
        });
        return;
      } catch { /* fall through to the password reset */ }
      const result = await api.updateUser(userId, { resetPassword: true });
      if (result.newPassword) {
        setCreatedUser({ ...users.find(u => u.id === userId), password: result.newPassword });
        setCreateUserOpen(true);
        toast({
          title: 'Password Reset',
          description: 'New password generated. Please save it now.',
        });
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    }
  };

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">User Management</h1>
        <p className="text-muted-foreground">
          Create and manage user accounts with granular service access
        </p>
      </div>

      <Tabs defaultValue="users">
        <TabsList className="grid w-full grid-cols-2 sm:inline-grid sm:w-auto">
          <TabsTrigger value="users" className="min-h-[44px] sm:min-h-0 gap-2">
            <Users className="h-4 w-4" />
            Users
          </TabsTrigger>
          <TabsTrigger value="ldaps" className="min-h-[44px] sm:min-h-0 gap-2">
            <Network className="h-4 w-4" />
            LDAPS
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Users
              </CardTitle>
              <CardDescription>
                {users.length} user{users.length !== 1 ? 's' : ''} registered
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={fetchUsers} disabled={loadingUsers}>
                <RefreshCw className={`h-4 w-4 ${loadingUsers ? 'animate-spin' : ''}`} />
              </Button>
              <Button size="sm" onClick={() => {
                setCreateUserOpen(true);
                setCreatedUser(null);
                setNewUserForm({ username: '', displayName: '', role: 'user' });
              }}>
                <UserPlus className="h-4 w-4 mr-2" />
                Add User
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadingUsers ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : users.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No users found</p>
          ) : (
            <div className="space-y-2">
              {users.map((user) => (
                <div key={user.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border rounded-lg">
                  {/* The identity block opens the AI-usage drill-down (the
                      coins button is the discoverable affordance). */}
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    role="button"
                    tabIndex={0}
                    onClick={() => setAiUsageUser(user)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setAiUsageUser(user); }}
                    title="View AI usage"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-lg">{user.username}</span>
                      {user.displayName && (
                        <span className="text-sm text-muted-foreground">({user.displayName})</span>
                      )}
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        user.role === 'admin'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                          : user.role === 'pending'
                            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300'
                            : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                      }`}>
                        {user.role === 'pending' ? 'no role assigned' : user.role}
                      </span>
                      {user.authSource === 'ldap' && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300">
                          LDAP
                        </span>
                      )}
                      {(user.permissions || []).map((perm) => (
                        <span key={perm} className="text-xs px-2 py-0.5 rounded-full bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300">
                          {perm}
                        </span>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-sm text-muted-foreground">
                      <span className={user.totpEnabled ? 'text-green-500' : 'text-yellow-500'}>
                        TOTP: {user.totpEnabled ? 'Enabled' : 'Not Set'}
                      </span>
                      {user.passwordChangeRequired && (
                        <span className="text-orange-500">Password change required</span>
                      )}
                      <span>Created: {new Date(user.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-11 w-11 sm:h-9 sm:w-9 p-0"
                      onClick={() => setAiUsageUser(user)}
                      title="AI usage — credits by project, and VS Code activity"
                    >
                      <Coins className="h-4 w-4" />
                    </Button>
                    {user.role === 'pending' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-11 sm:h-9"
                        onClick={() => openRoleDialog(user)}
                      >
                        <UserCog className="h-4 w-4 mr-2" />
                        Assign Role
                      </Button>
                    )}
                    {user.role !== 'admin' && user.role !== 'pending' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 w-11 sm:h-9 sm:w-9 p-0"
                        onClick={() => openAccessDialog(user)}
                        title="Manage service access"
                      >
                        <Settings className="h-4 w-4" />
                      </Button>
                    )}
                    {user.authSource !== 'ldap' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 w-11 sm:h-9 sm:w-9 p-0"
                        onClick={() => handleResetPassword(user.id)}
                        title="Reset password"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-11 w-11 sm:h-9 sm:w-9 p-0"
                      onClick={() => {
                        setUserToDelete(user);
                        setDeleteUserOpen(true);
                      }}
                      disabled={user.id === authUser?.id}
                      title="Delete user"
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
        </TabsContent>

        <TabsContent value="ldaps" className="mt-4">
          <LdapConnections />
        </TabsContent>
      </Tabs>

      {/* Create User Dialog */}
      <Dialog open={createUserOpen} onOpenChange={setCreateUserOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>
              {createdUser ? 'User Created' : 'Create New User'}
            </DialogTitle>
            <DialogDescription>
              {createdUser
                ? (createdUser.link
                  ? 'Send the one-time sign-in link to the user — no password to read out.'
                  : 'Save the generated password - it will only be shown once!')
                : 'Create a new user account — you get a one-time sign-in link to send them'}
            </DialogDescription>
          </DialogHeader>

          {createdUser ? (
            <div className="space-y-4">
              <div className="p-4 bg-muted rounded-lg space-y-3">
                <div>
                  <Label className="text-muted-foreground">Username</Label>
                  <p className="font-medium">{createdUser.username}</p>
                </div>
                {createdUser.link ? (
                  <div>
                    <Label className="text-muted-foreground">One-time sign-in link</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="flex-1 bg-background p-2 rounded border font-mono text-xs break-all">
                        {createdUser.link.url}
                      </code>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyPassword(createdUser.link.url)}
                      >
                        {copiedPassword ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Send it by chat, email, or SMS. The user opens it, chooses their own
                      password, and sets up TOTP at first sign-in. Valid 7 days or until used —
                      link previews can&apos;t consume it, and it dies the moment the password is set.
                    </p>
                  </div>
                ) : (
                  <div>
                    <Label className="text-muted-foreground">Generated Password</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="flex-1 bg-background p-2 rounded border font-mono text-sm break-all">
                        {createdUser.password}
                      </code>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyPassword(createdUser.password)}
                      >
                        {copiedPassword ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-sm text-yellow-600">
                      The user will be prompted to change this password and set up TOTP on first login.
                    </p>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button onClick={() => setCreateUserOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Username</Label>
                <Input
                  value={newUserForm.username}
                  onChange={(e) => setNewUserForm({ ...newUserForm, username: e.target.value })}
                  placeholder="Enter username"
                />
              </div>
              <div className="space-y-2">
                <Label>Display Name (optional)</Label>
                <Input
                  value={newUserForm.displayName}
                  onChange={(e) => setNewUserForm({ ...newUserForm, displayName: e.target.value })}
                  placeholder="Enter display name"
                />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select
                  value={newUserForm.role}
                  onValueChange={(value) => setNewUserForm({ ...newUserForm, role: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">User (Limited Access)</SelectItem>
                    <SelectItem value="admin">Admin (Full Access)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Users require specific service access. Admins have full access to all services.
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateUserOpen(false)}>Cancel</Button>
                <Button onClick={handleCreateUser} disabled={creatingUser}>
                  {creatingUser ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating...</>
                  ) : (
                    'Create User'
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete User Dialog. Sudo-gated server-side — if the sudo grant
          is stale the global modal collects password+TOTP (or passkey)
          and the delete is replayed, so no second factor is entered here. */}
      <Dialog open={deleteUserOpen} onOpenChange={setDeleteUserOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{userToDelete?.username}</strong>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteUserOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleDeleteUser}
              disabled={deletingUser}
            >
              {deletingUser ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Deleting...</>
              ) : (
                'Delete User'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign Role Dialog (pending LDAP-provisioned accounts) */}
      <Dialog open={!!roleDialogUser} onOpenChange={(v) => { if (!v) setRoleDialogUser(null); }}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Assign Role</DialogTitle>
            <DialogDescription>
              <strong>{roleDialogUser?.username}</strong> signed in via LDAP and has no role yet.
              Until one is assigned they can only see their profile page.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={roleToAssign} onValueChange={setRoleToAssign}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User (Limited Access)</SelectItem>
                <SelectItem value="admin">Admin (Full Access)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Users require specific service access. Admins have full access to all services.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRoleDialogUser(null)}>Cancel</Button>
            <Button onClick={handleAssignRole} disabled={assigningRole}>
              {assigningRole ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Assigning...</>
              ) : (
                'Assign Role'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Service Access Dialog */}
      <Dialog open={accessDialogOpen} onOpenChange={setAccessDialogOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-2xl sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Access Control for {selectedUser?.username}</DialogTitle>
            <DialogDescription>
              Configure which services and folders this user can view or modify
            </DialogDescription>
          </DialogHeader>

          {loadingAccess ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : selectedUser?.role === 'admin' ? (
            <div className="text-center py-8 text-muted-foreground">
              <Shield className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>Admin users have full access to all services and folders.</p>
              <p className="text-sm mt-1">Change the user's role to "User" to set granular permissions.</p>
            </div>
          ) : (
            <>
              {/* Feature permissions — page-level grants on top of the
                  per-service access below. Live immediately on save. */}
              <div className="space-y-2 mb-4">
                <p className="text-sm font-medium">Feature Permissions</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="flex items-center justify-between gap-3 p-3 border rounded-lg">
                    <div className="min-w-0">
                      <p className="font-medium text-sm">Proxy</p>
                      <p className="text-xs text-muted-foreground">
                        Containers &amp; routing (Incus) plus their granted services
                      </p>
                    </div>
                    <Switch
                      id="perm-proxy"
                      checked={userPermissions.includes('proxy')}
                      onCheckedChange={(checked) => togglePermission('proxy', checked)}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 p-3 border rounded-lg">
                    <div className="min-w-0">
                      <p className="font-medium text-sm">Developer</p>
                      <p className="text-xs text-muted-foreground">
                        Projects page (dev/build module)
                      </p>
                    </div>
                    <Switch
                      id="perm-developer"
                      checked={userPermissions.includes('developer')}
                      onCheckedChange={(checked) => togglePermission('developer', checked)}
                    />
                  </div>
                </div>
              </div>

              {/* Tab Navigation */}
              <div className="flex gap-1 p-1 bg-muted rounded-lg mb-4">
                <button
                  className={`flex-1 px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                    accessTab === 'services' ? 'bg-background shadow' : 'hover:bg-background/50'
                  }`}
                  onClick={() => setAccessTab('services')}
                >
                  Individual Services ({userAccess.length})
                </button>
                <button
                  className={`flex-1 px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                    accessTab === 'folders' ? 'bg-background shadow' : 'hover:bg-background/50'
                  }`}
                  onClick={() => setAccessTab('folders')}
                >
                  Folders ({userFolderAccess.length})
                </button>
                {userProjects ? (
                  <button
                    className={`flex-1 px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                      accessTab === 'projects' ? 'bg-background shadow' : 'hover:bg-background/50'
                    }`}
                    onClick={() => setAccessTab('projects')}
                  >
                    Projects ({userProjects.filter((p) => p.role !== 'none').length}/{userProjects.length})
                  </button>
                ) : null}
              </div>

              {accessTab === 'projects' && userProjects ? (
                <div className="space-y-2 max-h-80 overflow-auto">
                  {userProjects.length === 0 ? (
                    <p className="text-center text-muted-foreground py-4">No projects yet</p>
                  ) : (
                    userProjects.map((p, index) => (
                      <div key={p.projectId} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 border rounded-lg">
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{p.name}</p>
                          {p.url ? <p className="text-xs text-muted-foreground truncate">{p.url.replace(/^https?:\/\//, '')}</p> : null}
                        </div>
                        <select
                          className="h-10 rounded-md border bg-background px-2 text-sm sm:w-40"
                          value={p.role}
                          onChange={(e) => setUserProjects((cur) => cur.map((x, j) => (j === index ? { ...x, role: e.target.value } : x)))}
                          aria-label={`Project role for ${p.name}`}
                        >
                          <option value="none">No access</option>
                          <option value="viewer">Viewer — follow only</option>
                          <option value="editor">Editor — build & manage</option>
                        </select>
                      </div>
                    ))
                  )}
                  <p className="text-xs text-muted-foreground pt-1">
                    Editors can run builds and manage the project; viewers can watch. The Developer
                    feature permission above controls whether the Projects page shows at all.
                  </p>
                </div>
              ) : accessTab === 'services' ? (
                <div className="space-y-2 max-h-80 overflow-auto">
                  {userAccess.length === 0 ? (
                    <p className="text-center text-muted-foreground py-4">No services available</p>
                  ) : (
                    userAccess.map((access, index) => (
                      <div key={access.serviceId} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 border rounded-lg">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{access.serviceName}</p>
                          <p className="text-sm text-muted-foreground truncate">{access.domain}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-4">
                          <div className="flex items-center gap-2">
                            <Eye className="h-4 w-4 text-muted-foreground" />
                            <Label htmlFor={`view-${access.serviceId}`} className="text-sm">View</Label>
                            <Switch
                              id={`view-${access.serviceId}`}
                              checked={access.canView}
                              onCheckedChange={(checked) => {
                                const newAccess = [...userAccess];
                                newAccess[index].canView = checked;
                                if (!checked) newAccess[index].canWrite = false;
                                setUserAccess(newAccess);
                              }}
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <Edit3 className="h-4 w-4 text-muted-foreground" />
                            <Label htmlFor={`write-${access.serviceId}`} className="text-sm">Write</Label>
                            <Switch
                              id={`write-${access.serviceId}`}
                              checked={access.canWrite}
                              disabled={!access.canView}
                              onCheckedChange={(checked) => {
                                const newAccess = [...userAccess];
                                newAccess[index].canWrite = checked;
                                setUserAccess(newAccess);
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="space-y-2 max-h-80 overflow-auto">
                  {userFolderAccess.length === 0 ? (
                    <p className="text-center text-muted-foreground py-4">
                      No folders created yet. Create folders on the Dashboard to assign folder-level permissions.
                    </p>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground mb-2">
                        Folder access grants permissions to all services within that folder.
                      </p>
                      {userFolderAccess.map((folderAccess, index) => (
                        <div key={folderAccess.folderPath} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 border rounded-lg">
                          <div className="flex items-center gap-2 min-w-0">
                            <Folder className="h-4 w-4 text-yellow-500 shrink-0" />
                            <div className="min-w-0">
                              <p className="font-medium truncate">{folderAccess.folderName}</p>
                              <p className="text-sm text-muted-foreground">{folderAccess.serviceCount} services</p>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-4">
                            <div className="flex items-center gap-2">
                              <Eye className="h-4 w-4 text-muted-foreground" />
                              <Label htmlFor={`folder-view-${index}`} className="text-sm">View</Label>
                              <Switch
                                id={`folder-view-${index}`}
                                checked={folderAccess.canView}
                                onCheckedChange={(checked) => {
                                  const newAccess = [...userFolderAccess];
                                  newAccess[index].canView = checked;
                                  if (!checked) newAccess[index].canWrite = false;
                                  setUserFolderAccess(newAccess);
                                }}
                              />
                            </div>
                            <div className="flex items-center gap-2">
                              <Edit3 className="h-4 w-4 text-muted-foreground" />
                              <Label htmlFor={`folder-write-${index}`} className="text-sm">Write</Label>
                              <Switch
                                id={`folder-write-${index}`}
                                checked={folderAccess.canWrite}
                                disabled={!folderAccess.canView}
                                onCheckedChange={(checked) => {
                                  const newAccess = [...userFolderAccess];
                                  newAccess[index].canWrite = checked;
                                  setUserFolderAccess(newAccess);
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setAccessDialogOpen(false)}>Cancel</Button>
            {selectedUser?.role !== 'admin' && (
              <Button onClick={handleSaveAccess} disabled={savingAccess}>
                {savingAccess ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>
                ) : (
                  'Save Access'
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
          <AiUsageDialog user={aiUsageUser} open={aiUsageUser != null} onOpenChange={(o) => { if (!o) setAiUsageUser(null); }} />
    </div>
  );
}
