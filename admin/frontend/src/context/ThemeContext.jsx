// Light/dark theme. The token palettes live in index.css (:root = light,
// .dark = dark); this context just owns which one is active by toggling the
// `dark` class on <html> and persisting the choice.
//
// Default is DARK — ProxyPilot historically shipped dark-only, so existing
// users see no change until they flip the sun/moon toggle. A pre-paint
// inline script in index.html applies the stored class before React mounts
// so there's no flash of the wrong theme on load; this provider keeps it in
// sync afterward.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const STORAGE_KEY = 'pp-theme';
const ThemeContext = createContext({ theme: 'dark', toggleTheme: () => {}, setTheme: () => {} });

function getInitialTheme() {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'dark';
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    // Tell the UA so native form controls, scrollbars and the like match.
    root.style.colorScheme = theme;
    try { window.localStorage.setItem(STORAGE_KEY, theme); } catch { /* private mode */ }
  }, [theme]);

  const setTheme = useCallback((t) => setThemeState(t === 'light' ? 'light' : 'dark'), []);
  const toggleTheme = useCallback(() => setThemeState((t) => (t === 'dark' ? 'light' : 'dark')), []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
