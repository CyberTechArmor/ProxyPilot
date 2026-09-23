import { Navigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import FullPlatformSetup from '@/components/FullPlatformSetup';

// Platform Setup has one path: Full Platform — all five services installed and
// managed as one system, in stages A–E (components/FullPlatformSetup.jsx).
// The former Custom / Advanced experience and its per-service connect/skip
// choices were removed.
export default function PlatformSetup() {
  const { user, loading } = useAuth();
  if (loading) return <p role="status">Loading…</p>;
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <FullPlatformSetup />;
}
