import { ConnectionCatalogue } from '@/components/operational-projects/Connections';
export default function Connections() {
  return <div className="operations-ui w-full max-w-screen-2xl mx-auto space-y-6 min-w-0"><header><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Access</p><h1 className="operations-title">Connections</h1><p className="text-base text-muted-foreground mt-2">Manage reusable connections and their permitted use.</p></header><ConnectionCatalogue /></div>;
}
