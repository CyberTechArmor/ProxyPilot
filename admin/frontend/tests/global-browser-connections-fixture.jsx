import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {AuthProvider,useAuth} from '../src/context/AuthContext';
import Connections from '../src/pages/Connections';
import '../src/index.css';
function Fixture(){const {login}=useAuth();return <><main className="h-screen p-4 md:p-8"><Connections/></main><button className="min-h-11" onClick={()=>login({username:'second-fixture'})}>Fixture: switch account</button></>;}
createRoot(document.getElementById('root')).render(<React.StrictMode><AuthProvider><BrowserRouter><Fixture/></BrowserRouter></AuthProvider></React.StrictMode>);
