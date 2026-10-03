import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import AiAssistant from './AiAssistant';
import SettingsPanel from './SettingsPanel';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { saveAiKey, UNAVAILABLE_LINE } from '../utils/secretStore';

const ADD_KEY = /Add an API key for/;

function backend(hasKey: () => Promise<boolean>) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'ai_has_key') return hasKey();
    if (cmd === 'mcp_status' || cmd === 'mcp_all_tools') return [];
    return null;
  });
}

const keyChecks = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ai_has_key').length;

// jsdom has no scrolling; Settings scrolls each group to the top.
Element.prototype.scrollTo ??= () => {};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useSettingsStore.setState({ aiProvider: 'anthropic' });
  useSessionStore.setState({ showAiAssistant: true, showSettings: false, settingsFocus: null });
});

describe('AiAssistant key check', () => {
  it('asks for a key when none is saved', async () => {
    backend(async () => false);
    render(<AiAssistant />);
    expect(await screen.findByText(ADD_KEY)).toBeTruthy();
  });

  it('says the password store can not be reached instead of asking for a key', async () => {
    backend(async () => {
      throw UNAVAILABLE_LINE;
    });
    render(<AiAssistant />);
    expect(await screen.findByText(UNAVAILABLE_LINE)).toBeTruthy();
    expect(screen.queryByText(ADD_KEY)).toBeNull();
  });

  it('shows nothing when a key is saved', async () => {
    backend(async () => true);
    render(<AiAssistant />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai_has_key', { provider: 'anthropic' }));
    await waitFor(() => expect(screen.queryByText(ADD_KEY)).toBeNull());
    expect(screen.queryByText(UNAVAILABLE_LINE)).toBeNull();
  });

  it('is ready once a key typed in Settings is saved by closing Settings', async () => {
    let saved = false;
    let finishSave: () => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'ai_has_key') return saved;
      if (cmd === 'ai_set_key') {
        // The password store takes a while: a check meanwhile sees no key.
        await new Promise<void>((resolve) => (finishSave = resolve));
        saved = true;
        return null;
      }
      if (cmd === 'secret_store_status') return { kind: 'keychain', leftoverFiles: [], movePending: false };
      if (cmd.startsWith('mcp_')) return [];
      return null;
    });
    // App's order: the side panel, which holds this one, comes before Settings.
    render(
      <>
        <AiAssistant />
        <SettingsPanel />
      </>
    );
    expect(await screen.findByText(ADD_KEY)).toBeTruthy();
    act(() => useSessionStore.setState({ showSettings: true }));
    fireEvent.click(await screen.findByRole('button', { name: /AI & MCP/ }));
    fireEvent.change(await screen.findByPlaceholderText('Enter API key'), { target: { value: 'sk-ant-new' } });

    // Escape: the field never blurs, so the close saves the key, while this
    // panel's close check has already asked.
    act(() => useSessionStore.setState({ showSettings: false }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai_set_key', { provider: 'anthropic', key: 'sk-ant-new' })
    );
    expect(screen.getByText(ADD_KEY)).toBeTruthy();
    await act(async () => finishSave());
    await waitFor(() => expect(screen.queryByText(ADD_KEY)).toBeNull());
  });

  it('asks again only for its own provider, and keeps the newest answer', async () => {
    const answers: ((has: boolean) => void)[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'ai_has_key') return new Promise<boolean>((resolve) => answers.push(resolve));
      if (cmd.startsWith('mcp_')) return [];
      return null;
    });
    render(<AiAssistant />);
    await waitFor(() => expect(keyChecks()).toBe(1));
    await act(async () => void (await saveAiKey('openai', 'sk-other')));
    expect(keyChecks()).toBe(1);

    // The key is removed while the first check is still out, and that
    // check answers last.
    await act(async () => void (await saveAiKey('anthropic', '')));
    expect(keyChecks()).toBe(2);
    await act(async () => answers[1](false));
    await act(async () => answers[0](true));
    expect(screen.getByText(ADD_KEY)).toBeTruthy();
  });
});
