// Color palettes only: every theme shares typography, icons and component layout.
// index.html applies the same normalization before React/CSS paint.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState } from 'react';
import { normalizeTheme, THEME_STORAGE_KEY, THEMES } from '@/lib/theme';
const ThemeContext = createContext({ theme: 'midnight', setTheme: () => {} });
function getInitialTheme() {
  try { return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return 'midnight'; }
}
export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(getInitialTheme);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'midnight');
    root.dataset.theme = theme;
    root.style.colorScheme = theme === 'midnight' ? 'dark' : 'light';
    try { window.localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* blocked storage */ }
  }, [theme]);
  useEffect(() => {
    const sync = event => { if (event.key === THEME_STORAGE_KEY) setThemeState(normalizeTheme(event.newValue)); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const setTheme = useCallback(value => setThemeState(normalizeTheme(value)), []);
  const toggleTheme = useCallback(() => setThemeState(value => THEMES[(THEMES.findIndex(t => t.id === value) + 1) % THEMES.length].id), []);
  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>;
}
export function useTheme() { return useContext(ThemeContext); }
