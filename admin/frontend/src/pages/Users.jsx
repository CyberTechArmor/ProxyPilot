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
import { useToast } from '@/hooks/use-toast';
import { Loader2, Shield, Users, UserPlus, Trash2, RefreshCw, Copy, Check, Settings, Eye, Edit3, Folder } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import PasskeyConfirmButton from '@/components/PasskeyConfirmButton';
import { effectiveRole, roleLabel, isOperator as isOperatorRole, isSuperadmin as isSuperadminRole } from '@/lib/roles';

// Effective-role badge styling (ADR-011): superadmin/admin blue, developer
// grey, pending amber ("awaiting a role"). The label comes from roleLabel().
const ROLE_BADGE_CLASS = {
  superadmin: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  admin: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  developer: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
};

export default function UsersPage() {
  const { user: authUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [services, setServices] = useState([]);
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [createdUser, setCreatedUser] = useState(null);
  const [newUserForm, setNewUserForm] = useState({ username: '', displayName: '', role: 'developer' });
  const [deleteUserOpen, setDeleteUserOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState(null);
  const [deleteTotpCode, setDeleteTotpCode] = useState('');
  const [deletingUser, setDeletingUser] = useState(false);
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [userAccess, setUserAccess] = useState([]);
  const [userFolderAccess, setUserFolderAccess] = useState([]);
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [savingAccess, setSavingAccess] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [accessTab, setAccessTab] = useState('services'); // 'services' or 'folders'
  const [serviceFolders, setServiceFolders] = useState(() => {
    const saved = localStorage.getItem('serviceFolders');
    return saved ? JSON.parse(saved) : {};
  });

  const { toast } = useToast();

  const cachedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const actor = authUser || cachedUser;
  const isAdmin = isOperatorRole(actor);            // admin-tier (superadmin/admin)
  const actorIsSuperadmin = isSuperadminRole(actor);

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
      setCreatedUser(result.user);
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

  const handleDeleteUser = async (passkeyAssertion = null) => {
    if (!userToDelete) return;
    if (!passkeyAssertion && deleteTotpCode.length !== 6) return;

    setDeletingUser(true);
    try {
      await api.deleteUser(userToDelete.id, passkeyAssertion
        ? { passkeyAssertion }
        : { totpCode: deleteTotpCode });
      toast({
        title: 'Success',
        description: 'User deleted successfully',
      });
      setDeleteUserOpen(false);
      setUserToDelete(null);
      setDeleteTotpCode('');
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

  const openAccessDialog = async (user) => {
    setSelectedUser(user);
    setAccessDialogOpen(true);
    setLoadingAccess(true);
    setAccessTab('services');

    try {
      const result = await api.getUserAccess(user.id);
      if (result.isAdmin) {
        setUserAccess([]);
        setUserFolderAccess([]);
      } else {
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
      // Save both service access and folder access
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
      ]);
      toast({
        title: 'Success',
        description: 'User access updated',
      });
      setAccessDialogOpen(false);
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

  const copyPassword = (password) => {
    navigator.clipboard.writeText(password);
    setCopiedPassword(true);
    setTimeout(() => setCopiedPassword(false), 2000);
  };

  // Assign / reassign a user's effective role (ADR-011). This is the admin
  // onboarding path for a pending (e.g. LDAP-provisioned) account, and the
  // demote/promote path between admin and developer. The backend enforces the
  // superadmin rules (only a superadmin grants superadmin; a superadmin target
  // is untouchable by a non-superadmin; the last superadmin is not removable).
  const handleChangeRole = async (u, role) => {
    if (role === effectiveRole(u)) return;
    try {
      await api.updateUser(u.id, { role });
      toast({ title: 'Role updated', description: `${u.username} is now ${roleLabel({ effectiveRole: role })}.` });
      fetchUsers();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    }
  };

  const handleResetPassword = async (userId) => {
    try {
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
                setNewUserForm({ username: '', displayName: '', role: 'developer' });
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
              {users.map((user) => {
                const targetEff = effectiveRole(user);
                // A superadmin target is untouchable by a non-superadmin actor
                // (ADR-011). The backend enforces this; here we also hide the
                // controls so the UI never offers an action that would 403.
                const locked = user.isSuperadmin && !actorIsSuperadmin;
                const isSelf = user.id === actor?.id;
                return (
                <div key={user.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border rounded-lg">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-lg">{user.username}</span>
                      {user.displayName && (
                        <span className="text-sm text-muted-foreground">({user.displayName})</span>
                      )}
                      <span className={`text-xs px-2 py-0.5 rounded-full ${ROLE_BADGE_CLASS[targetEff] || ROLE_BADGE_CLASS.pending}`}>
                        {roleLabel(user)}
                      </span>
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
                  <div className="flex flex-wrap items-center gap-1 shrink-0">
                    {/* Role assignment (ADR-011). Locked for a superadmin target
                        a non-superadmin can't touch; offers Superadmin only to a
                        superadmin actor. Onboards a pending account to a real role. */}
                    <Select
                      value={targetEff}
                      onValueChange={(v) => handleChangeRole(user, v)}
                      disabled={locked}
                    >
                      <SelectTrigger className="h-11 sm:h-9 w-[9.5rem]" aria-label={`Role for ${user.username}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(actorIsSuperadmin || targetEff === 'superadmin') && (
                          <SelectItem value="superadmin" disabled={!actorIsSuperadmin}>Superadmin</SelectItem>
                        )}
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="developer">Developer</SelectItem>
                        <SelectItem value="pending">Awaiting role</SelectItem>
                      </SelectContent>
                    </Select>
                    {user.role !== 'admin' && (
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
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-11 w-11 sm:h-9 sm:w-9 p-0"
                      onClick={() => handleResetPassword(user.id)}
                      disabled={locked}
                      title="Reset password"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-11 w-11 sm:h-9 sm:w-9 p-0"
                      onClick={() => {
                        setUserToDelete(user);
                        setDeleteUserOpen(true);
                        setDeleteTotpCode('');
                      }}
                      disabled={isSelf || locked}
                      title="Delete user"
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create User Dialog */}
      <Dialog open={createUserOpen} onOpenChange={setCreateUserOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>
              {createdUser ? 'User Created' : 'Create New User'}
            </DialogTitle>
            <DialogDescription>
              {createdUser
                ? 'Save the generated password - it will only be shown once!'
                : 'Create a new user account with auto-generated password'}
            </DialogDescription>
          </DialogHeader>

          {createdUser ? (
            <div className="space-y-4">
              <div className="p-4 bg-muted rounded-lg space-y-3">
                <div>
                  <Label className="text-muted-foreground">Username</Label>
                  <p className="font-medium">{createdUser.username}</p>
                </div>
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
                </div>
                <p className="text-sm text-yellow-600">
                  The user will be prompted to change this password and set up TOTP on first login.
                </p>
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
                    <SelectItem value="developer">Developer (AI dev / Projects)</SelectItem>
                    <SelectItem value="admin">Admin (Full operator access)</SelectItem>
                    {actorIsSuperadmin && (
                      <SelectItem value="superadmin">Superadmin (Full control)</SelectItem>
                    )}
                    <SelectItem value="pending">Awaiting role (No access)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Developers get the AI dev/Projects flow and only the services shared with them.
                  Admins have full operator access{actorIsSuperadmin ? '; superadmins can also manage other superadmins and platform settings' : ''}.
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

      {/* Delete User Dialog */}
      <Dialog open={deleteUserOpen} onOpenChange={setDeleteUserOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{userToDelete?.username}</strong>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <PasskeyConfirmButton
              hasPasskey={typeof window !== 'undefined' && localStorage.getItem('pp_has_passkey') === 'true'}
              onAssertion={(assertion) => handleDeleteUser(assertion)}
              disabled={deletingUser}
              className="w-full"
              label="Verify with passkey"
            />
            <div className="space-y-2">
              <Label>Your TOTP Code</Label>
              <Input
                value={deleteTotpCode}
                onChange={(e) => setDeleteTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter your 6-digit code"
                maxLength={6}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteUserOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => handleDeleteUser()}
              disabled={deletingUser || deleteTotpCode.length !== 6}
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
              </div>

              {accessTab === 'services' ? (
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
    </div>
  );
}
