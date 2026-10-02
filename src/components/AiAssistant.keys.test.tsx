import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import AiAssistant from './AiAssistant';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { UNAVAILABLE_LINE } from '../utils/secretStore';

const ADD_KEY = /Add an API key for/;

function backend(hasKey: () => Promise<boolean>) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'ai_has_key') return hasKey();
    if (cmd === 'mcp_status' || cmd === 'mcp_all_tools') return [];
    return null;
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useSettingsStore.setState({ aiProvider: 'anthropic' });
  useSessionStore.setState({ showAiAssistant: true });
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
});
