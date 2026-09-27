import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/api/window', () => ({ WebviewWindow: { getByLabel: vi.fn(() => null) } }));
vi.mock('../store/dialogStore', () => ({ askConfirm: vi.fn() }));

import { invoke } from '@tauri-apps/api/tauri';
import { askConfirm } from '../store/dialogStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { closeConfirmText, closeSessions } from './closeSessions';
import type { Session } from '../types';

const session = (id: string, connected: boolean): Session => ({
  sessionId: id,
  connected,
  connectionStatus: connected ? 'connected' : 'disconnected',
  config: { id, name: id, protocol: 'ssh', host: id, deviceType: 'generic' },
});

const confirmMock = vi.mocked(askConfirm);

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  confirmMock.mockReset();
  useSettingsStore.setState({ confirmCloseConnected: true });
  useSessionStore.setState({
    sessions: [session('live', true), session('dead', false)],
    activeSessionId: 'live',
    poppedSessions: [],
    splitView: false,
    splitPanes: [],
  });
});

const ids = () => useSessionStore.getState().sessions.map((s) => s.sessionId);

describe('closeSessions', () => {
  it('closes a disconnected tab without asking', async () => {
    expect(await closeSessions(['dead'])).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(ids()).toEqual(['live']);
    expect(invoke).toHaveBeenCalledWith('disconnect', { sessionId: 'dead' });
  });

  it('asks before closing a connected tab and keeps it on cancel', async () => {
    confirmMock.mockResolvedValue(false);
    expect(await closeSessions(['live'])).toBe(false);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['live', 'dead']);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('closes after the user confirms', async () => {
    confirmMock.mockResolvedValue(true);
    expect(await closeSessions(['live', 'dead'])).toBe(true);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual([]);
  });

  it('does not ask when the setting is off', async () => {
    useSettingsStore.setState({ confirmCloseConnected: false });
    expect(await closeSessions(['live'])).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(ids()).toEqual(['dead']);
  });
});

describe('closeConfirmText', () => {
  it('names a single session and points at the setting', () => {
    const { title, message } = closeConfirmText([session('core-sw1', true)], 1);
    expect(title).toBe('Close core-sw1?');
    expect(message).toMatch(/Settings → Terminal/);
  });

  it('counts connected sessions when closing several', () => {
    const { title, message } = closeConfirmText([session('a', true), session('b', true)], 3);
    expect(title).toBe('Close 3 sessions?');
    expect(message).toMatch(/^2 are still connected/);
  });
});
