import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getSystemTheme, resolveAppTheme, useSystemTheme } from './useTheme';
import { DEFAULT_SETTINGS } from '../types';

/** Minimal matchMedia stand-in whose dark/light answer can be flipped. */
function mockOsTheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  };
  vi.stubGlobal('matchMedia', () => mql);
  return {
    set(next: boolean) {
      dark = next;
      listeners.forEach((cb) => cb());
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveAppTheme', () => {
  it('passes explicit choices through and follows the OS for system', () => {
    expect(resolveAppTheme('dark', 'light')).toBe('dark');
    expect(resolveAppTheme('light', 'dark')).toBe('light');
    expect(resolveAppTheme('system', 'light')).toBe('light');
    expect(resolveAppTheme('system', 'dark')).toBe('dark');
  });

  it('falls back to dark for missing or unknown values', () => {
    expect(resolveAppTheme(undefined, 'light')).toBe('dark');
    expect(resolveAppTheme('sepia' as never, 'light')).toBe('dark');
  });

  it('defaults new installs to following the OS', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system');
  });
});

describe('useSystemTheme', () => {
  it('reads the OS appearance and updates live when it changes', () => {
    const os = mockOsTheme(false);
    expect(getSystemTheme()).toBe('light');
    const { result, unmount } = renderHook(() => useSystemTheme());
    expect(result.current).toBe('light');
    act(() => os.set(true));
    expect(result.current).toBe('dark');
    unmount();
    expect(os.listenerCount()).toBe(0);
  });

  it('assumes dark when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(getSystemTheme()).toBe('dark');
  });
});
