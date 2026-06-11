import { useEffect } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { resolveTerminalTheme } from '../types';

export function useTheme() {
  const theme = useSettingsStore((s) => s.theme);
  const colorScheme = useSettingsStore((s) => s.colorScheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const terminalTheme = resolveTerminalTheme(theme, colorScheme);

  return { theme, terminalTheme, isDark: theme === 'dark' };
}
