import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/api/window', () => ({ WebviewWindow: { getByLabel: vi.fn(() => null) } }));
vi.mock('../store/dialogStore', () => ({ askPrompt: vi.fn(), askConfirm: vi.fn() }));

import TerminalTabs from './TerminalTabs';
import { askPrompt } from '../store/dialogStore';
import { useSessionStore } from '../store/sessionStore';
import type { ConnectionConfig, Session } from '../types';

const saved: ConnectionConfig = {
  id: 'saved-core',
  name: 'core-sw-01',
  protocol: 'ssh',
  host: '10.1.1.1',
  deviceType: 'aruba-cx',
};

const tab = (sessionId: string, extra: Partial<ConnectionConfig> = {}, state: Partial<Session> = {}): Session => ({
  sessionId,
  connected: true,
  connectionStatus: 'connected',
  config: { ...saved, id: sessionId, savedId: 'saved-core', ...extra },
  ...state,
});

beforeEach(() => {
  vi.mocked(askPrompt).mockReset();
  useSessionStore.setState({
    sessions: [
      tab('t1'),
      tab('t2', { copyNumber: 2 }, { configMode: true, promptHost: 'core-sw-01' }),
      tab('t3', { name: '10.2.2.2', host: '10.2.2.2', savedId: 'adhoc' }, { promptHost: 'edge-sw-07' }),
    ],
    activeSessionId: 't1',
    poppedSessions: [],
    unseenOutput: [],
    splitView: false,
    splitPanes: [],
  });
});

const openMenu = (label: string) => fireEvent.contextMenu(screen.getByText(label));

describe('TerminalTabs', () => {
  it('numbers a second tab of one host and names IP-only tabs from the prompt', () => {
    render(<TerminalTabs />);
    expect(screen.getByText('core-sw-01')).toBeInTheDocument();
    expect(screen.getByText('core-sw-01 (2)')).toBeInTheDocument();
    expect(screen.getByText('edge-sw-07')).toBeInTheDocument();
  });

  it('badges only the tab whose device is in config mode', () => {
    render(<TerminalTabs />);
    expect(screen.getAllByText('CONFIG')).toHaveLength(1);
    expect(screen.getByText('core-sw-01 (2)').closest('[title]')?.getAttribute('title')).toContain('In config mode');
  });

  it('Duplicate tab asks the app for another session to that host', () => {
    const onDuplicate = vi.fn();
    render(<TerminalTabs onDuplicate={onDuplicate} />);
    openMenu('core-sw-01 (2)');
    fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate tab/ }));
    expect(onDuplicate).toHaveBeenCalledWith('t2');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('offers Disconnect for a live tab and Reconnect for a dropped one', () => {
    useSessionStore.setState({
      sessions: [tab('t1'), tab('t9', { copyNumber: 2 }, { connected: false, connectionStatus: 'disconnected' })],
    });
    const onReconnect = vi.fn();
    render(<TerminalTabs onReconnect={onReconnect} />);
    openMenu('core-sw-01');
    expect(screen.getByRole('menuitem', { name: /Reconnect/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /Disconnect/ })).toBeEnabled();
    // Escape closes the menu.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    openMenu('core-sw-01 (2)');
    expect(screen.getByRole('menuitem', { name: /Disconnect/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('menuitem', { name: /Reconnect/ }));
    expect(onReconnect).toHaveBeenCalledWith('t9');
  });

  it('Rename tab renames only the tab; clearing it goes back to the automatic name', async () => {
    vi.mocked(askPrompt).mockResolvedValueOnce('  uplink work ');
    render(<TerminalTabs />);
    openMenu('core-sw-01');
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename tab/ }));
    await waitFor(() => expect(screen.getByText('uplink work')).toBeInTheDocument());
    const renamed = useSessionStore.getState().sessions.find((s) => s.sessionId === 't1')!;
    expect(renamed.config).toMatchObject({ tabName: 'uplink work', name: 'core-sw-01' });

    vi.mocked(askPrompt).mockResolvedValueOnce('');
    fireEvent.doubleClick(screen.getByText('uplink work'));
    await waitFor(() => expect(screen.getByText('core-sw-01')).toBeInTheDocument());
  });

  it('Close disconnected tabs is only offered when a tab has dropped', () => {
    render(<TerminalTabs />);
    openMenu('core-sw-01');
    expect(screen.getByRole('menuitem', { name: /Close disconnected tabs/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /Close other tabs/ })).toBeEnabled();
  });
});
