import { useEffect } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from '../types';

export function useTheme() {
  const theme = useSettingsStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const terminalTheme = theme === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;

  return { theme, terminalTheme, isDark: theme === 'dark' };
}
