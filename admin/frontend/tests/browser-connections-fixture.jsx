// Disposable visual/API fixture. It is not an app route or live acceptance.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import { BrowserConnections } from '../src/components/operational-projects/BrowserConnections';
import '../src/index.css';
const projectId = 'e4b21c1e-2137-478b-a1af-c33438e8e000';
function Fixture() {
  const { login } = useAuth();
  const [project, setProject] = useState({ id: projectId, revision: 7, own_role: 'owner', archived_at: null });
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('modal')) return;
    const timer = setInterval(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent === 'Add connection'); if (button && !button.disabled) { button.click(); clearInterval(timer); } }, 50);
    return () => clearInterval(timer);
  }, []);
  return <main className="operations-ui broker-colors" style={{ margin: 'auto', padding: 24, maxWidth: 980 }}><h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>Project setup</h1><BrowserConnections base={`/${projectId}`} project={project} /><button style={{ minHeight: 44 }} onClick={() => setProject({ ...project, own_role: 'viewer' })}>Fixture: change role</button><button style={{ minHeight: 44 }} onClick={() => login({ username: 'second-fixture' })}>Fixture: change identity</button></main>;
}
createRoot(document.getElementById('root')).render(<AuthProvider><Fixture /></AuthProvider>);
