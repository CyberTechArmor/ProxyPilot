import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter,Routes,Route} from 'react-router-dom';
import BrowserSessions from '../src/pages/BrowserSessions';
import {AuthProvider,useAuth} from '../src/context/AuthContext';
import '../src/index.css';
function AccountSwitch(){const {login}=useAuth();return <button className="min-h-11" onClick={()=>login({username:'second-fixture'})}>Fixture: switch account</button>;}
createRoot(document.getElementById('root')).render(<React.StrictMode><AuthProvider><BrowserRouter><main className="h-screen p-4 md:p-8"><Routes><Route path="/sessions-fixture" element={<BrowserSessions/>}/><Route path="/operational-projects/:id" element={<h1>Task setup destination</h1>}/></Routes></main><AccountSwitch/></BrowserRouter></AuthProvider></React.StrictMode>);
