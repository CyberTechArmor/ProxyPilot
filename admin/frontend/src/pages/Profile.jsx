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
import { Loader2, Key, Shield, QrCode, Trash2, RefreshCw, Copy, Check, Settings, Eye, Edit3, Github, Download, Bell, BellOff, Smartphone, Monitor, LogOut, Fingerprint, Plus } from 'lucide-react';
import QRCode from 'qrcode';
import { registerPasskey, defaultPasskeyLabel, isPasskeySupported } from '@/lib/passkey';

export default function Profile() {
  const { user: authUser } = useAuth();
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

  // Passkey management state
  const [passkeys, setPasskeys] = useState([]);
  const [loadingPasskeys, setLoadingPasskeys] = useState(false);
  const [registerPasskeyOpen, setRegisterPasskeyOpen] = useState(false);
  const [registerPasskeyTotp, setRegisterPasskeyTotp] = useState('');
  const [registerPasskeyLabel, setRegisterPasskeyLabel] = useState('');
  const [registeringPasskey, setRegisteringPasskey] = useState(false);
  const [revokePasskeyOpen, setRevokePasskeyOpen] = useState(false);
  const [passkeyToRevoke, setPasskeyToRevoke] = useState(null);
  const [revokePasskeyPhrase, setRevokePasskeyPhrase] = useState('');
  const [revokePasskeyTotp, setRevokePasskeyTotp] = useState('');
  const [revokingPasskey, setRevokingPasskey] = useState(false);

  // Device management state
  const [devices, setDevices] = useState([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [revokeDeviceOpen, setRevokeDeviceOpen] = useState(false);
  const [deviceToRevoke, setDeviceToRevoke] = useState(null);
  const [revokeDeviceTotpCode, setRevokeDeviceTotpCode] = useState('');
  const [revokingDevice, setRevokingDevice] = useState(false);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [revokeAllTotpCode, setRevokeAllTotpCode] = useState('');
  const [revokingAll, setRevokingAll] = useState(false);

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

  // App settings state
  const [appVersion, setAppVersion] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [editingRepo, setEditingRepo] = useState(false);
  const [newGithubRepo, setNewGithubRepo] = useState('');
  const [savingRepo, setSavingRepo] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [resettingDismiss, setResettingDismiss] = useState(false);

  const { toast } = useToast();

  // Check if current user is admin (check auth context, profile, and localStorage)
  const isAdmin = authUser?.role === 'admin' || profile?.role === 'admin' || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';

  useEffect(() => {
    fetchProfile();
    fetchAppSettings();
  }, []);

  const fetchAppSettings = async () => {
    try {
      const data = await api.getVersion();
      setAppVersion(data.version);
      setGithubRepo(data.githubRepo);
      setUpdateDismissed(data.updateDismissed);

      // Also check for updates
      checkForUpdates();
    } catch (error) {
      console.error('Error fetching app settings:', error);
    }
  };

  const checkForUpdates = async () => {
    setCheckingUpdate(true);
    try {
      const data = await api.checkForUpdates();
      setUpdateInfo(data);
    } catch (error) {
      console.error('Error checking for updates:', error);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleSaveGithubRepo = async () => {
    if (!newGithubRepo || newGithubRepo === githubRepo) {
      setEditingRepo(false);
      return;
    }

    setSavingRepo(true);
    try {
      await api.updateGithubRepo(newGithubRepo);
      setGithubRepo(newGithubRepo);
      setEditingRepo(false);
      toast({
        title: 'Success',
        description: 'GitHub repository updated successfully',
      });
      // Re-check for updates with new repo
      checkForUpdates();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSavingRepo(false);
    }
  };

  const handleResetDismiss = async () => {
    setResettingDismiss(true);
    try {
      await api.resetDismissUpdate();
      setUpdateDismissed(false);
      toast({
        title: 'Success',
        description: 'Update notification will be shown again',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setResettingDismiss(false);
    }
  };

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

  // Device management functions
  const fetchDevices = async () => {
    setLoadingDevices(true);
    try {
      const { devices } = await api.getDevices();
      setDevices(devices || []);
    } catch (error) {
      console.error('Error fetching devices:', error);
    } finally {
      setLoadingDevices(false);
    }
  };

  const handleRevokeDevice = async () => {
    if (!deviceToRevoke || revokeDeviceTotpCode.length !== 6) return;

    setRevokingDevice(true);
    try {
      await api.revokeDevice(deviceToRevoke.id, revokeDeviceTotpCode);
      toast({
        title: 'Success',
        description: 'Device has been revoked',
      });
      setRevokeDeviceOpen(false);
      setDeviceToRevoke(null);
      setRevokeDeviceTotpCode('');
      fetchDevices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setRevokingDevice(false);
    }
  };

  const handleRevokeAllDevices = async () => {
    if (revokeAllTotpCode.length !== 6) return;

    setRevokingAll(true);
    try {
      await api.revokeAllDevices(revokeAllTotpCode);
      toast({
        title: 'Success',
        description: 'All other devices have been logged out',
      });
      setRevokeAllOpen(false);
      setRevokeAllTotpCode('');
      fetchDevices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setRevokingAll(false);
    }
  };

  // Fetch devices when profile is loaded
  useEffect(() => {
    if (profile) {
      fetchDevices();
      fetchPasskeys();
    }
  }, [profile]);

  // Passkey management
  const fetchPasskeys = async () => {
    setLoadingPasskeys(true);
    try {
      const { passkeys } = await api.listPasskeys();
      setPasskeys(passkeys || []);
      // Keep the localStorage hint in sync — Login uses it to decide
      // whether to show the "Sign in with passkey" button.
      if (passkeys && passkeys.length > 0) {
        localStorage.setItem('pp_has_passkey', 'true');
      } else {
        localStorage.removeItem('pp_has_passkey');
      }
    } catch (error) {
      console.error('Error fetching passkeys:', error);
    } finally {
      setLoadingPasskeys(false);
    }
  };

  const openRegisterPasskey = () => {
    setRegisterPasskeyTotp('');
    setRegisterPasskeyLabel(defaultPasskeyLabel());
    setRegisterPasskeyOpen(true);
  };

  const handleRegisterPasskey = async () => {
    if (registerPasskeyTotp.length !== 6) return;
    setRegisteringPasskey(true);
    try {
      const result = await registerPasskey({
        totpCode: registerPasskeyTotp,
        label: registerPasskeyLabel.trim() || defaultPasskeyLabel(),
      });
      if (!result.ok) {
        toast({
          variant: 'destructive',
          title: result.code === 'CANCELLED' ? 'Cancelled' : 'Could not register passkey',
          description: result.message,
        });
        return;
      }
      toast({ title: 'Passkey registered', description: 'You can now sign in with this passkey.' });
      setRegisterPasskeyOpen(false);
      fetchPasskeys();
    } finally {
      setRegisteringPasskey(false);
    }
  };

  const openRevokePasskey = (pk) => {
    setPasskeyToRevoke(pk);
    setRevokePasskeyPhrase('');
    setRevokePasskeyTotp('');
    setRevokePasskeyOpen(true);
  };

  const REVOKE_PASSKEY_PHRASE = 'I no longer have access to this device';

  const handleRevokePasskey = async () => {
    if (!passkeyToRevoke) return;
    if (revokePasskeyPhrase !== REVOKE_PASSKEY_PHRASE) return;
    if (revokePasskeyTotp.length !== 6) return;
    setRevokingPasskey(true);
    try {
      await api.deletePasskey(passkeyToRevoke.id, { totpCode: revokePasskeyTotp });
      toast({ title: 'Passkey revoked' });
      setRevokePasskeyOpen(false);
      setPasskeyToRevoke(null);
      fetchPasskeys();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    } finally {
      setRevokingPasskey(false);
    }
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
                  className="w-48 h-48 max-w-full h-auto bg-white p-2 rounded-lg"
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

      {/* Authenticated Devices */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Smartphone className="h-5 w-5" />
                Authenticated Devices
              </CardTitle>
              <CardDescription>
                Devices that can log in without TOTP verification
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={fetchDevices} disabled={loadingDevices}>
                <RefreshCw className={`h-4 w-4 ${loadingDevices ? 'animate-spin' : ''}`} />
              </Button>
              {devices.length > 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRevokeAllOpen(true)}
                  className="text-destructive hover:text-destructive"
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  Revoke All
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadingDevices ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : devices.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Monitor className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No authenticated devices</p>
              <p className="text-sm mt-1">
                Enable "Remember this device" when logging in to add devices
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {devices.map((device) => (
                <div key={device.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 border rounded-lg">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Monitor className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium truncate">{device.device_name}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 mt-1 text-sm text-muted-foreground">
                      <span>IP: {device.ip_address}</span>
                      <span>Last used: {new Date(device.last_used_at).toLocaleString()}</span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-11 w-11 sm:h-9 sm:w-9 p-0 self-end sm:self-auto shrink-0"
                    onClick={() => {
                      setDeviceToRevoke(device);
                      setRevokeDeviceOpen(true);
                      setRevokeDeviceTotpCode('');
                    }}
                    title="Revoke device"
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Passkeys */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Fingerprint className="h-5 w-5" />
                Passkeys
              </CardTitle>
              <CardDescription>
                Optional second factor. Once registered, sign-in and
                destructive-action prompts default to passkey instead of TOTP.
                TOTP stays available as a fallback.
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={fetchPasskeys} disabled={loadingPasskeys}>
                <RefreshCw className={`h-4 w-4 ${loadingPasskeys ? 'animate-spin' : ''}`} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={openRegisterPasskey}
                disabled={!isPasskeySupported()}
                title={!isPasskeySupported() ? 'Passkeys are not supported on this browser' : ''}
              >
                <Plus className="h-4 w-4 mr-2" />
                Register passkey
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadingPasskeys ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : passkeys.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Fingerprint className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No passkeys registered</p>
              <p className="text-sm mt-1">
                {isPasskeySupported()
                  ? 'Click "Register passkey" to add this device as a second factor.'
                  : 'This browser does not support passkeys.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {passkeys.map((pk) => (
                <div key={pk.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 border rounded-lg">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Fingerprint className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium truncate">{pk.label || 'Unnamed passkey'}</span>
                      {Array.isArray(pk.transports) && pk.transports.length > 0 && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">
                          {pk.transports.join(' / ')}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 mt-1 text-sm text-muted-foreground">
                      <span>Created: {new Date(pk.createdAt).toLocaleString()}</span>
                      <span>Last used: {pk.lastUsedAt ? new Date(pk.lastUsedAt).toLocaleString() : 'never'}</span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-11 w-11 sm:h-9 sm:w-9 p-0 self-end sm:self-auto shrink-0"
                    onClick={() => openRevokePasskey(pk)}
                    title="Revoke passkey"
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Register Passkey Dialog (TOTP gate) */}
      <Dialog open={registerPasskeyOpen} onOpenChange={setRegisterPasskeyOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Register a passkey</DialogTitle>
            <DialogDescription>
              Confirm with your current TOTP code, then your browser will prompt
              you to create the passkey on this device.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Label</Label>
              <Input
                value={registerPasskeyLabel}
                onChange={(e) => setRegisterPasskeyLabel(e.target.value.slice(0, 64))}
                placeholder={defaultPasskeyLabel()}
                disabled={registeringPasskey}
              />
            </div>
            <div className="space-y-2">
              <Label>Your TOTP Code</Label>
              <Input
                value={registerPasskeyTotp}
                onChange={(e) => setRegisterPasskeyTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter your 6-digit code"
                maxLength={6}
                disabled={registeringPasskey}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRegisterPasskeyOpen(false)} disabled={registeringPasskey}>Cancel</Button>
            <Button
              onClick={handleRegisterPasskey}
              disabled={registeringPasskey || registerPasskeyTotp.length !== 6}
            >
              {registeringPasskey ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Registering...</> : 'Register'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke Passkey Dialog */}
      <Dialog open={revokePasskeyOpen} onOpenChange={setRevokePasskeyOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Revoke passkey</DialogTitle>
            <DialogDescription>
              This permanently removes <strong>{passkeyToRevoke?.label || 'this passkey'}</strong>.
              The credential on the device itself isn't deleted, but the
              dashboard will no longer accept assertions from it. Type the
              phrase below to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Type to confirm: <code className="text-xs">{REVOKE_PASSKEY_PHRASE}</code></Label>
              <Input
                value={revokePasskeyPhrase}
                onChange={(e) => setRevokePasskeyPhrase(e.target.value)}
                placeholder={REVOKE_PASSKEY_PHRASE}
                disabled={revokingPasskey}
              />
            </div>
            <div className="space-y-2">
              <Label>Your TOTP Code</Label>
              <Input
                value={revokePasskeyTotp}
                onChange={(e) => setRevokePasskeyTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter your 6-digit code"
                maxLength={6}
                disabled={revokingPasskey}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokePasskeyOpen(false)} disabled={revokingPasskey}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleRevokePasskey}
              disabled={revokingPasskey || revokePasskeyPhrase !== REVOKE_PASSKEY_PHRASE || revokePasskeyTotp.length !== 6}
            >
              {revokingPasskey ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Revoking...</> : 'Revoke passkey'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke Device Dialog */}
      <Dialog open={revokeDeviceOpen} onOpenChange={setRevokeDeviceOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Revoke Device</DialogTitle>
            <DialogDescription>
              This will log out <strong>{deviceToRevoke?.device_name}</strong> and require TOTP verification for future logins from this device.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Your TOTP Code</Label>
              <Input
                value={revokeDeviceTotpCode}
                onChange={(e) => setRevokeDeviceTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter your 6-digit code"
                maxLength={6}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeDeviceOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleRevokeDevice}
              disabled={revokingDevice || revokeDeviceTotpCode.length !== 6}
            >
              {revokingDevice ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Revoking...</>
              ) : (
                'Revoke Device'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke All Devices Dialog */}
      <Dialog open={revokeAllOpen} onOpenChange={setRevokeAllOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Revoke All Devices</DialogTitle>
            <DialogDescription>
              This will log out all authenticated devices except your current session. All devices will need TOTP verification for future logins.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Your TOTP Code</Label>
              <Input
                value={revokeAllTotpCode}
                onChange={(e) => setRevokeAllTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter your 6-digit code"
                maxLength={6}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeAllOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleRevokeAllDevices}
              disabled={revokingAll || revokeAllTotpCode.length !== 6}
            >
              {revokingAll ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Revoking...</>
              ) : (
                'Revoke All Devices'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* App Settings (Admin Only) */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Application Settings
            </CardTitle>
            <CardDescription>
              Manage ProxyPilot version and update settings
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Current Version */}
            <div className="space-y-2">
              <Label className="text-muted-foreground">Current Version</Label>
              <div className="flex items-center gap-2">
                <span className="font-medium">v{appVersion || '...'}</span>
                {updateInfo?.updateAvailable && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-primary text-primary-foreground">
                    Update available: v{updateInfo.latestVersion}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={checkForUpdates}
                  disabled={checkingUpdate}
                >
                  <RefreshCw className={`h-4 w-4 ${checkingUpdate ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>

            {/* GitHub Repository */}
            <div className="space-y-2">
              <Label className="text-muted-foreground">GitHub Repository</Label>
              {editingRepo ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={newGithubRepo}
                    onChange={(e) => setNewGithubRepo(e.target.value)}
                    placeholder="owner/repository"
                    className="flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditingRepo(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSaveGithubRepo}
                    disabled={savingRepo}
                  >
                    {savingRepo ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 flex-1">
                    <Github className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{githubRepo || '...'}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setNewGithubRepo(githubRepo);
                      setEditingRepo(true);
                    }}
                  >
                    <Edit3 className="h-4 w-4" />
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                The GitHub repository used to check for updates and pull new versions
              </p>
            </div>

            {/* Update Notification */}
            {updateDismissed && updateInfo?.updateAvailable && (
              <div className="space-y-2">
                <Label className="text-muted-foreground">Update Notification</Label>
                <div className="flex items-center gap-2">
                  <BellOff className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    Update notification dismissed for v{updateInfo.latestVersion}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleResetDismiss}
                    disabled={resettingDismiss}
                  >
                    {resettingDismiss ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Bell className="h-4 w-4 mr-1" />
                        Show Again
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* Update Info */}
            {updateInfo && (
              <div className="p-4 bg-muted rounded-lg space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Current Version</span>
                  <span className="font-medium">v{updateInfo.currentVersion}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Latest Version</span>
                  <span className="font-medium">v{updateInfo.latestVersion}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Status</span>
                  <span className={`text-sm font-medium ${updateInfo.updateAvailable ? 'text-primary' : 'text-green-500'}`}>
                    {updateInfo.updateAvailable ? 'Update Available' : 'Up to Date'}
                  </span>
                </div>
                {updateInfo.releaseUrl && (
                  <div className="pt-2 border-t">
                    <a
                      href={updateInfo.releaseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline flex items-center gap-1"
                    >
                      <Download className="h-4 w-4" />
                      View Release Notes
                    </a>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

    </div>
  );
}
