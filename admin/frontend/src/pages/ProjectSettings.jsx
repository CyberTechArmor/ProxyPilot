// Projects → Settings — the module's admin surfaces, gathered off the list.
//
// The Projects page used to carry the parent-domains card plus seven admin
// tiles above the project grid, which pushed the projects themselves below the
// fold. Everything that is NOT a project now lives here, behind the gear icon
// in the Projects header; the project list is the default view again.
//
// This page only ROUTES — each destination page keeps its own admin gate and
// its own Mock2-enabled self-guard, so nothing here re-implements authorization.
//
// MOBILE_FIRST: one column of full-width entries at <sm, two at sm, three at
// lg; every entry is a ≥44px tap target. Renders clean at 360px.

import { useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft, Blocks, BookText, Cpu, Globe, Inbox, Loader2, Palette, Settings, Wallet, Workflow,
} from 'lucide-react';

// The admin surfaces, in the order they matter to an operator setting the
// module up: domains first (nothing works without one), then the model/budget
// wiring, then the build-time knobs, then the review queue.
const SECTIONS = [
  {
    to: '/projects/domains',
    Icon: Globe,
    title: 'Parent domains',
    blurb: 'Register dev domains and issue per-slug TLS so projects get live HTTPS URLs.',
  },
  {
    to: '/projects/connectors',
    Icon: Cpu,
    title: 'Connectors',
    blurb: 'Model providers, concurrency slots, and the git remotes projects push to.',
  },
  {
    to: '/projects/quotas',
    Icon: Wallet,
    title: 'Quotas',
    blurb: 'Per-project budgets, spend caps, and the reservation buffer.',
  },
  {
    to: '/projects/framework',
    Icon: BookText,
    title: 'Framework',
    blurb: 'The versioned build framework — edit, publish, and revert versions.',
  },
  {
    to: '/projects/components',
    Icon: Blocks,
    title: 'Components',
    blurb: 'Reusable blocks, their versions, and submissions awaiting review.',
  },
  {
    to: '/projects/design',
    Icon: Palette,
    title: 'Design specs',
    blurb: 'Base-look presets, design tokens, and how a style binds to a build.',
  },
  {
    to: '/projects/harness',
    Icon: Workflow,
    title: 'Harness',
    blurb: 'Per-step model, effort, and thinking budget — plus the harness guide.',
  },
  {
    to: '/projects/queue',
    Icon: Inbox,
    title: 'Admin queue',
    blurb: 'Deviations, framework drift, and flagged projects awaiting a decision.',
  },
];

export default function ProjectSettings() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';

  const [gate, setGate] = useState('checking'); // 'checking' | 'enabled' | 'disabled'

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => { if (!cancelled) setGate('enabled'); })
      .catch((err) => {
        if (!cancelled) setGate('disabled');
        if (!(err instanceof ApiError)) console.error('mock2 status check failed:', err);
      });
    return () => { cancelled = true; };
  }, []);

  // Settings are admin-only; a developer-permission user bounces back to the
  // project list rather than home, which is where they came from.
  if (!isAdmin) return <Navigate to="/projects" replace />;
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
        <Button asChild variant="ghost" size="icon" className="h-11 w-11 shrink-0">
          <Link to="/projects" aria-label="Back to projects"><ArrowLeft className="h-5 w-5" /></Link>
        </Button>
        <Settings className="h-6 w-6 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight truncate">Project settings</h1>
          <p className="text-sm text-muted-foreground">Domains, connectors, budgets, and build configuration</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map(({ to, Icon, title, blurb }) => (
          <Link
            key={to}
            to={to}
            className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Card className="h-full min-w-0 transition-colors hover:border-primary/50 hover:bg-accent/40">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Icon className="h-5 w-5 shrink-0 text-primary" />
                  <span className="truncate">{title}</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription>{blurb}</CardDescription>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
