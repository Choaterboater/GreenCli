import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import StatusBar from './StatusBar';
import * as sessionStore from '../store/sessionStore';

// Mock the Zustand store hooks
vi.mock('../store/sessionStore', () => ({
  useSessionStore: vi.fn(),
}));

vi.mock('../store/settingsStore', () => ({
  useSettingsStore: vi.fn(() => ({})),
}));

vi.mock('../store/terminalToolsStore', () => ({
  useTerminalToolsStore: vi.fn(() => ({
    pasteHistory: [],
    clearPasteHistory: vi.fn(),
    removePaste: vi.fn(),
  })),
  countPasteLines: vi.fn(),
}));

vi.mock('@tauri-apps/api/tauri', () => ({
  invoke: vi.fn().mockResolvedValue(false),
}));

describe('StatusBar Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "No active connection" when there is no active session', () => {
    vi.mocked(sessionStore.useSessionStore).mockReturnValue({
      sessions: [],
      activeSessionId: null,
    } as any);

    render(<StatusBar />);
    expect(screen.getByText('No active connection')).toBeInTheDocument();
  });

  it('renders active session information', () => {
    const mockSession = {
      sessionId: 'session-123',
      connected: true,
      connectionStatus: 'connected',
      config: {
        name: 'Test Server',
        protocol: 'ssh',
        host: '10.0.0.1',
        deviceType: 'linux',
      },
    };

    vi.mocked(sessionStore.useSessionStore).mockReturnValue({
      sessions: [mockSession],
      activeSessionId: 'session-123',
    } as any);

    render(<StatusBar />);
    expect(screen.getByText('ssh')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('calls onDisconnect when clicking the connected status', () => {
    const mockSession = {
      sessionId: 'session-123',
      connected: true,
      config: { protocol: 'ssh', host: 'localhost' },
    };

    vi.mocked(sessionStore.useSessionStore).mockReturnValue({
      sessions: [mockSession],
      activeSessionId: 'session-123',
    } as any);

    const onDisconnect = vi.fn();
    render(<StatusBar onDisconnect={onDisconnect} />);
    
    const statusBtn = screen.getByTitle('Click to disconnect');
    fireEvent.click(statusBtn);
    expect(onDisconnect).toHaveBeenCalledWith('session-123');
  });
});
