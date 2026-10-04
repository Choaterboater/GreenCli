import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import McpLiveSwitch, { readLiveStatus, type LiveStatus } from './McpLiveSwitch';
import { notify } from '../store/toastStore';
import { useMcpApprovalStore } from '../store/mcpApprovalStore';
import { liveRequestsStopped, resumeLiveRequests } from '../utils/mcpLive';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../utils/fileSystem', () => ({ isTauri: true }));
vi.mock('../store/toastStore', () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const LABEL = 'Let AI tools outside GreenCLI ask to run show commands (asks you first)';

const status = (extra: Partial<LiveStatus> = {}): LiveStatus => ({
  on: true,
  listening: true,
  supported: true,
  problem: null,
  ...extra,
});

/** Rust's side: the switch is remembered, and set answers with the new status. */
function backend(start: LiveStatus, setError?: string) {
  let now = start;
  vi.mocked(invoke).mockImplementation(async (cmd: string, raw?: unknown) => {
    const args = raw as { on?: boolean } | undefined;
    if (cmd === 'mcp_live_status') return now;
    if (cmd === 'mcp_live_set') {
      if (setError) throw setError;
      now = { ...now, on: !!args?.on, listening: !!args?.on };
      return now;
    }
    return undefined;
  });
}

const sets = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([cmd]) => cmd === 'mcp_live_set')
    .map(([, a]) => a);

describe('McpLiveSwitch', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(notify.error).mockReset();
  });

  it('is on by default, and one click turns it off', async () => {
    backend(status());
    render(<McpLiveSwitch />);
    const box = await screen.findByRole('checkbox', { name: LABEL });
    expect(box).toBeChecked();
    expect(screen.getByText(/Casper asks first/)).toBeInTheDocument();

    fireEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(sets()).toEqual([{ on: false }]);
  });

  it('turning it off forgets every "Yes on this device" answer', async () => {
    backend(status());
    useMcpApprovalStore.getState().allowDevice('greencli-mcp', 'device_show', 'sw-a');
    render(<McpLiveSwitch />);
    const box = await screen.findByRole('checkbox', { name: LABEL });
    fireEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(useMcpApprovalStore.getState().devices).toEqual({});
  });

  it('turning it off refuses requests from then on, and turning it back on takes them again', async () => {
    resumeLiveRequests();
    backend(status());
    render(<McpLiveSwitch />);
    const box = await screen.findByRole('checkbox', { name: LABEL });
    fireEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(liveRequestsStopped()).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(liveRequestsStopped()).toBe(false);
  });

  it('stays refusing when turning it back on fails', async () => {
    resumeLiveRequests();
    backend(status());
    const { unmount } = render(<McpLiveSwitch />);
    const box = await screen.findByRole('checkbox', { name: LABEL });
    fireEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    unmount();
    backend(status({ on: false, listening: false }), 'no');
    render(<McpLiveSwitch />);
    const again = await screen.findByRole('checkbox', { name: LABEL });
    fireEvent.click(again);
    await waitFor(() => expect(notify.error).toHaveBeenCalled());
    expect(liveRequestsStopped()).toBe(true);
  });

  it('describes the three buttons, with no number keys', async () => {
    backend(status());
    render(<McpLiveSwitch />);
    const text = (await screen.findByText(/Casper asks first/)).textContent ?? '';
    expect(text).toContain('No, Yes this once, or Yes, show commands on this device until GreenCLI closes');
    expect(text).not.toMatch(/\b[123]\b/);
  });

  it('turns it back on', async () => {
    backend(status({ on: false, listening: false }));
    render(<McpLiveSwitch />);
    const box = await screen.findByRole('checkbox', { name: LABEL });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(sets()).toEqual([{ on: true }]);
  });

  it('says why it is not open although the switch is on', async () => {
    const problem = 'GreenCLI\'s data folder path is too long for show commands.';
    backend(status({ listening: false, problem }));
    render(<McpLiveSwitch />);
    expect(await screen.findByText(problem)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: LABEL })).toBeChecked();
  });

  it('shows a plain error when it can\'t start, and keeps the saved choice', async () => {
    const problem = 'Another GreenCLI is already open; show commands go to that one.';
    backend(status({ on: false, listening: false }), problem);
    render(<McpLiveSwitch />);
    const box = await screen.findByRole('checkbox', { name: LABEL });
    // Rust saved "on" before it failed to open: the status read again says so.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'mcp_live_set') throw problem;
      if (cmd === 'mcp_live_status') return status({ listening: false, problem });
      return undefined;
    });
    fireEvent.click(box);
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Show commands', problem));
    await waitFor(() => expect(box).toBeChecked());
    expect(screen.getByText(problem)).toBeInTheDocument();
  });

  it('on Windows says not yet, with no switch', async () => {
    backend(status({ on: true, listening: false, supported: false }));
    render(<McpLiveSwitch />);
    expect(await screen.findByText(/aren.t on Windows yet/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('shows nothing when the status can\'t be read', async () => {
    vi.mocked(invoke).mockRejectedValue('no backend');
    const { container } = render(<McpLiveSwitch />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('mcp_live_status'));
    expect(container).toBeEmptyDOMElement();
  });

  it('readLiveStatus drops an answer that is not a status', async () => {
    vi.mocked(invoke).mockResolvedValue({ on: 'yes' });
    expect(await readLiveStatus()).toBeNull();
    vi.mocked(invoke).mockResolvedValue(status());
    expect(await readLiveStatus()).toEqual(status());
  });
});
