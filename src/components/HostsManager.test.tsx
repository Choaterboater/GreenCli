import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import HostsManager from './HostsManager';
import { notify } from '../store/toastStore';
import { tauriSave } from '../utils/fileSystem';
import { copyText } from '../utils/clipboard';
import { useSessionStore } from '../store/sessionStore';
import type { ConnectionConfig } from '../types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../store/toastStore', () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../utils/fileSystem', () => ({ isTauri: true, tauriSave: vi.fn() }));
vi.mock('../utils/clipboard', () => ({ copyText: vi.fn(async () => true) }));

function backend(forgetError?: string, forgetNotice: string | null = null) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'list_known_hosts') return [{ hostPort: 'r1:22', fingerprint: 'SHA256:aaa' }];
    if (cmd === 'remove_known_host') {
      if (forgetError) throw forgetError;
      return forgetNotice;
    }
    return undefined;
  });
}

describe('Forget a host key', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says the key is forgotten when it worked', async () => {
    backend();
    render(<HostsManager />);
    fireEvent.click(await screen.findByTitle('Forget (re-trust on next connect)'));
    await waitFor(() => expect(notify.info).toHaveBeenCalledWith('Host key forgotten', expect.any(String)));
    expect(notify.warning).not.toHaveBeenCalled();
  });

  it('says where a damaged host keys file went when Forget moved it aside', async () => {
    const notice = 'Your saved host keys file was damaged. Kept 1 host; the old file was saved as known_hosts.json.corrupt.';
    backend(undefined, notice);
    render(<HostsManager />);
    fireEvent.click(await screen.findByTitle('Forget (re-trust on next connect)'));
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('Host keys file was damaged', notice));
    expect(notify.info).toHaveBeenCalledWith('Host key forgotten', expect.any(String));
  });

  it('shows the error, and no success, when the save failed', async () => {
    const err = "Couldn't forget r1:22: the host keys file couldn't be saved.";
    backend(err);
    render(<HostsManager />);
    fireEvent.click(await screen.findByTitle('Forget (re-trust on next connect)'));
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith("Couldn't forget host key", err));
    expect(notify.info).not.toHaveBeenCalled();
  });
});

// ─── Export lab hosts for Casper ───

const labHost = (over: Partial<ConnectionConfig>): ConnectionConfig =>
  ({ id: over.name ?? 'x', name: 'x', protocol: 'ssh', deviceType: 'generic', tags: ['lab'], ...over }) as ConnectionConfig;

function useHosts(items: ConnectionConfig[]) {
  useSessionStore.setState({ folders: [{ id: 'f1', name: 'Lab', items, expanded: true }] });
}

/** The lab file writes sent to Rust (the known-hosts list on mount is not one). */
const writes = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([cmd]) => cmd === 'mcp_export_write')
    .map(([, args]) => args as { path: string; contents: string });

const exportButton = () => screen.getByRole('button', { name: /Export lab hosts for Casper/ });

describe('Export lab hosts for Casper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backend();
  });

  it('with no lab hosts, says how to tag one and saves nothing', async () => {
    useHosts([labHost({ name: 'core', host: '10.0.0.1', tags: ['core'] })]);
    render(<HostsManager />);
    fireEvent.click(exportButton());
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('No lab hosts', expect.stringContaining('Tag a host "lab"')));
    expect(tauriSave).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('saves the addresses and shows the Casper command, the list and one-word names', async () => {
    useHosts([
      labHost({ name: 'lab-sw, rack 4', host: '10.99.0.11', username: 'netadmin', password: 'pw-SECRET' }),
      labHost({ name: 'core lab', host: 'core1' }),
      labHost({ name: 'lab-console', protocol: 'serial', serialPort: '/dev/tty.usb' }),
    ]);
    vi.mocked(tauriSave).mockResolvedValue('/Users/me/My Files/casper-lab.json');
    render(<HostsManager />);
    fireEvent.click(exportButton());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(tauriSave).toHaveBeenCalledWith('casper-lab.json', 'Export lab hosts for Casper');
    expect(writes()[0]).toEqual({
      path: '/Users/me/My Files/casper-lab.json',
      contents: '{\n  "hosts": [\n    "10.99.0.11",\n    "core1"\n  ]\n}\n',
    });
    expect(writes()[0].contents).not.toMatch(/netadmin|SECRET|rack/);
    expect(notify.success).toHaveBeenCalledWith('Lab hosts exported', '2 hosts saved');
    const done = await screen.findByRole('status');
    expect(done.textContent).toContain('In Casper, type: /lab import "/Users/me/My Files/casper-lab.json"');
    expect(done.textContent).toContain('10.99.0.11');
    expect(done.textContent).toContain('core1 is a one-word name');
    expect(done.textContent).toContain('lab-console: serial, no network address');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('/lab import "/Users/me/My Files/casper-lab.json"'));
  });

  it("refuses a place inside another app's folder and writes nothing", async () => {
    useHosts([labHost({ host: '10.99.0.11' })]);
    vi.mocked(tauriSave).mockResolvedValue('/Users/me/.casper/casper-lab.json');
    render(<HostsManager />);
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        'Not saved',
        "GreenCLI does not write other apps' own settings files. Pick another place, for example your Documents folder."
      )
    );
    expect(writes()).toEqual([]);
  });

  it('does nothing when the save dialog is cancelled', async () => {
    useHosts([labHost({ host: '10.99.0.11' })]);
    vi.mocked(tauriSave).mockResolvedValue(null);
    render(<HostsManager />);
    fireEvent.click(exportButton());
    await waitFor(() => expect(tauriSave).toHaveBeenCalled());
    expect(writes()).toEqual([]);
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('shows the error when the write fails', async () => {
    useHosts([labHost({ host: '10.99.0.11' })]);
    vi.mocked(tauriSave).mockResolvedValue('/tmp/casper-lab.json');
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_known_hosts') return [];
      if (cmd === 'mcp_export_write') throw 'disk full';
      return undefined;
    });
    render(<HostsManager />);
    fireEvent.click(exportButton());
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not export lab hosts', 'disk full'));
    expect(notify.success).not.toHaveBeenCalled();
  });
});
