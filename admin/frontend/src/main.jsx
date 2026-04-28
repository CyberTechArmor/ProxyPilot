import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './context/AuthContext'
import { Toaster } from './components/ui/toaster'
import SudoProvider from './components/SudoModal'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <SudoProvider>
          <App />
          <Toaster />
        </SudoProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
