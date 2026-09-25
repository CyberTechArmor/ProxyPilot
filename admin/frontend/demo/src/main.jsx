import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowRight, Check, ChevronRight, Download, FileSpreadsheet, FolderOpen,
  Globe2, LockKeyhole, LogOut, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import './styles.css';

const request = async (path, options = {}) => {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
};

function Mark({ light = false }) {
  return <span className={`mark ${light ? 'mark-light' : ''}`} aria-hidden="true"><span className="mark-slash" /></span>;
}

function Brand({ light = false }) {
  return <span className={`brand ${light ? 'brand-light' : ''}`}><Mark light={light} /><span>fractionate<span className="brand-dot">.</span></span></span>;
}

function LoginDialog({ open, onOpenChange, onSuccess, config }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { setError(''); setPassword(''); setBusy(false); }
  }, [open]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await request('/api/login', {
        method: 'POST', body: JSON.stringify({ email, password }),
      });
      onSuccess(session);
      onOpenChange(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content">
        <Dialog.Close className="dialog-close" aria-label="Close sign in dialog"><X size={19} /></Dialog.Close>
        <div className="dialog-symbol"><LockKeyhole size={23} strokeWidth={1.8} /></div>
        <p className="eyebrow">WELCOME BACK</p>
        <Dialog.Title className="dialog-title">Sign in to your workspace</Dialog.Title>
        <Dialog.Description className="dialog-description">A simple, guided space to access your project files.</Dialog.Description>
        <form onSubmit={submit} className="login-form">
          <label htmlFor="demo-email">Email address</label>
          <input id="demo-email" type="email" autoComplete="username" placeholder="you@example.com"
            value={email} onChange={(event) => setEmail(event.target.value)} required />
          <label htmlFor="demo-password">Password</label>
          <input id="demo-password" type="password" autoComplete="current-password" placeholder="Enter your password"
            value={password} onChange={(event) => setPassword(event.target.value)} required />
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button button-primary button-full" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'} <ArrowRight size={18} />
          </button>
        </form>
        {config.demoCredentials && <div className="demo-hint">
          <span className="demo-hint-icon"><Sparkles size={16} /></span>
          <div><strong>Trying the demo?</strong><p>Use <code>{config.email}</code> and <code>welcome-demo</code>.</p></div>
          <button type="button" onClick={() => { setEmail(config.email); setPassword('welcome-demo'); setError(''); }}>
            Use these
          </button>
        </div>}
        <p className="dialog-footnote"><ShieldCheck size={14} /> This is a sample workspace with example data.</p>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function SiteHeader({ onSignIn }) {
  return <header className="site-header">
    <div className="container header-inner">
      <a href="/" className="brand-link" aria-label="Fractionate demo home"><Brand /></a>
      <nav className="header-nav" aria-label="Main navigation">
        <a href="#how-it-works">How it works</a>
        <span className="nav-divider" />
        <button type="button" onClick={onSignIn} className="nav-signin">Sign in <ArrowRight size={16} /></button>
      </nav>
    </div>
  </header>;
}

function PreviewCard() {
  return <div className="preview-wrap" aria-label="Preview of the demo workspace">
    <div className="preview-aura" />
    <div className="preview-window">
      <div className="preview-toolbar"><div className="window-dots"><i /><i /><i /></div><span>demo.fractionate.ai / workspace</span><div className="preview-toolbar-icon"><ShieldCheck size={15} /></div></div>
      <div className="preview-body">
        <div className="preview-side"><Mark light /><div className="preview-side-line active" /><div className="preview-side-line" /><div className="preview-side-line short" /></div>
        <div className="preview-main">
          <div className="preview-breadcrumb">WORKSPACE <ChevronRight size={12} /> NORTHSTAR</div>
          <div className="preview-title">Your project, all in one place<span>.</span></div>
          <div className="preview-subtitle">Files and activity, neatly organized.</div>
          <div className="preview-file">
            <div className="preview-file-icon"><FileSpreadsheet size={20} /></div>
            <div className="preview-file-copy"><strong>sample-metrics.csv</strong><span>Project report · CSV file</span></div>
            <div className="preview-file-check"><Check size={16} /></div>
          </div>
          <div className="preview-progress"><span /><span /><span /></div>
        </div>
      </div>
    </div>
    <div className="floating-note"><span className="floating-icon"><Check size={15} /></span><span><strong>Ready when you are</strong><small>Your workspace is prepared</small></span></div>
  </div>;
}

function Landing({ onSignIn }) {
  return <div className="landing">
    <SiteHeader onSignIn={onSignIn} />
    <main>
      <section className="hero container">
        <div className="hero-copy">
          <div className="hero-badge"><span className="badge-pulse" /> A LITTLE SIMPLER, BY DESIGN</div>
          <h1>Your work,<br /><em>beautifully</em><br />in place.</h1>
          <p className="hero-description">A calm space for the files that move your projects forward. Sign in, find what you need, and keep going.</p>
          <div className="hero-actions">
            <button type="button" className="button button-primary button-large" onClick={onSignIn}>Enter the demo <ArrowRight size={19} /></button>
            <a className="text-link" href="#how-it-works">See how it works <ChevronRight size={17} /></a>
          </div>
          <div className="hero-trust"><span className="trust-icons"><ShieldCheck size={17} /><FolderOpen size={17} /></span> A focused, private project view</div>
        </div>
        <PreviewCard />
      </section>
      <section id="how-it-works" className="how-section">
        <div className="container how-inner">
          <div className="section-heading"><p className="eyebrow">A SMALL DEMO, A CLEAR IDEA</p><h2>Everything in its right place.</h2><p>See a straightforward sign-in and a sample file, from start to finish.</p></div>
          <div className="steps-grid">
            <article className="step-card"><div className="step-number">01</div><div className="step-icon"><Globe2 size={22} /></div><h3>Arrive</h3><p>Open a simple, welcoming landing page with one clear path forward.</p></article>
            <article className="step-card"><div className="step-number">02</div><div className="step-icon"><LockKeyhole size={22} /></div><h3>Sign in</h3><p>Use the demo login to enter a dedicated sample workspace.</p></article>
            <article className="step-card"><div className="step-number">03</div><div className="step-icon"><FileSpreadsheet size={22} /></div><h3>Get the file</h3><p>Find and download a CSV example from the project files view.</p></article>
          </div>
        </div>
      </section>
    </main>
    <footer className="site-footer"><div className="container footer-inner"><Brand /><span>Thoughtfully simple. Built for the demo.</span><span>© 2026 Fractionate</span></div></footer>
  </div>;
}

function Workspace({ session, onLogout }) {
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    request('/api/files').then((data) => setFiles(data.files)).catch((err) => setError(err.message));
  }, []);

  return <div className="workspace-shell">
    <header className="workspace-header"><div className="container workspace-header-inner"><Brand /><div className="workspace-header-right"><span className="session-pill"><span /> Demo session active</span><button type="button" className="signout" onClick={onLogout}><LogOut size={16} /> Sign out</button></div></div></header>
    <main className="workspace-main container">
      <div className="workspace-crumb">YOUR WORKSPACE <ChevronRight size={15} /> NORTHSTAR</div>
      <section className="workspace-hero"><div><div className="workspace-kicker"><Sparkles size={15} /> PROJECT WORKSPACE</div><h1>Welcome in<span>.</span></h1><p>Everything you need for this sample project, right where you expect it.</p></div><div className="workspace-hero-art"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><FolderOpen size={58} strokeWidth={1.2} /></div></section>
      <div className="workspace-layout">
        <section className="files-panel" aria-labelledby="files-heading"><div className="panel-heading"><div><p className="eyebrow">PROJECT FILES</p><h2 id="files-heading">Files to explore</h2><p>A small example document for this demo workspace.</p></div><span className="file-count">{files.length} FILE</span></div>
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="file-list">{files.map((file) => <article className="file-row" key={file.id}><div className="file-icon"><FileSpreadsheet size={25} /></div><div className="file-details"><h3>{file.name}</h3><p>{file.description}</p><span>{file.type} <i /> {file.size} bytes <i /> Updated Sep 25, 2026</span></div><a className="download-button" href={file.downloadUrl} download={file.name} aria-label={`Download ${file.name}`}><Download size={18} /><span>Download</span></a></article>)}</div>
          <div className="file-panel-foot"><ShieldCheck size={15} /> Files are available only during a signed-in demo session.</div>
        </section>
        <aside className="workspace-aside"><div className="aside-icon"><FolderOpen size={23} /></div><p className="eyebrow">ABOUT THIS SPACE</p><h3>A place for what matters.</h3><p>This demo shows the first, simplest workflow: arrive, sign in, and access a project file.</p><div className="aside-rule" /><div className="aside-row"><span>Project</span><strong>Northstar</strong></div><div className="aside-row"><span>Signed in as</span><strong>{session.email}</strong></div></aside>
      </div>
    </main>
    <footer className="workspace-footer container"><span>Fractionate demo</span><span>Sample data only · demo.fractionate.ai</span></footer>
  </div>;
}

function App() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [path, setPath] = useState(window.location.pathname);
  const [loginOpen, setLoginOpen] = useState(false);
  const [config, setConfig] = useState({ demoCredentials: false, email: null });

  useEffect(() => {
    Promise.all([request('/api/session'), request('/api/config')])
      .then(([current, options]) => { setSession(current.authenticated ? current : null); setConfig(options); })
      .catch(() => setSession(null))
      .finally(() => setReady(true));
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function go(next) {
    window.history.pushState({}, '', next);
    setPath(next);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  async function logout() {
    try { await request('/api/logout', { method: 'POST', body: '{}' }); }
    finally { setSession(null); go('/'); }
  }

  if (!ready) return <div className="app-loading"><Brand /><span>Preparing your workspace…</span></div>;
  if (path === '/workspace' && session) return <Workspace session={session} onLogout={logout} />;
  return <><Landing onSignIn={() => setLoginOpen(true)} /><LoginDialog open={loginOpen} onOpenChange={setLoginOpen}
    config={config} onSuccess={(value) => { setSession(value); go('/workspace'); }} /></>;
}

createRoot(document.getElementById('root')).render(<App />);
