import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import HostsManager from './HostsManager';
import { notify } from '../store/toastStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../store/toastStore', () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

function backend(forgetError?: string) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'list_known_hosts') return [{ hostPort: 'r1:22', fingerprint: 'SHA256:aaa' }];
    if (cmd === 'remove_known_host') {
      if (forgetError) throw forgetError;
      return undefined;
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

  it('shows the error, and no success, when the save failed', async () => {
    const err = "Couldn't forget r1:22: the host keys file couldn't be saved.";
    backend(err);
    render(<HostsManager />);
    fireEvent.click(await screen.findByTitle('Forget (re-trust on next connect)'));
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith("Couldn't forget host key", err));
    expect(notify.info).not.toHaveBeenCalled();
  });
});
