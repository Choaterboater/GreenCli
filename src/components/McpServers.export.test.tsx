import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import McpServers from './McpServers';
import { tauriSave } from '../utils/fileSystem';
import { notify } from '../store/toastStore';
import type { McpServerDef } from '../utils/mcpTypes';
import { resetHiddenRefreshForTests } from '../utils/configArchive';
import { copyText } from '../utils/clipboard';
import { useSessionStore } from '../store/sessionStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../utils/fileSystem', () => ({ isTauri: true, tauriSave: vi.fn() }));
vi.mock('../store/toastStore', () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../utils/clipboard', () => ({ copyText: vi.fn(async () => true) }));
vi.mock('../utils/secrets/forCopy', () => ({
  hideSecretsInText: vi.fn(async (text: string) => ({ ok: true, text: `hidden ${text}`, hidden: 0, words: [] })),
}));

const SERVERS: McpServerDef[] = [
  {
    name: 'central',
    transport: 'stdio',
    command: 'uvx',
    args: ['aruba-tool-router'],
    env: { MIST_API_TOKEN: 'tok-SECRET-1234' },
    cwd: null,
    url: null,
    credentialsEnvVar: null,
    headers: {},
    enabled: true,
  },
  {
    name: 'remote',
    transport: 'http',
    command: '',
    args: [],
    env: {},
    cwd: null,
    url: 'https://mcp.example.com/mcp',
    credentialsEnvVar: null,
    headers: { Authorization: 'Bearer hdr-SECRET-5678' },
    enabled: false,
  },
];

/** GreenCLI's data folder, as greencli_mcp_info gives it. */
const DATA_DIR = '/Users/me/Library/Application Support/com.choatelabs.greencli';

function backend(
  servers: McpServerDef[],
  writeError?: string,
  greencli?: { path: string; exists: boolean; place: string; dataDir: string },
  hidden?: { missing: number; stale: number },
) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, raw?: unknown) => {
    const args = raw as Record<string, unknown> | undefined;
    if (cmd === 'mcp_list_servers') return servers;
    if (cmd === 'greencli_mcp_info') return greencli;
    if (cmd === 'config_archive_missing_hidden') return hidden ? { ...hidden, current: 0, todo: [] } : undefined;
    if (cmd === 'mcp_status') return [];
    if (cmd === 'mcp_has_credentials') return args?.name === 'central';
    if (cmd === 'mcp_export_write' && writeError) throw writeError;
    return undefined;
  });
}

/** The (path, contents) of every export write sent to Rust. */
const writes = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([cmd]) => cmd === 'mcp_export_write')
    .map(([, args]) => args as { path: string; contents: string });

const exportButton = () => screen.getByRole('button', { name: /Export for Casper \/ Claude/ });

describe('McpServers export', () => {
  beforeEach(() => {
    resetHiddenRefreshForTests();
    vi.mocked(invoke).mockReset();
    vi.mocked(tauriSave).mockReset();
    vi.mocked(notify.success).mockReset();
    vi.mocked(notify.error).mockReset();
    vi.mocked(notify.warning).mockReset();
  });

  it('with no saved servers, exports GreenCLI\'s own read-only server', async () => {
    const path = '/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp';
    backend([], undefined, { path, exists: true, place: 'normal', dataDir: DATA_DIR });
    vi.mocked(tauriSave).mockResolvedValue('/Users/me/proj/.mcp.json');
    render(<McpServers />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_list_servers'));
    expect(exportButton()).not.toBeDisabled();
    fireEvent.click(exportButton());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].contents)).toEqual({
      mcpServers: { greencli: { type: 'stdio', command: path, args: ['--data-dir', DATA_DIR] } },
    });
  });

  it('says so when greencli-mcp is missing, and saves nothing without servers', async () => {
    backend([], undefined, { path: '/opt/GreenCLI/greencli-mcp', exists: false, place: 'normal', dataDir: DATA_DIR });
    render(<McpServers />);
    expect(await screen.findByText(/isn't next to GreenCLI in this build/)).toBeTruthy();
    fireEvent.click(exportButton());
    await waitFor(() => expect(notify.warning).toHaveBeenCalled());
    expect(vi.mocked(notify.warning).mock.calls[0][1]).toContain('was left out');
    expect(tauriSave).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it('shows the greencli-mcp path, the claude command and the hidden copy count', async () => {
    const path = '/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp';
    backend([], undefined, { path, exists: true, place: 'normal', dataDir: DATA_DIR }, { missing: 2, stale: 1 });
    render(<McpServers />);
    expect(await screen.findByText(path)).toBeTruthy();
    // User scope: Claude Code's default (local) would add it only for the folder the command runs in.
    // --data-dir: the server may not find GreenCLI's data folder from its own environment.
    const command = `claude mcp add --scope user greencli -- "${path}" --data-dir "${DATA_DIR}"`;
    expect(screen.getByText(command)).toBeTruthy();
    fireEvent.click(screen.getByTitle('Copy the command'));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(command));
    expect(
      screen.getByText('3 snapshots need a new hidden copy. Open Config Archive and click Make hidden copies.'),
    ).toBeTruthy();
    expect(screen.queryByText('Move GreenCLI to Applications first.')).toBeNull();
    // The button is in the Config Archive panel, not in Settings: the link
    // opens the panel and closes Settings, which covers it.
    useSessionStore.setState({ showSettings: true, showConfigEditor: false, showArchive: false });
    fireEvent.click(screen.getByRole('button', { name: 'Open Config Archive' }));
    expect(useSessionStore.getState()).toMatchObject({ showSettings: false, showConfigEditor: true, showArchive: true });
  });

  it('counts hidden copies again after the background refresh', async () => {
    const path = '/Applications/GreenCLI.app/Contents/MacOS/greencli-mcp';
    let todo = [
      { device: 'sw1', ts: 1 },
      { device: 'sw1', ts: 2 },
    ];
    vi.mocked(invoke).mockImplementation(async (cmd: string, raw?: unknown) => {
      const args = raw as { ts: number } | undefined;
      if (cmd === 'mcp_list_servers') return [];
      if (cmd === 'greencli_mcp_info') return { path, exists: true, place: 'normal', dataDir: DATA_DIR };
      if (cmd === 'config_archive_missing_hidden') return { missing: 0, stale: todo.length, current: 0, todo };
      if (cmd === 'config_archive_get') return 'raw';
      if (cmd === 'config_archive_set_hidden') {
        todo = todo.filter((t) => t.ts !== args?.ts);
        return null;
      }
      if (cmd === 'mcp_status') return [];
      return undefined;
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    render(<McpServers />);
    expect(await screen.findByText(path)).toBeTruthy();
    await waitFor(() => expect(info).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/need(s)? a new hidden copy/)).toBeNull());
    expect(todo).toEqual([]);
    info.mockRestore();
  });

  it('asks to move a translocated app, and leaves greencli out of the export', async () => {
    const path = '/private/var/folders/x/AppTranslocation/1/d/GreenCLI.app/Contents/MacOS/greencli-mcp';
    backend(SERVERS, undefined, { path, exists: true, place: 'translocated', dataDir: DATA_DIR });
    vi.mocked(tauriSave).mockResolvedValue('/Users/me/proj/.mcp.json');
    render(<McpServers />);
    expect(await screen.findByText('Move GreenCLI to Applications first.')).toBeTruthy();
    fireEvent.click(exportButton());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(Object.keys(JSON.parse(writes()[0].contents).mcpServers)).toEqual(['central', 'remote']);
    expect(await screen.findByText(/move GreenCLI to Applications first, then export again/)).toBeTruthy();
  });

  it('saves a .mcp.json without secrets and lists the variables to set', async () => {
    backend(SERVERS);
    vi.mocked(tauriSave).mockResolvedValue('/Users/me/proj/.mcp.json');
    render(<McpServers />);
    await screen.findByText('central');
    fireEvent.click(exportButton());

    await screen.findByText('Saved 2 servers to /Users/me/proj/.mcp.json');
    expect(tauriSave).toHaveBeenCalledWith('.mcp.json', 'Export MCP servers');
    expect(writes()).toHaveLength(1);
    const { path, contents: text } = writes()[0];
    expect(path).toBe('/Users/me/proj/.mcp.json');
    expect(text).not.toMatch(/tok-SECRET|hdr-SECRET/);
    const file = JSON.parse(text);
    expect(file.mcpServers.central).toEqual({
      type: 'stdio',
      command: 'uvx',
      args: ['aruba-tool-router'],
      env: { CREDS_PATH: '${CENTRAL_CREDS_PATH}', MIST_API_TOKEN: '${MIST_API_TOKEN}' },
    });
    expect(file.mcpServers.remote).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${REMOTE_AUTHORIZATION_SECRET}' },
    });

    const panel = screen.getByRole('status');
    expect(panel.textContent).toContain('MIST_API_TOKEN');
    expect(panel.textContent).toContain('REMOTE_AUTHORIZATION_SECRET');
    expect(panel.textContent).toContain('CENTRAL_CREDS_PATH');
    expect(panel.textContent).not.toContain('SECRET-');
    expect(panel.textContent).toContain('remote: it is turned off in GreenCLI');
    expect(notify.success).toHaveBeenCalledWith('MCP servers exported', '2 servers saved');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("refuses to write another app's settings file", async () => {
    backend(SERVERS);
    vi.mocked(tauriSave).mockResolvedValue('/Users/me/.claude.json');
    render(<McpServers />);
    await screen.findByText('central');
    fireEvent.click(exportButton());
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Not saved', expect.stringContaining("other apps' own settings")));
    expect(writes()).toEqual([]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does nothing when the save dialog is cancelled', async () => {
    backend(SERVERS);
    vi.mocked(tauriSave).mockResolvedValue(null);
    render(<McpServers />);
    await screen.findByText('central');
    fireEvent.click(exportButton());
    await waitFor(() => expect(tauriSave).toHaveBeenCalled());
    await waitFor(() => expect(exportButton()).not.toBeDisabled());
    expect(writes()).toEqual([]);
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('shows the Rust error when the write fails', async () => {
    backend(SERVERS, 'Failed to write /p/.mcp.json: Permission denied');
    vi.mocked(tauriSave).mockResolvedValue('/p/.mcp.json');
    render(<McpServers />);
    await screen.findByText('central');
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith('Could not export MCP servers', 'Failed to write /p/.mcp.json: Permission denied'),
    );
  });

  it('shows the Rust refusal when the file is a link', async () => {
    const linked = 'That file is a link to another file, so GreenCLI did not write it. Pick another place, or remove the link first.';
    backend(SERVERS, linked);
    vi.mocked(tauriSave).mockResolvedValue('/p/.mcp.json');
    render(<McpServers />);
    await screen.findByText('central');
    fireEvent.click(exportButton());
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not export MCP servers', linked));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stops with a message when a login can not be checked', async () => {
    const unreachable =
      "Can't reach the system password store. Keys saved on this computer are still there. Try again after you log in to the desktop.";
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'mcp_list_servers') return SERVERS;
      if (cmd === 'mcp_status') return [];
      if (cmd === 'mcp_has_credentials') throw unreachable;
      return undefined;
    });
    vi.mocked(tauriSave).mockResolvedValue('/Users/me/proj/.mcp.json');
    render(<McpServers />);
    await screen.findByText('central');
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith('Could not export', `Can't check the login for central. ${unreachable}`),
    );
    expect(tauriSave).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('opens no dialog when every server is left out', async () => {
    backend([{ ...SERVERS[0], name: 'sh', command: 'bash' }]);
    render(<McpServers />);
    await screen.findByText('sh');
    fireEvent.click(exportButton());
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('Nothing to export', expect.stringContaining('"sh" was left out')));
    expect(tauriSave).not.toHaveBeenCalled();
  });
});
