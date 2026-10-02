import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { useToastStore } from '../store/toastStore';
import {
  keyCheckError,
  leftoverLine,
  loadSecretStoreStatus,
  saveAiKey,
  saveMcpLogin,
  secretStoreLine,
  UNAVAILABLE_LINE,
  UNKNOWN_LINE,
  type SecretStoreKind,
} from './secretStore';

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useToastStore.getState().clear();
});

describe('secretStoreLine', () => {
  const cases: [SecretStoreKind, string][] = [
    ['keychain', 'Saved in macOS Keychain.'],
    ['credential-manager', 'Saved in Windows Credential Manager.'],
    ['secret-service', 'Saved in your system keyring.'],
    ['file', 'Saved in a private file on this computer. No system password store was found.'],
    [
      'unavailable',
      "Can't reach the system password store. Your keys are still there. Try again after you log in to the desktop.",
    ],
  ];
  it.each(cases)('%s', (kind, line) => {
    expect(secretStoreLine({ kind, leftoverFiles: [], movePending: false })).toBe(line);
  });

  it('has a plain line when the status is unknown', () => {
    expect(secretStoreLine(null)).toBe(UNKNOWN_LINE);
  });

  it('matches the Rust text for an unreachable store', () => {
    expect(UNAVAILABLE_LINE).toBe(secretStoreLine({ kind: 'unavailable', leftoverFiles: [], movePending: false }));
  });
});

describe('leftoverLine', () => {
  it('names the file and says it may still hold keys', () => {
    expect(leftoverLine('/Users/me/Library/Application Support/com.choatelabs.greencli/ai_keys.json')).toBe(
      "An old key file couldn't be read and may still hold keys: /Users/me/Library/Application Support/com.choatelabs.greencli/ai_keys.json. Delete it after you re-enter your keys."
    );
  });
});

describe('keyCheckError', () => {
  it('uses the error from Rust, or the unreachable line when there is none', () => {
    expect(keyCheckError(UNAVAILABLE_LINE)).toBe(UNAVAILABLE_LINE);
    expect(keyCheckError(new Error('locked'))).toBe('locked');
    expect(keyCheckError('')).toBe(UNAVAILABLE_LINE);
  });
});

describe('loadSecretStoreStatus', () => {
  it('returns the status', async () => {
    vi.mocked(invoke).mockResolvedValue({ kind: 'keychain', leftoverFiles: ['/x/ai_keys.json'], movePending: true });
    await expect(loadSecretStoreStatus()).resolves.toEqual({ kind: 'keychain', leftoverFiles: ['/x/ai_keys.json'], movePending: true });
    expect(invoke).toHaveBeenCalledWith('secret_store_status');
  });

  it('is null outside the app', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('__TAURI_INTERNALS__ unavailable'));
    await expect(loadSecretStoreStatus()).resolves.toBeNull();
  });
});

describe('saving keys', () => {
  it('saves an AI key without a toast', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await expect(saveAiKey('anthropic', 'sk-ant-x')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('ai_set_key', { provider: 'anthropic', key: 'sk-ant-x' });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('shows a toast when an AI key is not saved', async () => {
    vi.mocked(invoke).mockRejectedValue(UNAVAILABLE_LINE);
    await expect(saveAiKey('anthropic', 'sk-ant-x')).resolves.toBe(false);
    const [toast] = useToastStore.getState().toasts;
    expect(toast.kind).toBe('error');
    expect(toast.title).toBe('API key not saved');
    expect(toast.message).toBe(UNAVAILABLE_LINE);
  });

  it('says remove when clearing a key fails', async () => {
    vi.mocked(invoke).mockRejectedValue('locked');
    await expect(saveAiKey('anthropic', '')).resolves.toBe(false);
    expect(useToastStore.getState().toasts[0].title).toBe('API key not removed');
  });

  it('shows a toast when an MCP login is not saved', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('disk full'));
    await expect(saveMcpLogin('central', 'client_id: x')).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith('mcp_set_credentials', { name: 'central', content: 'client_id: x' });
    const [toast] = useToastStore.getState().toasts;
    expect(toast.title).toBe('central login not saved');
    expect(toast.message).toBe('disk full');
  });
});
