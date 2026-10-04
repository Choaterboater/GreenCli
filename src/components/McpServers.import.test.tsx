import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import McpServers from './McpServers';
import { askChoice } from '../store/dialogStore';
import { notify } from '../store/toastStore';
import { useSettingsStore } from '../store/settingsStore';
import type { McpImportPreview } from '../utils/mcpTypes';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../utils/fileSystem', () => ({ isTauri: true, tauriSave: vi.fn() }));
vi.mock('../store/toastStore', () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../store/dialogStore', () => ({ askChoice: vi.fn(), askConfirm: vi.fn() }));

const item = (name: string, over: Partial<McpImportPreview['items'][number]> = {}) => ({
  id: name,
  name,
  source: 'Casper',
  transport: 'stdio' as const,
  preset: null,
  pins: { kind: 'none' as const },
  needs: [],
  notes: [],
  runs: `uvx ${name}`,
  ...over,
});

const PREVIEW: McpImportPreview = {
  token: 'tok-1',
  items: [item('central'), item('github', { source: 'VS Code', needs: ['GITHUB_TOKEN'] }), item('lab', { notes: ['it was turned off there'] })],
  skipped: [],
  problems: [],
};

function backend(preview: McpImportPreview | null) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, raw?: unknown) => {
    const args = raw as { ids?: string[] } | undefined;
    if (cmd === 'mcp_list_servers') return [];
    if (cmd === 'mcp_status') return [];
    if (cmd === 'mcp_import_scan') return preview;
    if (cmd === 'mcp_import_apply') return { added: args?.ids ?? [], skipped: [] };
    return undefined;
  });
}

const scans = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'mcp_import_scan').length;
const applies = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([cmd]) => cmd === 'mcp_import_apply')
    .map(([, args]) => args as { token: string; ids: string[] });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('McpServers import', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(askChoice).mockReset();
    vi.mocked(notify.success).mockReset();
    vi.mocked(notify.info).mockReset();
    vi.mocked(notify.warning).mockReset();
    useSettingsStore.setState({ mcpImportOffered: false });
  });

  it('offers once, with Not now first, and Not now imports nothing', async () => {
    backend(PREVIEW);
    vi.mocked(askChoice).mockResolvedValue('no');
    const first = render(<McpServers />);
    await waitFor(() => expect(askChoice).toHaveBeenCalledTimes(1));
    const dialog = vi.mocked(askChoice).mock.calls[0][0];
    expect(dialog.title).toBe('Use MCP servers you already set up?');
    expect(dialog.choices[0].label).toBe('Not now');
    expect(dialog.notes).toContain('lab (Casper): it was turned off there');
    expect(useSettingsStore.getState().mcpImportOffered).toBe(true);
    await flush();
    expect(applies()).toHaveLength(0);
    // Not shown again.
    first.unmount();
    render(<McpServers />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_list_servers'));
    await flush();
    expect(askChoice).toHaveBeenCalledTimes(1);
  });

  it('shows one dialog under StrictMode', async () => {
    backend(PREVIEW);
    vi.mocked(askChoice).mockResolvedValue(null);
    render(
      <StrictMode>
        <McpServers />
      </StrictMode>,
    );
    await waitFor(() => expect(askChoice).toHaveBeenCalled());
    await flush();
    await flush();
    expect(askChoice).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().mcpImportOffered).toBe(true);
    // Escape counts as Not now.
    expect(applies()).toHaveLength(0);
  });

  it('is not offered when nothing is found, and asks again next time', async () => {
    backend({ ...PREVIEW, items: [] });
    render(<McpServers />);
    await waitFor(() => expect(scans()).toBe(1));
    await flush();
    expect(askChoice).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().mcpImportOffered).toBe(false);
  });

  it('Import all imports every server and says what needs a value', async () => {
    backend(PREVIEW);
    vi.mocked(askChoice).mockResolvedValue('all');
    render(<McpServers />);
    await waitFor(() => expect(applies()).toHaveLength(1));
    expect(applies()[0]).toEqual({ token: 'tok-1', ids: ['central', 'github', 'lab'] });
    await waitFor(() => expect(notify.success).toHaveBeenCalled());
    expect(vi.mocked(notify.success).mock.calls[0][0]).toBe('3 MCP servers imported');
    expect(notify.info).toHaveBeenCalledWith('github needs GITHUB_TOKEN. Click Edit to add it.');
  });

  it('Pick which asks per server, Skip first', async () => {
    backend(PREVIEW);
    vi.mocked(askChoice)
      .mockResolvedValueOnce('pick')
      .mockResolvedValueOnce('import')
      .mockResolvedValueOnce('skip')
      .mockResolvedValueOnce('import');
    render(<McpServers />);
    await waitFor(() => expect(applies()).toHaveLength(1));
    expect(applies()[0].ids).toEqual(['central', 'lab']);
    expect(vi.mocked(askChoice).mock.calls[1][0].choices.map((c) => c.value)).toEqual(['skip', 'import']);
  });

  it('Escape during Pick which imports nothing', async () => {
    backend(PREVIEW);
    vi.mocked(askChoice).mockResolvedValueOnce('pick').mockResolvedValueOnce('import').mockResolvedValueOnce(null);
    render(<McpServers />);
    await waitFor(() => expect(askChoice).toHaveBeenCalledTimes(3));
    await flush();
    expect(applies()).toHaveLength(0);
  });

  it('the button works after Not now, and says when nothing is new', async () => {
    useSettingsStore.setState({ mcpImportOffered: true });
    backend(PREVIEW);
    vi.mocked(askChoice).mockResolvedValue('all');
    render(<McpServers />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_list_servers'));
    await flush();
    expect(askChoice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Import from Casper \/ Claude/ }));
    await waitFor(() => expect(applies()).toHaveLength(1));

    backend({ ...PREVIEW, items: [] });
    fireEvent.click(screen.getByRole('button', { name: /Import from Casper \/ Claude/ }));
    await waitFor(() => expect(notify.info).toHaveBeenCalledWith('Nothing new to import', expect.any(String)));
  });
});
