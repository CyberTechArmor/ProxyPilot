// Test-only compatibility surface. App/main never import this file. It mounts
// current shared components and never restores retired product creation paths.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ThemeSelector } from '../../src/components/ThemeSelector';
import SudoProvider from '../../src/components/SudoModal';
import BrokerTasks from '../../src/components/BrokerTasks';
import { BrokerAgents } from '../../src/components/operational-projects/BrokerAgents';
import { ConnectionCatalogue } from '../../src/components/operational-projects/Connections';
import { operationsApi, connectionsApi } from '../../src/lib/api';
import { refreshConnectionSelections } from '../../src/components/operational-projects/connection-ui-logic';
import '../../src/index.css';

const options = new URLSearchParams(location.search);
const view = options.get('view') || 'catalogue';
const projectId = options.get('project') || options.get('project_id');
const agentId = options.get('agent') || options.get('agent_id');
// Explicit test calls use the actual app API client, preserving CSRF, revision
// headers and sudo rather than creating a fake retired configuration form.
window.legacyBrokerFixture = {
  operations: { get: (...args) => operationsApi.get(...args), write: (...args) => operationsApi.write(...args) },
  connections: { get: (...args) => connectionsApi.get(...args), write: (...args) => connectionsApi.write(...args) },
  selected: [],
};

function Fixture() {
  const [project,setProject] = useState(null), [agent,setAgent] = useState(null), [error,setError] = useState(''), [selected,setSelected] = useState([]);
  const history = ['history','agents'].includes(view);
  useEffect(() => {
    if (!history && view !== 'tasks') return;
    const controller = new AbortController();
    const path = history ? `/${projectId}` : `/${projectId}/agent-configurations`;
    operationsApi.get(path,controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (history) setProject(result.project);
      else { const current = result.agents.find(row => row.id === agentId); if (!current) throw Error('Disposable saved agent is unavailable.'); setAgent(current); }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  },[]);
  useEffect(() => { window.legacyBrokerFixture.selected = selected; },[selected]);
  const catalogue = <ConnectionCatalogue projectId={projectId || undefined} agentId={view==='picker' ? agentId || undefined : undefined}
    onSelect={view==='picker' ? connection=>setSelected(old=>old.some(row=>row.id===connection.id)?old.filter(row=>row.id!==connection.id):[...old,{...connection,allowedOperations:[...connection.operations],allowedResources:[...connection.resources]}]) : undefined}
    selectedIds={selected.map(row=>row.id)} onCatalogueChange={rows=>setSelected(old=>refreshConnectionSelections(old,rows))}/>;
  return <main className="operations-ui broker-colors min-w-0 mx-auto max-w-screen-xl p-4 sm:p-6 space-y-5" data-testid="legacy-broker-fixture">
    <header className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between"><div><h1 className="text-2xl font-semibold">Legacy broker compatibility</h1><p className="text-sm text-muted-foreground">Disposable fixture; these sample workflows are retired from the product.</p></div><ThemeSelector/></header>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {history ? project && <BrokerAgents project={project}/> : view==='tasks' ? agent && <BrokerTasks projectId={projectId} agent={agent}/> : catalogue}
    {view==='picker' && <p role="status" data-testid="legacy-selection">{selected.length} transient selections. No assignment or run has been created.</p>}
  </main>;
}
createRoot(document.getElementById('root')).render(<ThemeProvider><AuthProvider><SudoProvider><MemoryRouter><Fixture/></MemoryRouter></SudoProvider></AuthProvider></ThemeProvider>);
