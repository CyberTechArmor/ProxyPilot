import { Routes, Route, Navigate } from 'react-router-dom';
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
import Layout from '@/components/Layout';

function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();

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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
