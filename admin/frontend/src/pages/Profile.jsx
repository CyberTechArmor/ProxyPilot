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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Key, Shield, QrCode, Users, UserPlus, Trash2, RefreshCw, Copy, Check, Settings, Eye, Edit3 } from 'lucide-react';
import QRCode from 'qrcode';

export default function Profile() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [changingPassword, setChangingPassword] = useState(false);
  const [settingUpTotp, setSettingUpTotp] = useState(false);
  const [totpSetupData, setTotpSetupData] = useState(null);
  const [qrCodeUrl, setQrCodeUrl] = useState('');

  // Password change form
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
    totpCode: '',
  });

  // TOTP setup form
  const [totpForm, setTotpForm] = useState({
    password: '',
    verificationCode: '',
  });

  // User management state (admin only)
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [services, setServices] = useState([]);
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [createdUser, setCreatedUser] = useState(null);
  const [newUserForm, setNewUserForm] = useState({ username: '', displayName: '', role: 'user' });
  const [deleteUserOpen, setDeleteUserOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState(null);
  const [deleteTotpCode, setDeleteTotpCode] = useState('');
  const [deletingUser, setDeletingUser] = useState(false);
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [userAccess, setUserAccess] = useState([]);
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [savingAccess, setSavingAccess] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);

  const { toast } = useToast();

  // Check if current user is admin
  const isAdmin = profile?.role === 'admin' || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';

  useEffect(() => {
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    try {
      const { user } = await api.getProfile();
      setProfile(user);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'New passwords do not match',
      });
      return;
    }

    if (passwordForm.newPassword.length < 12) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Password must be at least 12 characters',
      });
      return;
    }

    setChangingPassword(true);

    try {
      await api.changePassword({
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
        totpCode: passwordForm.totpCode,
      });

      toast({
        title: 'Success',
        description: 'Password changed successfully',
      });

      setPasswordForm({
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
        totpCode: '',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setChangingPassword(false);
    }
  };

  const handleGenerateTotp = async () => {
    if (!totpForm.password) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please enter your current password',
      });
      return;
    }

    setSettingUpTotp(true);

    try {
      const data = await api.generateTotp(totpForm.password);
      setTotpSetupData(data);

      // Generate QR code
      const qrUrl = await QRCode.toDataURL(data.uri);
      setQrCodeUrl(qrUrl);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSettingUpTotp(false);
    }
  };

  const handleVerifyTotp = async () => {
    if (!totpForm.verificationCode || totpForm.verificationCode.length !== 6) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please enter a valid 6-digit code',
      });
      return;
    }

    setSettingUpTotp(true);

    try {
      await api.verifyTotp({
        secret: totpSetupData.secret,
        totpCode: totpForm.verificationCode,
      });

      toast({
        title: 'Success',
        description: 'TOTP updated successfully',
      });

      setTotpSetupData(null);
      setQrCodeUrl('');
      setTotpForm({ password: '', verificationCode: '' });
      fetchProfile();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSettingUpTotp(false);
    }
  };

  const cancelTotpSetup = () => {
    setTotpSetupData(null);
    setQrCodeUrl('');
    setTotpForm({ password: '', verificationCode: '' });
  };

  // User management functions (admin only)
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

  const handleDeleteUser = async () => {
    if (!userToDelete || deleteTotpCode.length !== 6) return;

    setDeletingUser(true);
    try {
      await api.deleteUser(userToDelete.id, deleteTotpCode);
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

    try {
      const result = await api.getUserAccess(user.id);
      if (result.isAdmin) {
        setUserAccess([]);
      } else {
        // Initialize access for all services
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
      await api.updateUserAccess(selectedUser.id, userAccess.map(a => ({
        serviceId: a.serviceId,
        canView: a.canView,
        canWrite: a.canWrite,
      })));
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

  const handleResetPassword = async (userId) => {
    try {
      const result = await api.updateUser(userId, { resetPassword: true });
      if (result.newPassword) {
        setCreatedUser({ ...users.find(u => u.id === userId), password: result.newPassword });
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

  // Fetch users when profile is loaded and user is admin
  useEffect(() => {
    if (isAdmin && profile) {
      fetchUsers();
    }
  }, [isAdmin, profile]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold">Profile</h1>
        <p className="text-muted-foreground">
          Manage your account settings and security
        </p>
      </div>

      {/* Account Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Account Information
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Username</span>
            <span className="font-medium">{profile?.username}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">TOTP Status</span>
            <span className={profile?.totpEnabled ? 'text-green-500' : 'text-yellow-500'}>
              {profile?.totpEnabled ? 'Enabled' : 'Not Configured'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Account Created</span>
            <span>{new Date(profile?.createdAt).toLocaleDateString()}</span>
          </div>
        </CardContent>
      </Card>

      {/* Change Password */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Change Password
          </CardTitle>
          <CardDescription>
            Update your password. Requires your current password and TOTP code.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">Current Password</Label>
              <Input
                id="currentPassword"
                type="password"
                value={passwordForm.currentPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="newPassword">New Password</Label>
              <Input
                id="newPassword"
                type="password"
                value={passwordForm.newPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                minLength={12}
                required
              />
              <p className="text-xs text-muted-foreground">
                Minimum 12 characters
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm New Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={passwordForm.confirmPassword}
                onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="passwordTotp">TOTP Code</Label>
              <Input
                id="passwordTotp"
                value={passwordForm.totpCode}
                onChange={(e) => setPasswordForm({
                  ...passwordForm,
                  totpCode: e.target.value.replace(/\D/g, '').slice(0, 6)
                })}
                placeholder="Enter 6-digit code"
                maxLength={6}
                required
              />
            </div>

            <Button type="submit" disabled={changingPassword}>
              {changingPassword ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Changing...
                </>
              ) : (
                'Change Password'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* TOTP Setup */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5" />
            Two-Factor Authentication
          </CardTitle>
          <CardDescription>
            {totpSetupData
              ? 'Scan the QR code with your authenticator app'
              : 'Reset or update your TOTP secret'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!totpSetupData ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="totpPassword">Current Password</Label>
                <Input
                  id="totpPassword"
                  type="password"
                  value={totpForm.password}
                  onChange={(e) => setTotpForm({ ...totpForm, password: e.target.value })}
                  placeholder="Enter your password to generate new TOTP"
                />
              </div>

              <Button onClick={handleGenerateTotp} disabled={settingUpTotp || !totpForm.password}>
                {settingUpTotp ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  'Generate New TOTP Secret'
                )}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-center">
                <img
                  src={qrCodeUrl}
                  alt="TOTP QR Code"
                  className="w-48 h-48 bg-white p-2 rounded-lg"
                />
              </div>

              <div className="text-center space-y-2">
                <p className="text-sm text-muted-foreground">
                  Or enter this secret manually:
                </p>
                <code className="block bg-secondary px-3 py-2 rounded-md text-sm break-all">
                  {totpSetupData.secret}
                </code>
              </div>

              <div className="space-y-2">
                <Label htmlFor="verificationCode">Verification Code</Label>
                <Input
                  id="verificationCode"
                  value={totpForm.verificationCode}
                  onChange={(e) => setTotpForm({
                    ...totpForm,
                    verificationCode: e.target.value.replace(/\D/g, '').slice(0, 6)
                  })}
                  placeholder="Enter 6-digit code from app"
                  maxLength={6}
                />
                <p className="text-xs text-muted-foreground">
                  Enter the code from your authenticator app to verify setup
                </p>
              </div>

              <div className="flex gap-2">
                <Button variant="outline" onClick={cancelTotpSetup}>
                  Cancel
                </Button>
                <Button
                  onClick={handleVerifyTotp}
                  disabled={settingUpTotp || totpForm.verificationCode.length !== 6}
                >
                  {settingUpTotp ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    'Verify & Save'
                  )}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* User Management (Admin Only) */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  User Management
                </CardTitle>
                <CardDescription>
                  Create and manage user accounts with granular service access
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
                  <div key={user.id} className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{user.username}</span>
                        {user.displayName && (
                          <span className="text-sm text-muted-foreground">({user.displayName})</span>
                        )}
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          user.role === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700'
                        }`}>
                          {user.role}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                        <span className={user.totpEnabled ? 'text-green-500' : 'text-yellow-500'}>
                          TOTP: {user.totpEnabled ? 'Enabled' : 'Not Set'}
                        </span>
                        {user.passwordChangeRequired && (
                          <span className="text-orange-500">Password change required</span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {user.role !== 'admin' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openAccessDialog(user)}
                          title="Manage service access"
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleResetPassword(user.id)}
                        title="Reset password"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setUserToDelete(user);
                          setDeleteUserOpen(true);
                          setDeleteTotpCode('');
                        }}
                        disabled={user.id === profile?.id}
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
      )}

      {/* Create User Dialog */}
      <Dialog open={createUserOpen} onOpenChange={setCreateUserOpen}>
        <DialogContent>
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

      {/* Delete User Dialog */}
      <Dialog open={deleteUserOpen} onOpenChange={setDeleteUserOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{userToDelete?.username}</strong>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
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
              onClick={handleDeleteUser}
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
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Service Access for {selectedUser?.username}</DialogTitle>
            <DialogDescription>
              Configure which services this user can view or modify
            </DialogDescription>
          </DialogHeader>

          {loadingAccess ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : selectedUser?.role === 'admin' ? (
            <div className="text-center py-8 text-muted-foreground">
              <Shield className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>Admin users have full access to all services.</p>
              <p className="text-sm mt-1">Change the user's role to "User" to set granular permissions.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-auto">
              {userAccess.length === 0 ? (
                <p className="text-center text-muted-foreground py-4">No services available</p>
              ) : (
                userAccess.map((access, index) => (
                  <div key={access.serviceId} className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <p className="font-medium">{access.serviceName}</p>
                      <p className="text-sm text-muted-foreground">{access.domain}</p>
                    </div>
                    <div className="flex items-center gap-4">
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
