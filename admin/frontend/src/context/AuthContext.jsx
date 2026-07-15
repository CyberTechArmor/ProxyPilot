import { createContext, useContext, useState, useEffect } from 'react';
import { api } from '@/lib/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Token is in an httpOnly cookie now, so JS can't see it. Optimistic
    // hydration: if a stored user object exists from a previous session,
    // render with it immediately; either way, hit /api/auth/verify with
    // credentials:'include' to confirm the cookie is still valid.
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      try { setUser(JSON.parse(storedUser)); } catch { /* corrupt cache */ }
    }
    api.verify()
      .then(({ user }) => {
        setUser(user);
        localStorage.setItem('user', JSON.stringify(user));
      })
      .catch(() => {
        localStorage.removeItem('user');
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  // Realtime role/permission propagation: while logged in, re-verify
  // every 30s so an admin assigning a role or feature permission shows
  // up in this session (nav, route guards) without a re-login. The
  // backend enforces from the DB per-request either way — this only
  // keeps the UI in step. Transient poll failures are ignored; a real
  // 401 is handled by the api layer's redirect-to-login.
  const authed = !!user;
  useEffect(() => {
    if (!authed) return undefined;
    const id = setInterval(() => {
      api.verify()
        .then(({ user: fresh }) => {
          localStorage.setItem('user', JSON.stringify(fresh));
          setUser((prev) =>
            JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh
          );
        })
        .catch(() => { /* tolerated — next poll retries */ });
    }, 30_000);
    return () => clearInterval(id);
  }, [authed]);

  const login = async (credentials) => {
    // Backend sets pp_token (httpOnly) and pp_csrf cookies on success.
    // Token in the response body is ignored — kept for non-browser
    // client backwards compatibility only.
    const { user } = await api.login(credentials);
    localStorage.setItem('user', JSON.stringify(user));
    setUser(user);
    return user;
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch (error) {
      // Ignore logout errors — backend will have already cleared
      // the cookies if the call reached it.
    }
    localStorage.removeItem('user');
    setUser(null);
  };

  const value = {
    user,
    loading,
    login,
    logout,
    isAuthenticated: !!user,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
