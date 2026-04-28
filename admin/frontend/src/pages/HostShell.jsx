import { useAuth } from '@/context/AuthContext';
import { Navigate } from 'react-router-dom';
import InteractiveTerminal from '@/components/InteractiveTerminal';
import { TerminalSquare, Shield } from 'lucide-react';

// Admin-only host-shell entry. Backend `requireAdmin` is the
// authoritative gate (terminal-ws.js rejects non-admin upgrades with
// 403); the frontend redirect just keeps non-admins from staring at a
// useless page.
function HostShell() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <TerminalSquare className="h-5 w-5 text-cyan-500" />
        <h1 className="text-lg font-semibold">Host Shell</h1>
        <span className="ml-2 inline-flex items-center gap-1 text-[10px] uppercase font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded">
          <Shield className="h-3 w-3" /> Admin only
        </span>
      </div>
      <p className="text-xs text-muted-foreground shrink-0">
        Live root shell on the ProxyPilot host. Every command is audited; the
        session is killed after 15 minutes of inactivity.
      </p>
      <div className="flex-1 min-h-0 flex flex-col">
        <InteractiveTerminal wsPath="/api/terminal/host" />
      </div>
    </div>
  );
}

export default HostShell;
