import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/tauri';
import { open as openDialog } from '@tauri-apps/api/dialog';

// The Choose… button only shows inside the app.
vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI__ = {};
});

vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/dialog', () => ({ open: vi.fn() }));

const notify = vi.hoisted(() => ({ warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../store/toastStore', () => ({ notify }));

import CasperSettings from './CasperSettings';
import { useSettingsStore } from '../store/settingsStore';
import type { CasperCheck } from '../types';

const OK: CasperCheck = {
  ok: true,
  version: '0.2.21',
  workFolder: '/cache/casper-work',
  message: 'Found Casper 0.2.21. It works in a fresh, empty folder for each question.',
  folderOk: true,
  folderMessage: null,
  warnings: [],
};

describe('CasperSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.getState().updateSettings({ casperCommand: 'casper', casperWorkFolder: '', sessionLogDir: '' });
  });

  it('shows the default folder and saves the command as typed', () => {
    render(<CasperSettings />);
    expect(screen.getByText('A fresh folder for each question (default)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Casper command'), { target: { value: 'casper --model a/b' } });
    expect(useSettingsStore.getState().casperCommand).toBe('casper --model a/b');
  });

  it('says plainly that Casper can read GreenCLI’s own keys and logs', () => {
    render(<CasperSettings />);
    expect(screen.getByText(/GreenCLI's own files are not on that list/)).toBeTruthy();
    expect(screen.getByText(/your AI keys, MCP logins and session logs/)).toBeTruthy();
    expect(screen.queryByText(/not private ones like ~\/\.ssh/)).toBeNull();
  });

  it('checks Casper and shows the result and warnings', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...OK, warnings: ['Casper will follow the instruction files it finds here: /x/AGENTS.md.'] });
    render(<CasperSettings />);
    fireEvent.click(screen.getByText('Check Casper'));
    expect(invoke).toHaveBeenCalledWith('ai_casper_check', { command: 'casper', workFolder: null, logFolder: null });
    await waitFor(() => expect(screen.getByText(OK.message)).toBeTruthy());
    expect(screen.getByText(/instruction files it finds here/)).toBeTruthy();
  });

  it('shows a failed check in plain words, and clears it when the command changes', async () => {
    vi.mocked(invoke).mockRejectedValue('API Error: something broke');
    render(<CasperSettings />);
    fireEvent.click(screen.getByText('Check Casper'));
    await waitFor(() => expect(screen.getByText('something broke')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Casper command'), { target: { value: 'casper --verbose' } });
    expect(screen.queryByText('something broke')).toBeNull();
  });

  it('refuses a picked folder the check turns down, and keeps the old one', async () => {
    vi.mocked(openDialog).mockResolvedValue('/Users/me');
    vi.mocked(invoke).mockResolvedValue({
      ...OK,
      ok: false,
      folderOk: false,
      folderMessage: "Casper can't work in your home folder, or in a folder that holds it.",
    });
    render(<CasperSettings />);
    fireEvent.click(screen.getByText('Choose…'));
    await waitFor(() => expect(notify.warning).toHaveBeenCalled());
    expect(notify.warning).toHaveBeenCalledWith(
      "Can't use that folder",
      "Casper can't work in your home folder, or in a folder that holds it."
    );
    expect(invoke).toHaveBeenCalledWith('ai_casper_check', { command: 'casper', workFolder: '/Users/me', logFolder: null });
    expect(useSettingsStore.getState().casperWorkFolder).toBe('');
  });

  it('saves a picked folder that passes, and can go back to GreenCLI’s folder', async () => {
    vi.mocked(openDialog).mockResolvedValue('/Users/me/code/lab');
    vi.mocked(invoke).mockResolvedValue({ ...OK, workFolder: '/Users/me/code/lab', message: 'Found Casper 0.2.21. It works in /Users/me/code/lab.' });
    render(<CasperSettings />);
    fireEvent.click(screen.getByText('Choose…'));
    await waitFor(() => expect(useSettingsStore.getState().casperWorkFolder).toBe('/Users/me/code/lab'));
    expect(await screen.findByText('Found Casper 0.2.21. It works in /Users/me/code/lab.')).toBeTruthy();
    fireEvent.click(screen.getByText("Use GreenCLI's folder"));
    expect(useSettingsStore.getState().casperWorkFolder).toBe('');
  });
});
