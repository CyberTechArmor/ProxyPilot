import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import { Toaster } from './components/ui/toaster'
import SudoProvider from './components/SudoModal'
import UpdateBanner from './components/UpdateBanner'
import './index.css'
import { registerServiceWorker } from './lib/pwa'
import { loadBranding } from './lib/branding'

// Registered before React mounts so an update that is already waiting is seen
// on the first frame rather than a minute later.
registerServiceWorker()
// Platform branding (name / logo / favicon) — fetched once, applied to the
// document, readable everywhere via useBranding(). Public endpoint, so it
// also brands the login page.
loadBranding()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <SudoProvider>
            <App />
            <Toaster />
            <UpdateBanner />
          </SudoProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
