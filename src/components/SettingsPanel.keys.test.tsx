import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import SettingsPanel from './SettingsPanel';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { leftoverLine, MOVE_PENDING_LINE, UNAVAILABLE_LINE } from '../utils/secretStore';

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

  it('shows a key saved on close once the save finishes, while the panel is open again', async () => {
    let saved = false;
    let finishSave: () => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'ai_has_key') return saved;
      if (cmd === 'ai_set_key') {
        return new Promise<null>((resolve) => {
          finishSave = () => {
            saved = true;
            resolve(null);
          };
        });
      }
      if (cmd === 'secret_store_status') return { kind: 'keychain', leftoverFiles: [], movePending: false };
      if (cmd.startsWith('mcp_')) return [];
      return null;
    });
    render(<SettingsPanel />);
    setOpen(true);
    fireEvent.click(await screen.findByRole('button', { name: /AI & MCP/ }));
    fireEvent.change(await screen.findByPlaceholderText('Enter API key'), { target: { value: 'sk-ant-typed' } });
    // Closing saves the typed key; the save is still going when it opens again.
    setOpen(false);
    setOpen(true);
    await waitFor(() => expect(keyChecks()).toBe(2));
    expect(await screen.findByPlaceholderText('Enter API key')).toBeTruthy();

    await act(async () => finishSave());
    expect(await screen.findByPlaceholderText(SAVED)).toBeTruthy();
    expect(screen.getByText('saved')).toBeTruthy();
  });
});

describe('SettingsPanel key warnings', () => {
  it('shows a left-over 1.9 file and a pending move whatever the provider', async () => {
    const path = '/x/ai_keys.json';
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'secret_store_status') return { kind: 'keychain', leftoverFiles: [path], movePending: true };
      if (cmd.startsWith('mcp_')) return [];
      return null;
    });
    useSettingsStore.setState({ aiProvider: 'casper' });
    render(<SettingsPanel />);
    setOpen(true);
    fireEvent.click(await screen.findByRole('button', { name: /AI & MCP/ }));
    expect(await screen.findByText(leftoverLine(path))).toBeTruthy();
    expect(screen.getAllByText(MOVE_PENDING_LINE)).toHaveLength(1);
    // Only the warnings: no key is kept for this provider.
    expect(screen.queryByTestId('secret-store-line')).toBeNull();
    expect(keyChecks()).toBe(0);
  });
});
