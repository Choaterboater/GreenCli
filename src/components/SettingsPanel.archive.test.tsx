import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import SettingsPanel from './SettingsPanel';
import { useSessionStore } from '../store/sessionStore';

// jsdom has no scrolling; the panel scrolls each group to the top.
Element.prototype.scrollTo ??= () => {};

beforeEach(() => {
  useSessionStore.setState({ showSettings: false, settingsFocus: null, showConfigEditor: false, showArchive: false });
});

describe('SettingsPanel config archive', () => {
  it('sends a search for Make hidden copies to the panel that has the button', async () => {
    render(<SettingsPanel />);
    act(() => useSessionStore.setState({ showSettings: true }));
    fireEvent.change(await screen.findByPlaceholderText('Search settings…'), {
      target: { value: 'make hidden copies' },
    });
    expect(await screen.findByText(/greencli-mcp reads configs only from hidden copies/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Config Archive' }));
    expect(useSessionStore.getState()).toMatchObject({ showSettings: false, showConfigEditor: true, showArchive: true });
  });
});
