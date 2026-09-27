import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SearchOverlay from './SearchOverlay';
import { useSessionStore } from '../store/sessionStore';
import {
  registerSearchAdapter,
  unregisterSearchAdapter,
  openTerminalSearch,
  sendSearchCommand,
  type ISearchAdapter,
} from '../utils/terminalSearch';
import type { DeviceType } from '../types';

function fakeAdapter(): ISearchAdapter & { findNext: ReturnType<typeof vi.fn>; findPrevious: ReturnType<typeof vi.fn> } {
  return {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    clearActiveDecoration: vi.fn(),
    onResultsChange: vi.fn(() => () => {}),
  };
}

function openSession(deviceType: DeviceType) {
  useSessionStore.setState({
    sessions: [
      {
        sessionId: 's1',
        connected: true,
        config: { id: 's1', name: 'sw1', protocol: 'ssh', host: 'sw1', deviceType },
      },
    ],
    activeSessionId: 's1',
    showSearch: true,
  });
}

let adapter: ReturnType<typeof fakeAdapter>;

beforeEach(() => {
  adapter = fakeAdapter();
  registerSearchAdapter('s1', adapter);
});

afterEach(() => {
  unregisterSearchAdapter('s1');
  useSessionStore.setState({ showSearch: false, sessions: [], activeSessionId: null });
});

describe('SearchOverlay chips', () => {
  it('offers Junos chips for a Junos session and Aruba chips for Aruba', () => {
    openSession('juniper-junos');
    const { unmount } = render(<SearchOverlay />);
    expect(screen.getByText('set interfaces')).toBeInTheDocument();
    expect(screen.getByText('link down')).toBeInTheDocument();
    expect(screen.queryByText('router bgp')).toBeNull();
    expect(screen.getByText('error')).toBeInTheDocument();
    unmount();

    openSession('aruba-cx');
    render(<SearchOverlay />);
    expect(screen.getByText('router bgp')).toBeInTheDocument();
    expect(screen.queryByText('set interfaces')).toBeNull();
  });

  it('searches chips case-insensitively even with the case toggle on', () => {
    openSession('juniper-junos');
    render(<SearchOverlay />);
    fireEvent.click(screen.getByTitle('Case sensitive'));
    adapter.findNext.mockClear();
    fireEvent.click(screen.getByText('link down'));
    const calls = adapter.findNext.mock.calls;
    const [term, opts] = calls[calls.length - 1];
    expect(term).toBe('Physical link is Down');
    expect(opts).toMatchObject({ regex: true, caseSensitive: false });
  });
});

describe('SearchOverlay commands', () => {
  it('prefills and searches the selection as literal text', () => {
    openSession('aruba-cx');
    useSessionStore.setState({ showSearch: false });
    render(<SearchOverlay />);
    act(() => openTerminalSearch('10.1.1.1'));
    expect(screen.getByPlaceholderText('Find in terminal…')).toHaveValue('10.1.1.1');
    expect(adapter.findNext).toHaveBeenCalledWith(
      '10.1.1.1',
      expect.objectContaining({ regex: false }),
    );
  });

  it('steps to the next / previous match on command', () => {
    openSession('aruba-cx');
    render(<SearchOverlay />);
    fireEvent.change(screen.getByPlaceholderText('Find in terminal…'), { target: { value: 'vlan' } });
    adapter.findNext.mockClear();
    act(() => sendSearchCommand({ type: 'next' }));
    expect(adapter.findNext).toHaveBeenCalledWith('vlan', expect.anything());
    act(() => sendSearchCommand({ type: 'prev' }));
    expect(adapter.findPrevious).toHaveBeenCalledWith('vlan', expect.anything());
  });
});
