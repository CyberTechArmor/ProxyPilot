import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Rocket, Loader2, ShieldCheck, QrCode, Copy, Check, Smartphone, KeyRound, Eye, EyeOff } from 'lucide-react';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpSetup, setTotpSetup] = useState(null); // { secret, uri } for new TOTP setup
  const [loading, setLoading] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(false);
  const [deviceFingerprint, setDeviceFingerprint] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Initial setup state
  const [setupMode, setSetupMode] = useState(false);
  const [setupLoading, setSetupLoading] = useState(true);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupToken, setSetupToken] = useState(null); // Token from initial-setup for TOTP completion
  const [setupTotpStep, setSetupTotpStep] = useState(false); // TOTP setup after password creation

  const { login } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  // Check if initial setup is needed on mount
  useEffect(() => {
    checkSetupStatus();
  }, []);

  const checkSetupStatus = async () => {
    try {
      const status = await api.getSetupStatus();
      if (status.needsSetup) {
        setSetupMode(true);
        setUsername(status.username || '');
      }
    } catch (e) {
      // Server may not be ready, ignore
    } finally {
      setSetupLoading(false);
    }
  };

  // Generate QR code when TOTP setup is needed
  useEffect(() => {
    if (totpSetup?.uri || totpSetup?.totpUri) {
      const uri = totpSetup.uri || totpSetup.totpUri;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uri)}`;
      setQrCodeUrl(qrUrl);
    }
  }, [totpSetup]);

  const copySecret = () => {
    const secret = totpSetup?.secret || totpSetup?.totpSecret;
    if (secret) {
      navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: 'Copied!', description: 'Secret key copied to clipboard' });
    }
  };

  // Handle initial password setup
  const handleInitialSetup = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast({ variant: 'destructive', title: 'Error', description: 'Passwords do not match' });
      return;
    }
    if (newPassword.length < 12) {
      toast({ variant: 'destructive', title: 'Error', description: 'Password must be at least 12 characters' });
      return;
    }

    setLoading(true);
    try {
      const result = await api.initialSetup({ username, newPassword, confirmPassword });

      // Store the token for TOTP setup
      localStorage.setItem('token', result.token);
      setSetupToken(result.token);

      // Move to TOTP setup step
      if (result.totpSetupRequired && result.totpSecret) {
        setTotpSetup(result.totpSecret); // { secret, uri }
        setSetupTotpStep(true);
        setSetupMode(false);
        toast({
          title: 'Password set!',
          description: 'Now set up two-factor authentication.',
        });
      } else {
        // No TOTP needed (shouldn't happen but handle gracefully)
        localStorage.setItem('user', JSON.stringify(result.user));
        window.location.href = '/';
      }
    } catch (error) {
      toast({ variant: 'destructive', title: 'Setup failed', description: error.message });
    } finally {
      setLoading(false);
    }
  };

  // Handle TOTP verification during initial setup
  const handleSetupTotpVerify = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const secret = totpSetup?.secret || totpSetup?.totpSecret;
      const result = await api.completeTotpSetup({
        totpCode,
        totpSecret: secret,
        registerDevice: rememberDevice,
      });

      // Login complete
      localStorage.setItem('token', result.token);
      localStorage.setItem('user', JSON.stringify(result.user));
      toast({ title: 'Setup complete!', description: 'Welcome to ProxyPilot.' });
      window.location.href = '/';
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    } finally {
      setLoading(false);
    }
  };

  // Handle normal login
  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      const loginData = {
        username,
        password,
        totpCode: (totpRequired || totpSetup) ? totpCode : '',
        deviceFingerprint: deviceFingerprint || undefined,
        registerDevice: rememberDevice,
      };

      // Include setup secret if this is a new TOTP setup
      if (totpSetup?.totpSecret) {
        loginData.totpSetupSecret = totpSetup.totpSecret;
      }

      await login(loginData);
      navigate('/');
    } catch (error) {
      // Capture device fingerprint from response
      if (error.deviceFingerprint) {
        setDeviceFingerprint(error.deviceFingerprint);
      }

      // Check if initial setup is required
      if (error.setupRequired) {
        setSetupMode(true);
        toast({
          title: 'Setup Required',
          description: 'Please set your password to get started.',
        });
      } else if (error.totpSetupRequired) {
        // Check if TOTP setup is required (new user without TOTP)
        setTotpSetup({
          totpSecret: error.totpSecret,
          totpUri: error.totpUri,
        });
        setTotpRequired(false);
        toast({
          title: 'Two-Factor Authentication Required',
          description: 'Scan the QR code with your authenticator app',
        });
      } else if (error.totpRequired) {
        // Existing user with TOTP
        setTotpRequired(true);
        setTotpSetup(null);
        toast({
          title: 'TOTP Required',
          description: 'Please enter your 6-digit authenticator code',
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Login failed',
          description: error.message || 'Invalid credentials',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const resetLogin = () => {
    setTotpRequired(false);
    setTotpSetup(null);
    setTotpCode('');
    setQrCodeUrl('');
    setSetupMode(false);
    setSetupTotpStep(false);
    setSetupToken(null);
    setNewPassword('');
    setConfirmPassword('');
    checkSetupStatus();
  };

  if (setupLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  // ========== INITIAL SETUP: Set Password ==========
  if (setupMode && !setupTotpStep) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <Rocket className="h-12 w-12 text-primary" />
            </div>
            <CardTitle className="text-2xl">Welcome to ProxyPilot</CardTitle>
            <CardDescription>
              Create your admin password to get started
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInitialSetup} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="setup-username">Admin Username</Label>
                <Input
                  id="setup-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Admin username"
                  required
                  autoComplete="username"
                  disabled={!!username}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-password">
                  <span className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4" />
                    New Password
                  </span>
                </Label>
                <div className="relative">
                  <Input
                    id="setup-password"
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Minimum 12 characters"
                    required
                    minLength={12}
                    autoComplete="new-password"
                    autoFocus
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-0 top-0 h-full px-3"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-confirm">Confirm Password</Label>
                <Input
                  id="setup-confirm"
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm your password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                />
                {confirmPassword && newPassword !== confirmPassword && (
                  <p className="text-xs text-red-500">Passwords do not match</p>
                )}
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={loading || newPassword.length < 12 || newPassword !== confirmPassword}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Setting up...
                  </>
                ) : (
                  'Set Password & Continue'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ========== INITIAL SETUP: TOTP Setup (after password) ==========
  if (setupTotpStep && totpSetup) {
    const secret = totpSetup.secret || totpSetup.totpSecret;
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <ShieldCheck className="h-12 w-12 text-primary" />
            </div>
            <CardTitle className="text-2xl">Set Up Two-Factor Auth</CardTitle>
            <CardDescription>
              Scan the QR code with your authenticator app to secure your account
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSetupTotpVerify} className="space-y-4">
              <div className="text-center">
                <div className="flex items-center justify-center gap-2 mb-3">
                  <QrCode className="h-5 w-5 text-primary" />
                  <span className="font-medium">Scan QR Code</span>
                </div>
                <p className="text-sm text-muted-foreground mb-4">
                  Use Google Authenticator, Authy, or any TOTP app
                </p>
                {qrCodeUrl && (
                  <div className="flex justify-center mb-4">
                    <div className="bg-white p-3 rounded-lg">
                      <img src={qrCodeUrl} alt="TOTP QR Code" className="w-48 h-48" />
                    </div>
                  </div>
                )}
                <div className="text-xs text-muted-foreground mb-2">
                  Or enter this secret key manually:
                </div>
                <div className="flex items-center justify-center gap-2">
                  <code className="bg-muted px-3 py-1.5 rounded text-sm font-mono">
                    {secret}
                  </code>
                  <Button type="button" variant="ghost" size="sm" onClick={copySecret} className="h-8 w-8 p-0">
                    {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-totp" className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  Verification Code
                </Label>
                <Input
                  id="setup-totp"
                  type="text"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="Enter 6-digit code"
                  required
                  maxLength={6}
                  pattern="[0-9]{6}"
                  autoComplete="one-time-code"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Enter the code from your authenticator app to complete setup
                </p>
              </div>

              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <div className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <span className="text-sm font-medium">Remember this device</span>
                    <p className="text-xs text-muted-foreground">Skip TOTP on future logins</p>
                  </div>
                </div>
                <Switch checked={rememberDevice} onCheckedChange={setRememberDevice} />
              </div>

              <Button type="submit" className="w-full" disabled={loading || totpCode.length !== 6}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  'Complete Setup & Sign In'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ========== NORMAL LOGIN FLOW ==========
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <Rocket className="h-12 w-12 text-primary" />
          </div>
          <CardTitle className="text-2xl">ProxyPilot Admin</CardTitle>
          <CardDescription>
            {totpSetup
              ? 'Set up Two-Factor Authentication'
              : totpRequired
                ? 'Enter your authenticator code'
                : 'Sign in to manage your proxy services'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Username/Password fields - hidden during TOTP steps */}
            {!totpRequired && !totpSetup && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Enter your username"
                    required
                    autoComplete="username"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                      required
                      autoComplete="current-password"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              </>
            )}

            {/* TOTP Setup - QR Code for new users */}
            {totpSetup && (
              <div className="space-y-4">
                <div className="text-center">
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <QrCode className="h-5 w-5 text-primary" />
                    <span className="font-medium">Scan QR Code</span>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">
                    Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
                  </p>
                  {qrCodeUrl && (
                    <div className="flex justify-center mb-4">
                      <div className="bg-white p-3 rounded-lg">
                        <img src={qrCodeUrl} alt="TOTP QR Code" className="w-48 h-48" />
                      </div>
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mb-2">
                    Or enter this secret key manually:
                  </div>
                  <div className="flex items-center justify-center gap-2">
                    <code className="bg-muted px-3 py-1.5 rounded text-sm font-mono">
                      {totpSetup.totpSecret}
                    </code>
                    <Button type="button" variant="ghost" size="sm" onClick={copySecret} className="h-8 w-8 p-0">
                      {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="totp" className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    Verification Code
                  </Label>
                  <Input
                    id="totp"
                    type="text"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="Enter 6-digit code"
                    required
                    maxLength={6}
                    pattern="[0-9]{6}"
                    autoComplete="one-time-code"
                    autoFocus
                  />
                  <p className="text-xs text-muted-foreground">
                    Enter the code from your authenticator app to complete setup
                  </p>
                </div>
              </div>
            )}

            {/* TOTP Entry for existing users */}
            {totpRequired && !totpSetup && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="totp" className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    TOTP Code
                  </Label>
                  <Input
                    id="totp"
                    type="text"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="Enter 6-digit code"
                    required
                    maxLength={6}
                    pattern="[0-9]{6}"
                    autoComplete="one-time-code"
                    autoFocus
                  />
                  <p className="text-xs text-muted-foreground">
                    Enter the code from your authenticator app
                  </p>
                </div>
                <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <span className="text-sm font-medium">Remember this device</span>
                      <p className="text-xs text-muted-foreground">Skip TOTP on future logins</p>
                    </div>
                  </div>
                  <Switch checked={rememberDevice} onCheckedChange={setRememberDevice} />
                </div>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {totpSetup ? 'Verifying...' : 'Signing in...'}
                </>
              ) : totpSetup ? (
                'Complete Setup & Sign In'
              ) : (
                'Sign in'
              )}
            </Button>

            {(totpRequired || totpSetup) && (
              <Button type="button" variant="ghost" className="w-full" onClick={resetLogin}>
                Back to login
              </Button>
            )}

            {!totpRequired && !totpSetup && (
              <p className="text-center text-xs text-muted-foreground mt-4">
                Can't log in? Run <code className="bg-muted px-1.5 py-0.5 rounded font-mono">sudo /opt/proxypilot/reset.sh</code> on your server to reset credentials.
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
