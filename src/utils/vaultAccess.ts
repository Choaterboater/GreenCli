// The frontend's one route to the credential vault for connect-time secrets
// (device, shared-login and jump-host passwords).

import { invoke } from '@tauri-apps/api/core';
import { VaultCredentialSource } from './connect';

/** Live backend vault state for the connect resolvers — the cheap atomic
 *  status commands, so a resolve right after an unlock sees it. */
export const backendVault: VaultCredentialSource = {
  isUnlocked: () => invoke<boolean>('vault_is_unlocked').catch(() => false),
  isInitialized: () => invoke<boolean>('vault_is_initialized').catch(() => false),
  retrieve: (key) => invoke<string | null>('vault_retrieve', { key }).catch(() => null),
};

// Writes waiting for the user to unlock the vault, by key (null = delete).
// Memory only — never localStorage — and a Map, not one slot: saving a shared
// login's new password and a host's password before unlocking must not drop
// the first. App flushes them right after an unlock.
const deferred = new Map<string, string | null>();

/**
 * Store (or, with null, delete) a vault entry now if the vault is unlocked,
 * otherwise hold it until the next unlock. Returns 'deferred' so the caller
 * can open the unlock prompt.
 */
export async function saveToVault(key: string, value: string | null): Promise<'saved' | 'deferred'> {
  if (await backendVault.isUnlocked()) {
    try {
      if (value === null) await invoke('vault_delete', { key });
      else await invoke('vault_store', { key, value });
      deferred.delete(key);
      return 'saved';
    } catch (err) {
      // Locked in between, or a storage error: keep it for the next unlock.
      console.error(`[vault] write failed for ${key}:`, err);
    }
  }
  deferred.set(key, value);
  return 'deferred';
}

/** How many vault writes are waiting for an unlock. */
export function deferredVaultWrites(): number {
  return deferred.size;
}

/** Write everything that was waiting for the vault. Call after an unlock. */
export async function flushDeferredVaultWrites(): Promise<void> {
  const pending = [...deferred.entries()];
  deferred.clear();
  for (const [key, value] of pending) {
    try {
      if (value === null) await invoke('vault_delete', { key });
      else await invoke('vault_store', { key, value });
    } catch (err) {
      console.error(`[vault] deferred write failed for ${key}:`, err);
      // A newer save for the same key may have been queued meanwhile — keep it.
      if (!deferred.has(key)) deferred.set(key, value);
    }
  }
}
