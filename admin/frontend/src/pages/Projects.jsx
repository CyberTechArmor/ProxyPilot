// Projects — the Mock2 dev/build module landing page.
//
// Phase M0 ships this as an intentional placeholder: the module gate and
// schema exist, but projects, chat, and cycles arrive in later phases
// (M2+). The page is reachable only when the backend reports Mock2 enabled
// (GET /api/mock2/status → 200); on a disabled or production-pinned host
// the route 404s and both this page and its nav entry are hidden. We
// re-check status here so a direct URL visit on a disabled host bounces
// home rather than rendering an orphaned shell.
//
// MOBILE_FIRST: single-column, no fixed widths, 16px mobile padding from
// the Layout wrapper. Renders cleanly at 360px with no horizontal scroll.

import { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FolderGit2, Loader2, Globe } from 'lucide-react';

export default function Projects() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';

  // 'checking' | 'enabled' | 'disabled'
  const [gate, setGate] = useState('checking');

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => { if (!cancelled) setGate('enabled'); })
      .catch((err) => {
        // 404 = module absent (disabled/pinned host). Anything else we also
        // treat as not-available rather than rendering a broken page.
        if (!cancelled) setGate('disabled');
        if (!(err instanceof ApiError)) console.error('mock2 status check failed:', err);
      });
    return () => { cancelled = true; };
  }, []);

  if (!isAdmin) return <Navigate to="/" replace />;
  if (gate === 'disabled') return <Navigate to="/" replace />;

  if (gate === 'checking') {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FolderGit2 className="h-6 w-6 shrink-0 text-primary" />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight truncate">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Mock2 dev/build module
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <Globe className="h-5 w-5 shrink-0 text-primary" />
                Parent domains
              </CardTitle>
              <CardDescription>
                Register dev domains and issue per-slug TLS so projects get live HTTPS URLs.
              </CardDescription>
            </div>
            <Button asChild className="h-11 sm:h-10 shrink-0">
              <Link to="/projects/domains">Manage domains</Link>
            </Button>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>No projects yet</CardTitle>
          <CardDescription>
            The Mock2 module is enabled. Creating projects — with per-project
            containers, git repos, and live URLs — arrives in a later phase.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Parent domains and per-slug TLS are in place (Phase M1). Project
            provisioning and the build workflow ship next.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
