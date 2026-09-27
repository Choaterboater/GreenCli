import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

import { invoke } from '@tauri-apps/api/tauri';
import ActivityBar from './ActivityBar';
import { useSessionStore } from '../store/sessionStore';
import { useSidePanelStore } from '../store/sidePanelStore';
import type { Session } from '../types';

const tab = (sessionId: string, state: Partial<Session> = {}): Session => ({
  sessionId,
  connected: true,
  connectionStatus: 'connected',
  config: { id: sessionId, name: sessionId, protocol: 'ssh', host: '10.0.0.1', deviceType: 'aruba-cx' },
  ...state,
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue([]);
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    sidebarVisible: true,
    showConfigEditor: false,
    showApiExplorer: false,
    showAiAssistant: false,
    showIntent: false,
  });
  useSidePanelStore.setState({ maximized: false, status: {} });
});

describe('ActivityBar', () => {
  it('labels every place and tool for screen readers', () => {
    render(<ActivityBar />);
    for (const name of [
      'Sessions',
      'Config Editor',
      'API Explorer',
      'AI Assistant',
      'Bulk Runner',
      'Change Jobs',
      'Config Archive',
      'Network Intent',
      'SSH Tunnels',
      'SFTP',
      'Import Hosts',
      'Help',
      'Settings',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('switches the side panel to a tab, and closes it from the tab that is showing', () => {
    render(<ActivityBar />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant' }));
    expect(useSessionStore.getState().showAiAssistant).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Config Editor' }));
    expect(useSessionStore.getState()).toMatchObject({ showConfigEditor: true, showAiAssistant: false });
    expect(screen.getByRole('button', { name: 'Config Editor' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Config Editor' }));
    expect(useSessionStore.getState().showConfigEditor).toBe(false);
  });

  it('counts dropped sessions on the Sessions icon', () => {
    useSessionStore.setState({
      sessions: [tab('a'), tab('b', { connected: false, connectionStatus: 'disconnected' }), tab('c', { connected: false, connectionStatus: 'disconnected' })],
    });
    render(<ActivityBar />);
    expect(screen.getByRole('button', { name: 'Sessions' })).toHaveTextContent('2');
  });

  it('shows intent violations from the last evaluation', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { id: '1', lastResult: { status: 'violation' } },
      { id: '2', lastResult: { status: 'ok' } },
    ]);
    render(<ActivityBar />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Network Intent' })).toHaveTextContent('1'));
  });

  it('shows the label and OS shortcut in a tooltip on keyboard focus', () => {
    render(<ActivityBar />);
    act(() => screen.getByRole('button', { name: 'AI Assistant' }).focus());
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('AI Assistant');
    expect(tip.textContent).toMatch(/Shift\+I|⌘⇧I/);
  });

  it('brings the sidebar back from a maximized side panel', () => {
    useSidePanelStore.setState({ maximized: true });
    render(<ActivityBar />);
    expect(screen.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(useSidePanelStore.getState().maximized).toBe(false);
    expect(useSessionStore.getState().sidebarVisible).toBe(true);
  });

  it('keeps SFTP disabled until a session is active', () => {
    render(<ActivityBar />);
    expect(screen.getByRole('button', { name: 'SFTP' })).toBeDisabled();
  });
});
