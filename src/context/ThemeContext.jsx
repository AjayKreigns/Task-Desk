import { createContext, useContext, useState, useEffect, useCallback } from 'react';

// Theme ownership used to live inside Layout. It was lifted out because screens
// rendered OUTSIDE Layout — the login screen, the session-restore spinner — would
// otherwise never get `data-theme` set and would always render in light mode,
// however the user had the app configured.
//
// This is a verbatim lift: same `td_theme` key, same `data-theme` attribute on
// <html>, same toggle semantics. Layout's toggle button is unchanged.
const ThemeContext = createContext({ theme: 'light', toggleTheme: () => {}, setTheme: () => {} });

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('td_theme') || 'light';
    } catch {
      // Private-browsing / disabled storage — fall back rather than crash the app
      return 'light';
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('td_theme', theme);
    } catch {
      // Non-fatal: the theme still applies for this session
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => (t === 'light' ? 'dark' : 'light'));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
