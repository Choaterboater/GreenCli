import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn() }));
vi.mock('../store/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/dialogStore')>()),
  askConfirm: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/tauri';
import McpServers from './McpServers';
import { allowWritesMessage } from './McpServerSafety';
import { askConfirm } from '../store/dialogStore';
import { useMcpApprovalStore } from '../store/mcpApprovalStore';
import { useToastStore } from '../store/toastStore';
import type { McpServerDef, McpStatus } from '../utils/mcpTypes';

let defs: McpServerDef[] = [];
let status: McpStatus[] = [];

const junosDef = (showOptIn = false): McpServerDef => ({
  name: 'srx',
  transport: 'stdio',
  command: 'python3',
  args: ['jmcp.py'],
  env: {},
  enabled: true,
  ...(showOptIn ? { showOptIn } : {}),
});

const plainDef = (extra: Partial<McpServerDef> = {}): McpServerDef => ({
  name: 'central',
  transport: 'stdio',
  command: 'uv',
  args: ['run', 'centralmcp'],
  env: {},
  enabled: true,
  writes: 'off',
  ...extra,
});

const st = (extra: Partial<McpStatus> = {}): McpStatus => ({
  name: 'central',
  enabled: true,
  connected: true,
  toolCount: 4,
  preset: null,
  presetMismatch: false,
  writes: 'off',
  writesSet: true,
  hiddenToolCount: 0,
  pins: { kind: 'none' },
  access: 'unknown',
  restartNeeded: false,
  ...extra,
});

const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'mcp_list_servers') return defs;
    if (cmd === 'mcp_status') return status;
    if (cmd === 'mcp_connect') return 3;
    return null;
  });
  vi.mocked(askConfirm).mockReset();
  useMcpApprovalStore.getState().clearAll();
  useToastStore.getState().clear();
});

describe('McpServers safety lines', () => {
  it('shows the Junos opt-in and turns it on', async () => {
    defs = [junosDef()];
    status = [
      {
        name: 'srx',
        enabled: true,
        connected: true,
        toolCount: 3,
        preset: { id: 'junos-mcp-server', label: 'Junos' },
        presetBy: 'definition',
        presetMismatch: false,
      },
    ];
    useMcpApprovalStore.getState().allow('srx', 'execute_junos_command', 'fp');
    render(<McpServers />);
    const box = await screen.findByRole('checkbox', { name: 'Run plain show commands without asking' });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/Only commands that start with "show"/)).toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_set_show_opt_in', { name: 'srx', on: true }));
    expect(useMcpApprovalStore.getState().isAllowed('srx', 'execute_junos_command', 'fp')).toBe(false);
  });

  it('shows the opt-in as on when it is saved on', async () => {
    defs = [junosDef(true)];
    status = [{ name: 'srx', enabled: true, connected: false, toolCount: 0, preset: { id: 'junos-mcp-server', label: 'Junos' } }];
    render(<McpServers />);
    expect(await screen.findByRole('checkbox', { name: 'Run plain show commands without asking' })).toBeChecked();
  });

  it('warns when the tools do not match the preset', async () => {
    defs = [{ ...junosDef(), name: 'hpe', args: ['tool_router.py'] }];
    status = [
      {
        name: 'hpe',
        enabled: true,
        connected: true,
        toolCount: 2,
        preset: { id: 'hpe-networking-mcp', label: 'HPE networking' },
        presetBy: 'definition',
        presetMismatch: true,
      },
    ];
    render(<McpServers />);
    expect(
      await screen.findByText(/This looks like a HPE networking server, but its tools don't match/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Run plain show commands without asking' })).toBeNull();
  });

  it('shows nothing extra for a plain server', async () => {
    defs = [{ ...junosDef(), name: 'plain', args: ['x'] }];
    status = [{ name: 'plain', enabled: true, connected: true, toolCount: 1, preset: null, presetMismatch: false }];
    render(<McpServers />);
    await screen.findByText('plain');
    expect(screen.queryByRole('checkbox', { name: 'Run plain show commands without asking' })).toBeNull();
    expect(screen.queryByText(/This looks like/)).toBeNull();
    expect(screen.queryByText(/· \d+ hidden/)).toBeNull();
  });
});

describe('McpServers writes switch', () => {
  it('is off with its help line, and asks before turning writes on', async () => {
    defs = [plainDef()];
    status = [st({ pins: { kind: 'pinned', shown: ['CENTRALMCP_READONLY=1'], confirmed: false } })];
    vi.mocked(askConfirm).mockResolvedValue(true);
    useMcpApprovalStore.getState().allow('central', 'get_site', 'fp');
    render(<McpServers />);
    const box = await screen.findByRole('checkbox', { name: 'Allow writes' });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/^Writes are off\. Tools that change settings or delete things are hidden/)).toBeInTheDocument();
    expect(screen.getByText('Read-only settings sent: CENTRALMCP_READONLY=1')).toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_set_writes', { name: 'central', writes: 'on' }));
    expect(askConfirm).toHaveBeenCalledWith({
      title: 'Allow writes on central?',
      message:
        "The AI will see this server's tools that change settings or delete things. Each one still asks you before it runs." +
        '\n\nGreenCLI will restart central without its read-only settings: CENTRALMCP_READONLY=1.',
      confirmLabel: 'Allow writes',
      cancelLabel: 'Keep writes off',
      danger: true,
    });
    // Connected, so it restarts without its pins.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_connect', { name: 'central' }));
    await waitFor(() => expect(toastTitles()).toContain('central writes are on'));
    expect(useMcpApprovalStore.getState().isAllowed('central', 'get_site', 'fp')).toBe(false);
  });

  it('keeps writes off when the user says no', async () => {
    defs = [plainDef()];
    status = [st()];
    vi.mocked(askConfirm).mockResolvedValue(false);
    render(<McpServers />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Allow writes' }));
    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith('mcp_set_writes', expect.anything());
  });

  it('turns writes off without asking, and does not restart a stopped server', async () => {
    defs = [plainDef({ writes: 'on' })];
    status = [st({ writes: 'on', connected: false })];
    render(<McpServers />);
    const box = await screen.findByRole('checkbox', { name: 'Allow writes' });
    expect(box).toBeChecked();
    expect(screen.getByText('Writes are on. Tools that change things still ask you every time.')).toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_set_writes', { name: 'central', writes: 'off' }));
    expect(askConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(toastTitles()).toContain('central writes are off'));
    expect(invoke).not.toHaveBeenCalledWith('mcp_connect', expect.anything());
  });

  it('is locked on a read-only login', async () => {
    defs = [plainDef()];
    status = [st({ access: 'read-only', hiddenToolCount: 5 })];
    render(<McpServers />);
    expect(await screen.findByRole('checkbox', { name: 'Allow writes' })).toBeDisabled();
    expect(screen.getByText("This login is read-only (checked by the server). Writes can't be turned on here.")).toBeInTheDocument();
    expect(screen.getByText('Login: read-only (checked)')).toBeInTheDocument();
    expect(screen.getByText('· 5 hidden')).toHaveAttribute('title', 'Hidden from the AI because the login is read-only');
  });

  it('shows the restart, upgrade, pins and login lines', async () => {
    defs = [plainDef({ writes: undefined })];
    status = [
      st({
        writesSet: false,
        restartNeeded: true,
        access: 'read-write',
        hiddenToolCount: 2,
        pins: { kind: 'pinned', shown: ['A=1', 'B=0'], confirmed: true },
      }),
    ];
    render(<McpServers />);
    expect(await screen.findByText('Read-only settings sent: A=1, B=0 (the server confirmed them)')).toBeInTheDocument();
    expect(screen.getByText('Login: can make changes (checked)')).toBeInTheDocument();
    expect(screen.getByText('· 2 hidden')).toHaveAttribute('title', 'Hidden from the AI because writes are off');
    expect(screen.getByText(/^Restart this server so its writes setting takes full effect\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_connect', { name: 'central' }));
    expect(screen.getByText(/^New in 1\.9: writes are off for this server\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_set_writes', { name: 'central', writes: 'off' }));
  });

  it('explains a server it cannot pin', async () => {
    defs = [plainDef()];
    status = [st({ pins: { kind: 'cannot-pin', reason: 'it has no read-only setting' } })];
    render(<McpServers />);
    expect(
      await screen.findByText(
        "Can't set this server to read-only (it has no read-only setting). GreenCLI still hides and blocks its write tools."
      )
    ).toBeInTheDocument();
  });

  it('says so when a save turns writes off again', async () => {
    defs = [plainDef({ writes: 'on' })];
    status = [st({ writes: 'on' })];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'mcp_list_servers') return defs;
      if (cmd === 'mcp_status') return status;
      if (cmd === 'mcp_save_server') {
        defs = [plainDef({ writes: 'off', args: ['run', 'centralmcp', '--debug'] })];
      }
      return null;
    });
    render(<McpServers />);
    fireEvent.click(await screen.findByTitle('Edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastTitles()).toContain('central writes are off again'));
    const toast = useToastStore.getState().toasts.find((t) => t.title === 'central writes are off again');
    expect(toast?.message).toBe("The server's command, folder or URL changed, so GreenCLI turned writes off.");
  });
});

describe('McpServers form help', () => {
  it('warns about plain http to another computer, and explains the environment', async () => {
    defs = [];
    status = [];
    render(<McpServers />);
    fireEvent.click(await screen.findByRole('button', { name: /Add server/ }));
    expect(screen.getByText(/Servers get only a few basic variables from GreenCLI/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Streamable HTTP/ }));
    const url = screen.getByPlaceholderText('http://127.0.0.1:8010/mcp');
    fireEvent.change(url, { target: { value: 'http://127.0.0.1:8010/mcp' } });
    expect(screen.queryByText(/^Plain http:\/\/ to another computer/)).toBeNull();
    fireEvent.change(url, { target: { value: 'http://10.0.0.5:8010/mcp' } });
    expect(screen.getByText(/^Plain http:\/\/ to another computer: anyone on the network/)).toBeInTheDocument();
    fireEvent.change(url, { target: { value: 'https://10.0.0.5/mcp' } });
    expect(screen.queryByText(/^Plain http:\/\/ to another computer/)).toBeNull();
  });
});

describe('allowWritesMessage', () => {
  it('names the read-only settings only when a pinned server is connected', () => {
    const base =
      "The AI will see this server's tools that change settings or delete things. Each one still asks you before it runs.";
    expect(allowWritesMessage('c', undefined)).toBe(base);
    const pinned = st({ pins: { kind: 'pinned', shown: ['X=1'], confirmed: false } });
    expect(allowWritesMessage('c', { ...pinned, connected: false })).toBe(base);
    expect(allowWritesMessage('c', pinned)).toBe(`${base}\n\nGreenCLI will restart c without its read-only settings: X=1.`);
  });
});
