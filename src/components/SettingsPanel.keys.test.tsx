import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import SettingsPanel from './SettingsPanel';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { UNAVAILABLE_LINE } from '../utils/secretStore';

const CANT_CHECK = "Can't check for a saved key";
const SAVED = '•••••••• (saved — type to replace)';

function backend(hasKey: () => Promise<boolean>) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'ai_has_key') return hasKey();
    if (cmd === 'secret_store_status') return { kind: 'keychain', leftoverFiles: [], movePending: false };
    if (cmd.startsWith('mcp_')) return [];
    return null;
  });
}

const keyChecks = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ai_has_key').length;

function setOpen(open: boolean) {
  act(() => useSessionStore.setState({ showSettings: open }));
}

// jsdom has no scrolling; the panel scrolls each group to the top.
Element.prototype.scrollTo ??= () => {};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useSettingsStore.setState({ aiProvider: 'anthropic' });
  useSessionStore.setState({ showSettings: false, settingsFocus: null });
});

describe('SettingsPanel saved-key check', () => {
  it('asks again on each open, so a check that failed recovers', async () => {
    let calls = 0;
    backend(async () => {
      calls += 1;
      if (calls === 1) throw UNAVAILABLE_LINE;
      return true;
    });
    render(<SettingsPanel />);
    // Closed at app start: the password store isn't asked.
    expect(keyChecks()).toBe(0);

    setOpen(true);
    fireEvent.click(await screen.findByRole('button', { name: /AI & MCP/ }));
    expect(await screen.findByPlaceholderText(CANT_CHECK)).toBeTruthy();
    expect(screen.queryByText('remove')).toBeNull();

    setOpen(false);
    setOpen(true);
    expect(await screen.findByPlaceholderText(SAVED)).toBeTruthy();
    expect(screen.getByText('saved')).toBeTruthy();
    // The label wraps it, so the button's name is the whole label.
    expect(screen.getByText('remove').tagName).toBe('BUTTON');
    expect(keyChecks()).toBe(2);
  });

  it('drops a reply that arrives after the panel closed', async () => {
    let answer: (has: boolean) => void = () => {};
    backend(() => new Promise<boolean>((resolve) => (answer = resolve)));
    render(<SettingsPanel />);
    setOpen(true);
    fireEvent.click(await screen.findByRole('button', { name: /AI & MCP/ }));
    await waitFor(() => expect(keyChecks()).toBe(1));
    const first = answer;
    setOpen(false);
    setOpen(true);
    await waitFor(() => expect(keyChecks()).toBe(2));
    answer(false);
    await act(async () => first(true));
    expect(await screen.findByPlaceholderText('Enter API key')).toBeTruthy();
    expect(screen.queryByText('saved')).toBeNull();
  });
});
