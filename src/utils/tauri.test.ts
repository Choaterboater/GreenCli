import { afterEach, describe, expect, it, vi } from 'vitest';

// The shape most component tests use: core mocked with only `invoke`.
// utils/tauri must still load (it must not need `isTauri` from core).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const g = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  delete g.isTauri;
  vi.doUnmock('@tauri-apps/api/window');
  vi.resetModules();
});

describe('utils/tauri outside the app', () => {
  it('loads with a core mock that only has invoke, and so does fileSystem', async () => {
    await expect(import('./tauri')).resolves.toBeDefined();
    await expect(import('./fileSystem')).resolves.toBeDefined();
  });

  it('is not Tauri, and the window is main', async () => {
    const t = await import('./tauri');
    expect(t.isTauri).toBe(false);
    expect(t.currentWindowLabel()).toBe('main');
    expect(t.currentWindow()).toBeNull();
    const fs = await import('./fileSystem');
    expect(fs.isTauri).toBe(false);
  });

  it('focusing or closing a window does nothing', async () => {
    const t = await import('./tauri');
    await expect(t.focusWindow('popout-x')).resolves.toBeUndefined();
    await expect(t.closeWindow('popout-x')).resolves.toBeUndefined();
  });
});

describe('utils/tauri inside the app', () => {
  function mockWindows(found: { setFocus: () => Promise<void>; close: () => Promise<void> } | null) {
    const getByLabel = vi.fn(async () => found);
    vi.doMock('@tauri-apps/api/window', () => ({
      Window: { getByLabel },
      getCurrentWindow: vi.fn(() => ({ label: 'popout-abc' })),
    }));
    return getByLabel;
  }

  it('reads isTauri from the global Tauri 2 sets', async () => {
    g.isTauri = true;
    mockWindows(null);
    vi.resetModules();
    const t = await import('./tauri');
    expect(t.isTauri).toBe(true);
    expect(t.currentWindowLabel()).toBe('popout-abc');
    const fs = await import('./fileSystem');
    expect(fs.isTauri).toBe(true);
  });

  it('focuses and closes a window by label', async () => {
    g.isTauri = true;
    const win = { setFocus: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const getByLabel = mockWindows(win);
    vi.resetModules();
    const t = await import('./tauri');
    await t.focusWindow('popout-1');
    expect(getByLabel).toHaveBeenCalledWith('popout-1');
    expect(win.setFocus).toHaveBeenCalledTimes(1);
    await t.closeWindow('popout-1');
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('a window that is not open is a no-op', async () => {
    g.isTauri = true;
    const getByLabel = mockWindows(null);
    vi.resetModules();
    const t = await import('./tauri');
    await expect(t.focusWindow('popout-gone')).resolves.toBeUndefined();
    await expect(t.closeWindow('popout-gone')).resolves.toBeUndefined();
    expect(getByLabel).toHaveBeenCalledTimes(2);
  });
});
