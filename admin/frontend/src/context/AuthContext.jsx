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
