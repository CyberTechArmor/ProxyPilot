import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserAgents } from '../src/components/operational-projects/BrowserAgents';
import '../src/index.css';
createRoot(document.getElementById('root')).render(<main className="p-4"><BrowserAgents base="/11111111-1111-4111-8111-111111111111" project={{id:'11111111-1111-4111-8111-111111111111',own_role:'owner',revision:1}}/></main>);
