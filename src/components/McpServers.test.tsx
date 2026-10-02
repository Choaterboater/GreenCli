import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/tauri';
import McpServers from './McpServers';
import { useMcpApprovalStore } from '../store/mcpApprovalStore';
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

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'mcp_list_servers') return defs;
    if (cmd === 'mcp_status') return status;
    return null;
  });
  useMcpApprovalStore.getState().clearAll();
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
  });
});
