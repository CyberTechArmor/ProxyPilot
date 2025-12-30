import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Rocket, Loader2, ShieldCheck, QrCode, Copy, Check, Smartphone } from 'lucide-react';

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

  const { login } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  // Generate QR code when TOTP setup is needed
  useEffect(() => {
    if (totpSetup?.totpUri) {
      // Use Google Charts API for QR code
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(totpSetup.totpUri)}`;
      setQrCodeUrl(qrUrl);
    }
  }, [totpSetup]);

  const copySecret = () => {
    if (totpSetup?.totpSecret) {
      navigator.clipboard.writeText(totpSetup.totpSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: 'Copied!', description: 'Secret key copied to clipboard' });
    }
  };

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

      // Check if TOTP setup is required (new user without TOTP)
      if (error.totpSetupRequired) {
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
  };

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
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    required
                    autoComplete="current-password"
                  />
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={copySecret}
                      className="h-8 w-8 p-0"
                    >
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
                  <Switch
                    checked={rememberDevice}
                    onCheckedChange={setRememberDevice}
                  />
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
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={resetLogin}
              >
                Back to login
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
