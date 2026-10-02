import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import StatusBar from './StatusBar';
import * as sessionStore from '../store/sessionStore';
import { askConfirm } from '../store/dialogStore';

// Mock the Zustand store hooks
vi.mock('../store/sessionStore', () => ({
  useSessionStore: vi.fn(),
}));

// Selector-aware settings mock; tests flip fields on `settings`.
const settings = vi.hoisted(() => ({
  pasteGuardEnabled: true,
  pasteGuardLineThreshold: 2,
  autoLogSessions: false,
  sessionLogDir: '',
  sessionLogTimestamps: false,
}));
vi.mock('../store/settingsStore', () => ({
  useSettingsStore: vi.fn((selector?: (s: typeof settings) => unknown) =>
    selector ? selector(settings) : settings
  ),
}));

vi.mock('../store/dialogStore', () => ({
  askConfirm: vi.fn().mockResolvedValue(true),
}));

vi.mock('../store/terminalToolsStore', () => ({
  useTerminalToolsStore: vi.fn(() => ({
    pasteHistory: [],
    clearPasteHistory: vi.fn(),
    removePaste: vi.fn(),
  })),
  countPasteLines: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(false),
}));

function mockSessions(sessions: unknown[], activeSessionId: string | null) {
  vi.mocked(sessionStore.useSessionStore).mockReturnValue({
    sessions,
    activeSessionId,
  } as any);
}

describe('StatusBar Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(false);
    settings.autoLogSessions = false;
    settings.sessionLogDir = '';
    settings.sessionLogTimestamps = false;
  });

  it('renders "No active connection" when there is no active session', () => {
    mockSessions([], null);

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

    mockSessions([mockSession], 'session-123');

    render(<StatusBar />);
    expect(screen.getByText('ssh')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('shows config mode and the prompt hostname read from the device', () => {
    const session = {
      sessionId: 's1',
      connected: true,
      connectionStatus: 'connected',
      promptHost: 'core-sw-01',
      configMode: true,
      config: { name: '10.0.0.1', protocol: 'ssh', host: '10.0.0.1', deviceType: 'aruba-cx' },
    };
    mockSessions([session], 's1');
    const { rerender } = render(<StatusBar />);
    expect(screen.getByText('Config mode')).toBeInTheDocument();
    expect(screen.getByText(/10\.0\.0\.1 \(core-sw-01\)/)).toBeInTheDocument();

    mockSessions([{ ...session, configMode: false }], 's1');
    rerender(<StatusBar />);
    expect(screen.queryByText('Config mode')).not.toBeInTheDocument();
  });

  it('calls onDisconnect when clicking the connected status', () => {
    const mockSession = {
      sessionId: 'session-123',
      connected: true,
      config: { protocol: 'ssh', host: 'localhost' },
    };

    mockSessions([mockSession], 'session-123');

    const onDisconnect = vi.fn();
    render(<StatusBar onDisconnect={onDisconnect} />);

    const statusBtn = screen.getByTitle('Click to disconnect');
    fireEvent.click(statusBtn);
    expect(onDisconnect).toHaveBeenCalledWith('session-123');
  });

  it('shows Send BREAK only for a connected serial session and sends it after confirming', async () => {
    const serial = {
      sessionId: 'ser-1',
      connected: true,
      connectionStatus: 'connected',
      config: { name: 'console', protocol: 'serial', serialPort: '/dev/ttyUSB0' },
    };
    mockSessions([serial], 'ser-1');
    const { unmount } = render(<StatusBar />);

    fireEvent.click(screen.getByText('Send BREAK'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('serial_send_break', { sessionId: 'ser-1' })
    );
    expect(askConfirm).toHaveBeenCalled();
    unmount();

    mockSessions([{ ...serial, connected: false, connectionStatus: 'disconnected' }], 'ser-1');
    const { unmount: unmount2 } = render(<StatusBar />);
    expect(screen.queryByText('Send BREAK')).not.toBeInTheDocument();
    unmount2();

    mockSessions([{ ...serial, config: { protocol: 'ssh', host: 'sw1' } }], 'ser-1');
    render(<StatusBar />);
    expect(screen.queryByText('Send BREAK')).not.toBeInTheDocument();
  });

  it('auto-starts a log for connected sessions when enabled', async () => {
    settings.autoLogSessions = true;
    settings.sessionLogDir = '/logs';
    settings.sessionLogTimestamps = true;
    mockSessions(
      [
        { sessionId: 'a', connected: true, connectionStatus: 'connected', config: { name: 'core-sw1', protocol: 'ssh', host: '10.0.0.1' } },
        { sessionId: 'b', connected: false, connectionStatus: 'connecting', config: { protocol: 'ssh', host: '10.0.0.2' } },
      ],
      'a'
    );

    render(<StatusBar />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'start_session_log',
        expect.objectContaining({ sessionId: 'a', name: 'core-sw1', dir: '/logs', timestamps: true })
      )
    );
    // Not yet connected → not logged.
    expect(invoke).not.toHaveBeenCalledWith('start_session_log', expect.objectContaining({ sessionId: 'b' }));
  });

  it('does not auto-log when the setting is off', async () => {
    mockSessions(
      [{ sessionId: 'a', connected: true, connectionStatus: 'connected', config: { protocol: 'ssh', host: 'x' } }],
      'a'
    );
    render(<StatusBar />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('session_log_path', { sessionId: 'a' }));
    expect(invoke).not.toHaveBeenCalledWith('start_session_log', expect.anything());
  });

  it('shows REC with the log file name and a reveal-folder button while logging', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === 'session_log_path' ? '/home/me/logs/core-sw1_2026-09-27_101500.log' : undefined
    );
    mockSessions(
      [{ sessionId: 'a', connected: true, connectionStatus: 'connected', config: { protocol: 'ssh', host: 'x' } }],
      'a'
    );
    render(<StatusBar />);

    expect(await screen.findByText('REC')).toBeInTheDocument();
    expect(
      screen.getByTitle('Logging to core-sw1_2026-09-27_101500.log — click to stop')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Reveal log folder'));
    expect(invoke).toHaveBeenCalledWith('reveal_log_folder', { dir: '/home/me/logs' });
  });
});
