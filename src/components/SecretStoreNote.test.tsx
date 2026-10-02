import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import SecretStoreNote from './SecretStoreNote';
import { LEFTOVER_LINE, UNKNOWN_LINE, type SecretStoreStatus } from '../utils/secretStore';

const withStatus = (status: SecretStoreStatus) =>
  vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === 'secret_store_status' ? status : null));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe('SecretStoreNote', () => {
  it.each([
    ['keychain', 'Saved in macOS Keychain.'],
    ['credential-manager', 'Saved in Windows Credential Manager.'],
    ['secret-service', 'Saved in your system keyring.'],
    ['file', 'Saved in a private file on this computer. No system password store was found.'],
  ] as const)('shows where keys are kept: %s', async (kind, line) => {
    withStatus({ kind, leftover: false });
    render(<SecretStoreNote after="Sent only to the provider." />);
    await waitFor(() => expect(screen.getByTestId('secret-store-line').textContent).toBe(`${line} Sent only to the provider.`));
    expect(screen.queryByText(LEFTOVER_LINE)).toBeNull();
  });

  it('says when the store can not be reached', async () => {
    withStatus({ kind: 'unavailable', reason: 'x', leftover: false });
    render(<SecretStoreNote />);
    await waitFor(() =>
      expect(screen.getByTestId('secret-store-line').textContent).toBe(
        "Can't reach the system password store. Your keys are still there. Try again after you log in to the desktop."
      )
    );
  });

  it('says an old key file was left in place', async () => {
    withStatus({ kind: 'keychain', leftover: true });
    render(<SecretStoreNote />);
    expect(await screen.findByText(LEFTOVER_LINE)).toBeTruthy();
  });

  it('has a plain line when the status can not be read', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('no app'));
    render(<SecretStoreNote />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.getByTestId('secret-store-line').textContent).toBe(UNKNOWN_LINE);
  });
});
