import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Key, Shield, QrCode } from 'lucide-react';
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

  const { toast } = useToast();

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
    </div>
  );
}
