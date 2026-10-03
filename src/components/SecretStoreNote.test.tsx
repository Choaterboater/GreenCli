import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import SecretStoreNote from './SecretStoreNote';
import { leftoverLine, MOVE_PENDING_LINE, UNKNOWN_LINE, type SecretStoreStatus } from '../utils/secretStore';

const withStatus = (status: SecretStoreStatus) =>
  vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === 'secret_store_status' ? status : null));

const ok = (extra: Partial<SecretStoreStatus> = {}): SecretStoreStatus => ({
  kind: 'keychain',
  leftoverFiles: [],
  movePending: false,
  ...extra,
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe('SecretStoreNote', () => {
  it.each([
    ['keychain', 'Saved in macOS Keychain.'],
    ['credential-manager', 'Saved in Windows Credential Manager.'],
    ['secret-service', 'Saved in your system keyring.'],
    [
      'file',
      "Saved in a private file on this computer. The system password store couldn't be used when GreenCLI started; it tries again at each start.",
    ],
  ] as const)('shows where keys are kept: %s', async (kind, line) => {
    withStatus(ok({ kind }));
    render(<SecretStoreNote after="Sent only to the provider." />);
    await waitFor(() => expect(screen.getByTestId('secret-store-line').textContent).toBe(`${line} Sent only to the provider.`));
    expect(screen.queryByText(MOVE_PENDING_LINE)).toBeNull();
    expect(screen.queryByText(/old key file/)).toBeNull();
  });

  it('says when the store can not be reached', async () => {
    withStatus(ok({ kind: 'unavailable', reason: 'x' }));
    render(<SecretStoreNote />);
    await waitFor(() =>
      expect(screen.getByTestId('secret-store-line').textContent).toBe(
        "Can't reach the system password store. Keys saved on this computer are still there. Try again after you log in to the desktop."
      )
    );
  });

  it('names an old key file that was left in place', async () => {
    const path = '/Users/me/Library/Application Support/com.choatelabs.greencli/ai_keys.json';
    withStatus(ok({ leftoverFiles: [path] }));
    render(<SecretStoreNote />);
    expect(await screen.findByText(leftoverLine(path))).toBeTruthy();
    expect(screen.getByText(/may still hold keys/).textContent).toContain(path);
  });

  it('says when some keys from 1.9 did not move yet', async () => {
    withStatus(ok({ movePending: true }));
    render(<SecretStoreNote />);
    expect(await screen.findByText(MOVE_PENDING_LINE)).toBeTruthy();
  });

  it('falls back to a plain line when the status can not be read', async () => {
    withStatus(ok());
    const { rerender } = render(<SecretStoreNote refreshKey={1} />);
    await waitFor(() => expect(screen.getByTestId('secret-store-line').textContent).toBe('Saved in macOS Keychain.'));
    let rejected = false;
    vi.mocked(invoke).mockImplementation(async () => {
      rejected = true;
      throw new Error('no app');
    });
    rerender(<SecretStoreNote refreshKey={2} />);
    // Let the rejected call settle before checking.
    await act(async () => {});
    expect(rejected).toBe(true);
    expect(screen.getByTestId('secret-store-line').textContent).toBe(UNKNOWN_LINE);
  });
});
