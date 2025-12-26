import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Rocket, Loader2, ShieldCheck } from 'lucide-react';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [loading, setLoading] = useState(false);

  const { login } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      await login({ username, password, totpCode: totpRequired ? totpCode : '' });
      navigate('/');
    } catch (error) {
      // Check if TOTP is required
      if (error.totpRequired) {
        setTotpRequired(true);
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <Rocket className="h-12 w-12 text-primary" />
          </div>
          <CardTitle className="text-2xl">ProxyPilot Admin</CardTitle>
          <CardDescription>
            Sign in to manage your proxy services
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
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
                disabled={totpRequired}
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
                disabled={totpRequired}
              />
            </div>

            {totpRequired && (
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
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </Button>

            {totpRequired && (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setTotpRequired(false);
                  setTotpCode('');
                }}
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
