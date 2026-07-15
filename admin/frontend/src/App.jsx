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
import Troubleshooting from '@/pages/Troubleshooting';
import Housekeeping from '@/pages/Housekeeping';
import Projects from '@/pages/Projects';
import ProjectDetail from '@/pages/ProjectDetail';
import ParentDomains from '@/pages/ParentDomains';
import ModelConnectors from '@/pages/ModelConnectors';
import Quotas from '@/pages/Quotas';
import FrameworkVersions from '@/pages/FrameworkVersions';
import ComponentLibrary from '@/pages/ComponentLibrary';
import AdminQueue from '@/pages/AdminQueue';
import Notifications from '@/pages/Notifications';
import Layout from '@/components/Layout';

function ProtectedRoute({ children }) {
  const { isAuthenticated, user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Accounts without an assigned role (LDAP sign-ins awaiting an admin)
  // only get their profile page. The backend enforces the same rule on
  // every non-profile API surface.
  if (user?.role === 'pending' && location.pathname !== '/profile') {
    return <Navigate to="/profile" replace />;
  }

  return children;
}

function App() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <Login />}
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
        <Route path="troubleshooting" element={<Troubleshooting />} />
        <Route path="housekeeping" element={<Housekeeping />} />
        <Route path="notifications" element={<Notifications />} />
        {/* Mock2 dev/build module. The page self-guards: on a disabled or
            production-pinned host GET /api/mock2/status 404s and it bounces
            home, so the route staying registered leaks nothing. */}
        <Route path="projects" element={<Projects />} />
        <Route path="projects/domains" element={<ParentDomains />} />
        <Route path="projects/connectors" element={<ModelConnectors />} />
        <Route path="projects/quotas" element={<Quotas />} />
        <Route path="projects/framework" element={<FrameworkVersions />} />
        <Route path="projects/components" element={<ComponentLibrary />} />
        <Route path="projects/queue" element={<AdminQueue />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
