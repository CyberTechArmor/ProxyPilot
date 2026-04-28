import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import InteractiveTerminal from '@/components/InteractiveTerminal';
import { TerminalSquare, ShieldAlert } from 'lucide-react';

// Admin-only host shell. The backend rejects /api/terminal/host with
// 403 when the JWT role isn't 'admin', so this UI gate is purely
// cosmetic — defense in depth, not the security boundary.
export default function HostShell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) {
      navigate('/', { replace: true });
    }
  }, [isAdmin, navigate]);

  if (!isAdmin) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldAlert className="h-4 w-4" />
        Admin role required.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-8rem)] min-h-[400px]">
      <div className="flex items-center gap-2">
        <TerminalSquare className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-bold">Host Shell</h1>
        <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 border border-amber-500/30">
          admin
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Live PTY against the host's bash session. Idle sessions are killed
        after the configured timeout; concurrent sessions are capped per
        user. Audit log records the start, end, duration, and byte counts.
      </p>
      <div className="flex-1 min-h-0">
        <InteractiveTerminal wsPath="/api/terminal/host" />
      </div>
    </div>
  );
}
