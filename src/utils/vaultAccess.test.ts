import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/tauri', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/tauri';
import { flushDeferredVaultWrites, saveToVault } from './vaultAccess';

/** A backend vault: `unlocked` flag + stored entries; records every command. */
function mockBackend() {
  const state = { unlocked: false, entries: new Map<string, string>(), calls: [] as string[] };
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const { key, value } = (args ?? {}) as { key?: string; value?: string };
    state.calls.push(cmd);
    switch (cmd) {
      case 'vault_is_unlocked':
        return state.unlocked;
      case 'vault_store':
        if (!state.unlocked) throw new Error('Vault Error: locked');
        state.entries.set(key!, value!);
        return undefined;
      case 'vault_delete':
        if (!state.unlocked) throw new Error('Vault Error: locked');
        state.entries.delete(key!);
        return undefined;
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
  return state;
}

describe('saveToVault', () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockReset();
    // Drain anything a previous test left queued.
    mockBackend().unlocked = true;
    await flushDeferredVaultWrites();
  });

  it('writes straight away when the vault is unlocked', async () => {
    const backend = mockBackend();
    backend.unlocked = true;
    expect(await saveToVault('login:a', 'pw')).toBe('saved');
    expect(backend.entries.get('login:a')).toBe('pw');
  });

  it('holds several writes while locked and lands them all on unlock', async () => {
    const backend = mockBackend();
    backend.entries.set('login:gone', 'old');
    expect(await saveToVault('login:a', 'first')).toBe('deferred');
    expect(await saveToVault('cred:h:22:u', 'host-pw')).toBe('deferred');
    // A newer save for the same key replaces the queued one.
    expect(await saveToVault('login:a', 'second')).toBe('deferred');
    expect(await saveToVault('login:gone', null)).toBe('deferred');
    expect(backend.calls).not.toContain('vault_store');

    backend.unlocked = true;
    await flushDeferredVaultWrites();
    expect(Object.fromEntries(backend.entries)).toEqual({
      'login:a': 'second',
      'cred:h:22:u': 'host-pw',
    });

    // Flushed once: a second flush writes nothing.
    backend.calls.length = 0;
    await flushDeferredVaultWrites();
    expect(backend.calls).toEqual([]);
  });

  it('keeps a write that fails during the flush for the next unlock', async () => {
    const backend = mockBackend();
    await saveToVault('login:a', 'pw');
    // Unlock reported, but the vault locks again before the write lands.
    await flushDeferredVaultWrites();
    expect(backend.entries.size).toBe(0);
    backend.unlocked = true;
    await flushDeferredVaultWrites();
    expect(backend.entries.get('login:a')).toBe('pw');
  });
});
