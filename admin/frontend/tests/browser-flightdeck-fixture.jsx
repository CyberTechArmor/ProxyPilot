import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { BrowserAgents } from '../src/components/operational-projects/BrowserAgents';
import { AuthProvider } from '../src/context/AuthContext';
import { ThemeProvider } from '../src/context/ThemeContext';
import Layout from '../src/components/Layout';
import OperationalProjectDetail from '../src/pages/OperationalProjectDetail';
import '../src/index.css';
const id='11111111-1111-4111-8111-111111111111';
const integrated=new URLSearchParams(location.search).get('integrated')==='1';
const workspace=new URLSearchParams(location.search).get('workspace')==='1';
createRoot(document.getElementById('root')).render(<ThemeProvider>{integrated?
  <AuthProvider><MemoryRouter initialEntries={[`/operational-projects/${id}${workspace?'':'?section=Agents&browser_run=22222222-2222-4222-8222-222222222222'}`]}><Routes><Route element={<Layout/>}><Route path="/operational-projects/:id" element={<OperationalProjectDetail/>}/></Route></Routes></MemoryRouter></AuthProvider>:
  <main className="p-4"><BrowserAgents base={`/${id}`} project={{id,own_role:'owner',revision:1}}/></main>}</ThemeProvider>);
