import { useEffect, useSyncExternalStore } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { resolveTerminalTheme, ThemePreference } from '../types';

export type AppTheme = 'dark' | 'light';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function darkQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY)
    : null;
}

/** The OS appearance (macOS / Windows light or dark); dark if unknown. */
export function getSystemTheme(): AppTheme {
  const mq = darkQuery();
  if (!mq) return 'dark';
  return mq.matches ? 'dark' : 'light';
}

function subscribeSystemTheme(onChange: () => void): () => void {
  const mq = darkQuery();
  if (!mq) return () => {};
  // Older WebKit (macOS < 11 webviews) only has the deprecated addListener.
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }
  mq.addListener(onChange);
  return () => mq.removeListener(onChange);
}

/** Live OS appearance: re-renders when the user flips light/dark (or it auto-switches at dusk). */
export function useSystemTheme(): AppTheme {
  return useSyncExternalStore(subscribeSystemTheme, getSystemTheme, () => 'dark');
}

/**
 * Resolve the saved preference to the theme actually shown. Anything
 * unexpected (a hand-edited or corrupt settings file) falls back to dark,
 * the app's original default.
 */
export function resolveAppTheme(preference: ThemePreference | undefined, system: AppTheme): AppTheme {
  if (preference === 'system') return system;
  return preference === 'light' ? 'light' : 'dark';
}

export function useTheme() {
  const preference = useSettingsStore((s) => s.theme);
  const colorScheme = useSettingsStore((s) => s.colorScheme);
  const system = useSystemTheme();
  // `theme` is always the resolved 'dark' | 'light', so existing consumers
  // (data-theme, Monaco, xterm) work unchanged when the preference is 'system'.
  const theme = resolveAppTheme(preference, system);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const terminalTheme = resolveTerminalTheme(theme, colorScheme);

  return { theme, preference, terminalTheme, isDark: theme === 'dark' };
}
