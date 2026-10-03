import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

type Deferred = { promise: Promise<unknown>; resolve: (v?: unknown) => void; reject: (e: unknown) => void };
function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  let reject!: Deferred['reject'];
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sftp = vi.hoisted(() => ({
  /** The transfer each call to sftp_upload / sftp_download waits on. */
  transfers: [] as Array<{ cmd: string; done: Deferred }>,
}));
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => '/home/me/fw.bin'),
  save: vi.fn(async () => '/home/me/startup.cfg'),
}));
const askConfirm = vi.hoisted(() => vi.fn());
vi.mock('../store/dialogStore', () => ({ askConfirm, askPrompt: vi.fn() }));

import SftpBrowser from './SftpBrowser';
import { exitHolds } from '../utils/beforeExit';
import { restartToUpdate } from '../utils/updates';
import { useToastStore } from '../store/toastStore';

const cmds = () => invoke.mock.calls.map((c) => c[0]);

beforeEach(() => {
  sftp.transfers = [];
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'sftp_list_dir') return [{ name: 'startup.cfg', is_dir: false, size: 120 }];
    if (cmd === 'sftp_upload' || cmd === 'sftp_download') {
      const done = deferred();
      sftp.transfers.push({ cmd, done });
      return done.promise;
    }
    throw `unexpected ${cmd}`;
  });
  askConfirm.mockReset();
  useToastStore.getState().clear();
});

afterEach(() => {
  // Never leave a hold behind for the next test.
  for (const t of sftp.transfers) t.done.reject('test over');
});

/** The transfer that is running now. */
async function running(cmd: string) {
  await waitFor(() => expect(sftp.transfers.map((t) => t.cmd)).toContain(cmd));
  return sftp.transfers[sftp.transfers.length - 1].done;
}

describe('SFTP transfers hold Restart to update', () => {
  it('holds it while an upload runs, then lets go', async () => {
    render(<SftpBrowser sessionId="s1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    const upload = await running('sftp_upload');
    expect(exitHolds()).toEqual(['A file upload is running.']);

    await expect(restartToUpdate('2.0.1')).resolves.toBe(false);
    const notNow = useToastStore.getState().toasts.find((t) => t.title === 'Not now');
    expect(notNow?.message).toBe('A file upload is running. Restart to update when it ends.');
    expect(cmds()).not.toContain('update_status');
    expect(cmds()).not.toContain('update_install');

    upload.resolve(10);
    await waitFor(() => expect(exitHolds()).toEqual([]));
  });

  it('keeps holding through the Overwrite question, and lets go on No', async () => {
    let heldWhileAsking: string[] = [];
    askConfirm.mockImplementation(async () => {
      heldWhileAsking = exitHolds();
      return false;
    });
    render(<SftpBrowser sessionId="s1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    (await running('sftp_upload')).reject("EEXIST: '/fw.bin' already exists on the remote");
    await waitFor(() => expect(askConfirm).toHaveBeenCalledTimes(1));
    expect(heldWhileAsking).toEqual(['A file upload is running.']);
    await waitFor(() => expect(exitHolds()).toEqual([]));
    expect(sftp.transfers).toHaveLength(1);
  });

  it('holds it while a download runs, and lets go when it fails', async () => {
    render(<SftpBrowser sessionId="s1" onClose={() => {}} />);
    fireEvent.click(await screen.findByTitle('Download'));
    const download = await running('sftp_download');
    expect(exitHolds()).toEqual(['A file download is running.']);
    download.reject('connection lost');
    await waitFor(() => expect(exitHolds()).toEqual([]));
  });
});
