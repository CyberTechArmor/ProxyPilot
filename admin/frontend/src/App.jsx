import AccountSso from '@/components/AccountSso';
import LocalRecovery, { SsoComplete } from '@/pages/LocalRecovery';
import PlatformSetup from '@/pages/PlatformSetup';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Profile from '@/pages/Profile';
import Users from '@/pages/Users';
import IncusManagement from '@/pages/IncusManagement';
import HostShell from '@/pages/HostShell';
import SshAccess from '@/pages/SshAccess';
import Firewall from '@/pages/Firewall';
import Vpn from '@/pages/Vpn';
import CVEs from '@/pages/CVEs';
import McpAccess from '@/pages/McpAccess';
import Troubleshooting from '@/pages/Troubleshooting';
import Housekeeping from '@/pages/Housekeeping';
import Storage from '@/pages/Storage';
import Migrations from '@/pages/Migrations';
import Projects from '@/pages/Projects';
import OperationalProjects from '@/pages/OperationalProjects';
import OperationalProjectDetail from '@/pages/OperationalProjectDetail';
import ProjectSettings from '@/pages/ProjectSettings';
import ProjectDetail from '@/pages/ProjectDetail';
import ParentDomains from '@/pages/ParentDomains';
import ModelConnectors from '@/pages/ModelConnectors';
import Quotas from '@/pages/Quotas';
import FrameworkVersions from '@/pages/FrameworkVersions';
import ComponentLibrary from '@/pages/ComponentLibrary';
import AdminQueue from '@/pages/AdminQueue';
import DesignSpecs from '@/pages/DesignSpecs';
import HarnessGuide from '@/pages/HarnessGuide';
import Notifications from '@/pages/Notifications';
import AddDomain from '@/pages/AddDomain';
import DomainProvisioning from '@/pages/DomainProvisioning';
import TlsCertificates from '@/pages/TlsCertificates';
import Layout from '@/components/Layout';

function ProtectedRoute({ children }) {
  const { isAuthenticated, user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-viewport flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (user?.linkOnly && location.pathname !== '/link-sso') return <Navigate to="/link-sso" replace />;

  // Accounts without an assigned role (LDAP sign-ins awaiting an admin)
  // only get their profile page. The backend enforces the same rule on
  // every non-profile API surface.
  if (!user?.linkOnly && user?.role === 'pending' && location.pathname !== '/profile') {
    return <Navigate to="/profile" replace />;
  }

  return children;
}

function App() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-viewport flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/link-sso" element={<ProtectedRoute><main className="max-w-xl mx-auto p-4"><h1 className="text-xl font-semibold mb-4">Link your existing account</h1><p className="mb-4">This local proof session has no application access. Complete both identity checks to sign in through Keycloak.</p><AccountSso /></main></ProtectedRoute>} />
      <Route path="/sso-complete" element={<SsoComplete />} />
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to={sessionStorage.getItem('pp_recovery') ? '/local-recovery' : '/'} replace /> : <Login />}
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="incus" element={<IncusManagement />} />
        <Route path="users" element={<Users />} />
        <Route path="profile" element={<Profile />} />
        <Route path="admin/shell" element={<HostShell />} />
        <Route path="ssh-access" element={<SshAccess />} />
        <Route path="firewall" element={<Firewall />} />
        <Route path="vpn" element={<Vpn />} />
        {/* /security was the original single-CVE prototype; the
            broader /cves inbox supersedes it. Redirect so any old
            bookmark still lands somewhere useful. */}
        <Route path="security" element={<Navigate to="/cves" replace />} />
        <Route path="cves" element={<CVEs />} />
        <Route path="mcp-access" element={<McpAccess />} />
        <Route path="troubleshooting" element={<Troubleshooting />} />
        <Route path="housekeeping" element={<Housekeeping />} />
        <Route path="local-recovery" element={<LocalRecovery />} />
        <Route path="platform-setup" element={<PlatformSetup />} />
        {/* Host drives + ZFS pools/datasets/snapshots/replication (admin only;
            the page self-guards and the backend requires an admin session). */}
        <Route path="storage" element={<Storage />} />
        <Route path="migrations" element={<Migrations />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="domains" element={<DomainProvisioning />} />
        <Route path="tls-certificates" element={<TlsCertificates />} />
        {/* Admin-gated: the page renders inside the dashboard shell and the
            backend requires an admin session (or a provisioning API key for
            scripted clients) on every /api/domains/provision request. */}
        <Route path="add-domain" element={<AddDomain />} />
        {/* Mock2 dev/build module. The page self-guards: on a disabled or
            production-pinned host GET /api/mock2/status 404s and it bounces
            home, so the route staying registered leaks nothing. */}
        <Route path="projects" element={<Projects />} />
        <Route path="operational-projects" element={<OperationalProjects />} />
        <Route path="operational-projects/:id" element={<OperationalProjectDetail />} />
        {/* Everything that is not a project lives under Settings (the gear in
            the Projects header); the list itself stays the default view. */}
        <Route path="projects/settings" element={<ProjectSettings />} />
        <Route path="projects/domains" element={<ParentDomains />} />
        <Route path="projects/connectors" element={<ModelConnectors />} />
        <Route path="projects/quotas" element={<Quotas />} />
        <Route path="projects/framework" element={<FrameworkVersions />} />
        <Route path="projects/components" element={<ComponentLibrary />} />
        <Route path="projects/design" element={<DesignSpecs />} />
        <Route path="projects/queue" element={<AdminQueue />} />
        <Route path="projects/harness" element={<HarnessGuide />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
