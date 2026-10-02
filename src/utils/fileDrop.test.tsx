import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// Inside the app: Tauri 2 sets this global before any page script runs.
vi.hoisted(() => {
  (globalThis as unknown as Record<string, unknown>).isTauri = true;
});

type Handler = (event: { payload: Record<string, unknown> }) => void;
const webview = vi.hoisted(() => ({
  handler: null as Handler | null,
  unlisten: vi.fn(),
  // Resolves the pending onDragDropEvent call (set per test).
  resolve: null as (() => void) | null,
  deferred: false,
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: Handler) => {
      webview.handler = handler;
      if (!webview.deferred) return Promise.resolve(webview.unlisten);
      return new Promise((resolve) => {
        webview.resolve = () => resolve(webview.unlisten);
      });
    },
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
const askConfirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../store/dialogStore', () => ({ askConfirm, askPrompt: vi.fn() }));

import { listenFileDrops } from './fileDrop';
import SftpBrowser from '../components/SftpBrowser';

beforeEach(() => {
  webview.handler = null;
  webview.unlisten.mockClear();
  webview.resolve = null;
  webview.deferred = false;
  askConfirm.mockClear();
});

describe('listenFileDrops', () => {
  it('maps Tauri 2 drag-drop events to enter, leave and drop', async () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    const onDrop = vi.fn();
    const un = await listenFileDrops({ onEnter, onLeave, onDrop });
    const fire = (payload: Record<string, unknown>) => webview.handler!({ payload });

    fire({ type: 'enter', paths: ['/a'], position: { x: 1, y: 2 } });
    fire({ type: 'over', position: { x: 3, y: 4 } });
    expect(onEnter).toHaveBeenCalledTimes(2);
    fire({ type: 'leave' });
    expect(onLeave).toHaveBeenCalledTimes(1);
    fire({ type: 'drop', paths: ['/tmp/a b.txt', '/tmp/c'], position: { x: 0, y: 0 } });
    expect(onDrop).toHaveBeenCalledWith(['/tmp/a b.txt', '/tmp/c']);

    un();
    expect(webview.unlisten).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside the app', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.isTauri;
    vi.resetModules();
    try {
      const fresh = await import('./fileDrop');
      const un = await fresh.listenFileDrops({ onDrop: vi.fn() });
      expect(webview.handler).toBeNull();
      expect(() => un()).not.toThrow();
    } finally {
      g.isTauri = true;
      vi.resetModules();
    }
  });

  it('works with only some handlers', async () => {
    await listenFileDrops({});
    expect(() => webview.handler!({ payload: { type: 'drop', paths: ['/x'] } })).not.toThrow();
  });
});

describe('SftpBrowser file drops', () => {
  it('a drop asks before uploading', async () => {
    render(<SftpBrowser sessionId="s1" onClose={() => {}} />);
    await waitFor(() => expect(webview.handler).not.toBeNull());
    webview.handler!({ payload: { type: 'drop', paths: ['/home/me/fw.bin'] } });
    await waitFor(() => expect(askConfirm).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(askConfirm.mock.calls[0])).toContain('fw.bin');
  });

  it('stops listening when closed before the listener is ready', async () => {
    webview.deferred = true;
    const { unmount } = render(<SftpBrowser sessionId="s1" onClose={() => {}} />);
    await waitFor(() => expect(webview.resolve).not.toBeNull());
    unmount();
    expect(webview.unlisten).not.toHaveBeenCalled();
    webview.resolve!();
    await waitFor(() => expect(webview.unlisten).toHaveBeenCalledTimes(1));
  });
});
