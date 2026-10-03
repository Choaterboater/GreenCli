import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import ConfigArchive from './ConfigArchive';
import { notify } from '../store/toastStore';
import { refreshStaleHiddenCopies, resetHiddenRefreshForTests } from '../utils/configArchive';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@monaco-editor/react', () => ({ DiffEditor: () => null }));
vi.mock('../editor/setup', () => ({ setupMonaco: vi.fn() }));
vi.mock('../editor/networkLanguages', () => ({ detectConfigLanguage: () => null }));
vi.mock('../store/toastStore', () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../utils/secrets/forCopy', () => ({
  hideSecretsInText: vi.fn(async (text: string) =>
    text === 'too big' ? { ok: false, reason: 'too-big' } : { ok: true, text: `hidden ${text}`, hidden: 0, words: [] }
  ),
}));

let todo = [
  { device: 'sw1', ts: 1 },
  { device: 'sw1', ts: 2 },
];

beforeEach(() => {
  resetHiddenRefreshForTests();
  vi.mocked(notify.success).mockClear();
  vi.mocked(notify.warning).mockClear();
  todo = [
    { device: 'sw1', ts: 1 },
    { device: 'sw1', ts: 2 },
  ];
  vi.mocked(invoke).mockImplementation(async (cmd: string, raw?: unknown) => {
    const args = raw as { device: string; ts: number } | undefined;
    if (cmd === 'config_archive_devices') return ['sw1'];
    if (cmd === 'config_archive_list') return [];
    if (cmd === 'config_archive_missing_hidden') return { missing: todo.length, stale: 0, current: 0, todo };
    if (cmd === 'config_archive_get') return args?.ts === 2 ? 'too big' : 'raw';
    if (cmd === 'config_archive_set_hidden') {
      todo = todo.filter((t) => t.ts !== args?.ts);
      return null;
    }
    return undefined;
  });
});

describe('ConfigArchive hidden copies', () => {
  it('shows how many snapshots need a hidden copy and makes them', async () => {
    render(<ConfigArchive onOpenSnapshot={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('2 snapshots need a new hidden copy.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Make hidden copies/ }));
    await waitFor(() => expect(notify.warning).toHaveBeenCalled());
    expect(vi.mocked(notify.warning).mock.calls[0][1]).toContain("Made 1. 1 couldn't be made");
    expect(await screen.findByText('1 snapshot needs a new hidden copy.')).toBeTruthy();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('config_archive_set_hidden', {
      device: 'sw1',
      ts: 1,
      hidden: 'hidden raw',
      filter: 1,
    });
  });

  it('counts again after the background refresh makes stale copies', async () => {
    todo = [{ device: 'sw1', ts: 5 }];
    vi.mocked(invoke).mockImplementation(async (cmd: string, raw?: unknown) => {
      const args = raw as { device: string; ts: number } | undefined;
      if (cmd === 'config_archive_devices') return ['sw1'];
      if (cmd === 'config_archive_list') return [];
      if (cmd === 'config_archive_missing_hidden') return { missing: 0, stale: todo.length, current: 0, todo };
      if (cmd === 'config_archive_get') return 'raw';
      if (cmd === 'config_archive_set_hidden') {
        todo = todo.filter((t) => t.ts !== args?.ts);
        return null;
      }
      return undefined;
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    render(<ConfigArchive onOpenSnapshot={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(info).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/need(s)? a new hidden copy/)).toBeNull());
    expect(screen.queryByRole('button', { name: /Make hidden copies/ })).toBeNull();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('config_archive_set_hidden', {
      device: 'sw1',
      ts: 5,
      hidden: 'hidden raw',
      filter: 1,
    });
    info.mockRestore();
  });

  it('counts the hidden copies once when the background refresh already ended', async () => {
    // App start ran the refresh; this is a later open of the panel. The
    // count reads every hidden copy, so it runs once.
    await refreshStaleHiddenCopies();
    vi.mocked(invoke).mockClear();
    render(<ConfigArchive onOpenSnapshot={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('2 snapshots need a new hidden copy.')).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    const counts = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'config_archive_missing_hidden');
    expect(counts).toHaveLength(1);
  });

  it('shows nothing when every snapshot has a current copy', async () => {
    todo = [];
    render(<ConfigArchive onOpenSnapshot={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith('config_archive_missing_hidden'));
    expect(screen.queryByRole('button', { name: /Make hidden copies/ })).toBeNull();
  });
});
