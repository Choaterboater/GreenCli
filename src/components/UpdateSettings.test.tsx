import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  (globalThis as unknown as Record<string, unknown>).isTauri = true;
});
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import UpdateSettings from './UpdateSettings';
import { UPDATE_TEXT, dailyCheckOn, type UpdateStatus } from '../utils/updates';

const ON: UpdateStatus = { version: '2.0.0', enabled: true, reason: null, place: 'normal', ready: null };

function answer(status: UpdateStatus, check?: () => Promise<unknown>) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'update_status') return status;
    if (cmd === 'update_check') return check ? check() : null;
    return undefined;
  });
}

describe('UpdateSettings', () => {
  beforeEach(() => {
    invoke.mockReset();
    localStorage.clear();
  });

  it('shows the version, how updates work, and the daily option', async () => {
    answer(ON);
    render(<UpdateSettings />);
    expect(await screen.findByText('Version 2.0.0')).toBeTruthy();
    expect(screen.getByText(UPDATE_TEXT.how)).toBeTruthy();
    const daily = screen.getByLabelText('Check once a day') as HTMLInputElement;
    expect(daily.checked).toBe(true);
    fireEvent.click(daily);
    expect(dailyCheckOn()).toBe(false);
  });

  it('checks, then says it is the latest version', async () => {
    let finish: (v: unknown) => void = () => {};
    answer(ON, () => new Promise((r) => (finish = r)));
    render(<UpdateSettings />);
    await screen.findByText('Version 2.0.0');
    fireEvent.click(screen.getByText('Check for updates'));
    expect(await screen.findByText('Checking…')).toBeTruthy();
    finish(null);
    expect(await screen.findByText(UPDATE_TEXT.latest)).toBeTruthy();
  });

  it('offers Restart to update when a version is ready', async () => {
    answer(ON, async () => '2.0.1');
    render(<UpdateSettings />);
    await screen.findByText('Version 2.0.0');
    fireEvent.click(screen.getByText('Check for updates'));
    expect(await screen.findByText('GreenCLI 2.0.1 is ready.')).toBeTruthy();
    expect(screen.getByText('Restart to update')).toBeTruthy();
  });

  it('shows an update downloaded earlier', async () => {
    answer({ ...ON, ready: '2.0.1' });
    render(<UpdateSettings />);
    expect(await screen.findByText('GreenCLI 2.0.1 is ready.')).toBeTruthy();
  });

  it('shows a failed check in plain words', async () => {
    answer(ON, () => Promise.reject(UPDATE_TEXT.checkFailed));
    render(<UpdateSettings />);
    await screen.findByText('Version 2.0.0');
    fireEvent.click(screen.getByText('Check for updates'));
    expect(await screen.findByText(UPDATE_TEXT.checkFailed)).toBeTruthy();
  });

  it('turns the button off when updates are off', async () => {
    answer({ ...ON, enabled: false, reason: 'platform' });
    render(<UpdateSettings />);
    expect(await screen.findByText(UPDATE_TEXT.off)).toBeTruthy();
    expect((screen.getByText('Check for updates').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Check once a day')).toBeNull();
  });

  it('says development builds have no updates', async () => {
    answer({ ...ON, enabled: false, reason: 'dev' });
    render(<UpdateSettings />);
    expect(await screen.findByText(UPDATE_TEXT.offDev)).toBeTruthy();
  });

  it('asks to move the app first when it runs from the disk image', async () => {
    answer({ ...ON, place: 'diskImage', ready: '2.0.1' });
    render(<UpdateSettings />);
    expect(await screen.findByText(UPDATE_TEXT.moveFirst)).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByText('Restart to update').closest('button') as HTMLButtonElement).disabled).toBe(true),
    );
  });
});
