export const THEMES = Object.freeze([
  { id: 'midnight', name: 'Midnight' },
  { id: 'latte', name: 'Latte' },
  { id: 'office', name: 'Office' },
]);
export const THEME_STORAGE_KEY = 'pp-theme';
export function normalizeTheme(value) {
  if (value === 'light') return 'office';
  if (value === 'dark') return 'midnight';
  return THEMES.some(theme => theme.id === value) ? value : 'midnight';
}
