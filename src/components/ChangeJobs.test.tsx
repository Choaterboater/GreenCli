import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/tauri';
import ChangeJobs from './ChangeJobs';
import { useSessionStore } from '../store/sessionStore';
import { useDialogStore } from '../store/dialogStore';
import { runDevice, type DeviceControl, type DeviceOutcome } from '../utils/changeJobs';
import type { ConnectionConfig, Session } from '../types';

vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn().mockResolvedValue('') }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock('@tauri-apps/api/dialog', () => ({ open: vi.fn(), save: vi.fn() }));
// The device runner has its own tests; here it only has to honor the canary hold.
vi.mock('../utils/changeJobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/changeJobs')>();
  return {
    ...actual,
    runDevice: vi.fn(async (_plan: unknown, _io: unknown, ctl: DeviceControl): Promise<DeviceOutcome> => {
      const base = { before: null, after: null, revertsAt: null, touched: true };
      if (!ctl.hold) return { ...base, status: 'ok', detail: 'Changed.' };
      const d = await ctl.hold(Date.now() + 5 * 60_000);
      return d === 'keep' ? { ...base, status: 'ok', detail: 'Changed.' } : { ...base, status: 'rolled-back', detail: 'Not kept.' };
    }),
  };
});

const host = (id: string, h: string, deviceType: ConnectionConfig['deviceType']): ConnectionConfig => ({
  id,
  name: id,
  protocol: 'ssh',
  host: h,
  deviceType,
});

function openWith(items: ConnectionConfig[]) {
  useSessionStore.setState({
    showChangeJobs: true,
    sessions: [],
    folders: [{ id: 'core', name: 'Core', expanded: true, items }],
  });
  const onConnect = vi.fn();
  render(<ChangeJobs onConnect={onConnect} />);
  return onConnect;
}

describe('ChangeJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue('');
  });

  it('dry run shows each vendor’s exact lines and sends nothing', () => {
    const onConnect = openWith([host('cx1', '10.0.0.1', 'aruba-cx'), host('ex1', '10.0.0.2', 'juniper-junos')]);
    fireEvent.click(screen.getByText('Core'));
    expect(screen.getByText('2 devices in this job')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/^vlan \$\{vlan\}/), { target: { value: 'set vlans V${vlan} vlan-id ${vlan}' } });
    fireEvent.change(screen.getByPlaceholderText(/device,vlan,vlan_name/), { target: { value: 'device,vlan\ncx1,10\nex1,20' } });
    fireEvent.click(screen.getByRole('button', { name: /Dry run/ }));

    expect(screen.getByText('Dry run — nothing has been sent.')).toBeInTheDocument();
    expect(screen.getByText('checkpoint auto 5')).toBeInTheDocument();
    expect(screen.getByText('set vlans V10 vlan-id 10')).toBeInTheDocument();
    expect(screen.getByText('commit confirmed 5 comment "GreenCLI change job"')).toBeInTheDocument();
    expect(screen.getByText('set vlans V20 vlan-id 20')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run — cx1 first/ })).toBeEnabled();
    expect(onConnect).not.toHaveBeenCalled();
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'send_data')).toBe(false);
  });

  it('blocks Run while a device is missing a variable, until it is left out', () => {
    openWith([host('cx1', '10.0.0.1', 'aruba-cx'), host('cx2', '10.0.0.3', 'aruba-cx')]);
    fireEvent.click(screen.getByText('Core'));
    fireEvent.change(screen.getByPlaceholderText(/^vlan \$\{vlan\}/), { target: { value: 'vlan ${vlan}' } });
    fireEvent.change(screen.getByPlaceholderText(/device,vlan,vlan_name/), { target: { value: 'device,vlan\ncx1,10' } });
    fireEvent.click(screen.getByRole('button', { name: /Dry run/ }));

    expect(screen.getByText(/No row for this device in the variables table/)).toBeInTheDocument();
    const run = screen.getByRole('button', { name: /Run — cx1 first/ });
    expect(run).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Leave those out' }));
    expect(run).toBeEnabled();
  });

  it('says which vendors have no rollback timer', () => {
    openWith([host('s1', '10.0.0.9', 'aruba-aos-s')]);
    fireEvent.click(screen.getByText('Core'));
    expect(screen.getByText(/No rollback timer on AOS-S in this job/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/^vlan \$\{vlan\}/), { target: { value: 'vlan 30' } });
    fireEvent.click(screen.getByRole('button', { name: /Dry run/ }));
    const card = screen.getByText('s1').closest('div.rounded-lg') as HTMLElement;
    expect(within(card).getByText('no rollback timer')).toBeInTheDocument();
  });

  describe('the canary pause', () => {
    const tab = (id: string): Session => ({
      sessionId: id,
      connected: true,
      config: host(id, `10.0.0.${id.length}${id.slice(-1)}`, 'aruba-cx'),
    });

    async function startJob() {
      useSessionStore.setState({ showChangeJobs: true, folders: [], sessions: [tab('cx1'), tab('cx2')] });
      // Both tabs sit at an exec prompt.
      vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === 'get_terminal_output' ? 'banner\ncx# ' : undefined));
      render(<ChangeJobs onConnect={vi.fn()} />);
      fireEvent.click(screen.getByText('cx1'));
      fireEvent.click(screen.getByText('cx2'));
      fireEvent.change(screen.getByPlaceholderText(/^vlan \$\{vlan\}/), { target: { value: 'vlan 40' } });
      fireEvent.click(screen.getByRole('button', { name: /Dry run/ }));
      fireEvent.click(screen.getByRole('button', { name: /Run — cx1 first/ }));
      // Answer the "Start the change job?" confirm.
      await waitFor(() => expect(useDialogStore.getState().current).not.toBeNull());
      const dlg = useDialogStore.getState().current!;
      expect(dlg.title).toBe('Start the change job on 2 devices?');
      dlg.resolve('');
      useDialogStore.getState().close();
      await screen.findByText(/The canary, cx1, passed its checks/, undefined, { timeout: 5000 });
    }

    it('runs only the canary, then the rest after Continue', async () => {
      await startJob();
      expect(vi.mocked(runDevice)).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/rolls back on its own in/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Confirm and continue with the other 1' }));
      await screen.findByText(/The job finished\./, undefined, { timeout: 5000 });
      expect(vi.mocked(runDevice)).toHaveBeenCalledTimes(2);
    });

    it('"Roll back and stop" keeps the others untouched', async () => {
      await startJob();
      fireEvent.click(screen.getByRole('button', { name: 'Roll back and stop' }));
      await screen.findByText(/You stopped at the canary \(cx1\) without keeping its change/, undefined, { timeout: 5000 });
      expect(vi.mocked(runDevice)).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Not run — you stopped the job at the canary.')).toBeInTheDocument();
    });
  });
});
