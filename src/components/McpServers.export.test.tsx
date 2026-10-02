import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import McpServers from './McpServers';
import { tauriSave } from '../utils/fileSystem';
import { notify } from '../store/toastStore';
import type { McpServerDef } from '../utils/mcpTypes';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../utils/fileSystem', () => ({ isTauri: true, tauriSave: vi.fn() }));
vi.mock('../store/toastStore', () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

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

function backend(servers: McpServerDef[], writeError?: string) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, raw?: unknown) => {
    const args = raw as Record<string, unknown> | undefined;
    if (cmd === 'mcp_list_servers') return servers;
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
    vi.mocked(invoke).mockReset();
    vi.mocked(tauriSave).mockReset();
    vi.mocked(notify.success).mockReset();
    vi.mocked(notify.error).mockReset();
  });

  it('is disabled until there is a server', async () => {
    backend([]);
    render(<McpServers />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_list_servers'));
    expect(exportButton()).toBeDisabled();
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

  it('opens no dialog when every server is left out', async () => {
    backend([{ ...SERVERS[0], name: 'sh', command: 'bash' }]);
    render(<McpServers />);
    await screen.findByText('sh');
    fireEvent.click(exportButton());
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('Nothing to export', expect.stringContaining('"sh" was left out')));
    expect(tauriSave).not.toHaveBeenCalled();
  });
});
