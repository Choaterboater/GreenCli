import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';

export function useCredentialVault() {
  // Mirror the shared vault state so this hook can never desync from the real
  // vault (a stale local `false` would wrongly throw "Vault is locked").
  const isUnlocked = useSessionStore((s) => s.vaultUnlocked);
  const setVaultUnlocked = useSessionStore((s) => s.setVaultUnlocked);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = useCallback(async (password: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<boolean>('vault_unlock', { password });
      setVaultUnlocked(result);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setVaultUnlocked(false);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [setVaultUnlocked]);

  const lock = useCallback(async () => {
    setLoading(true);
    try {
      await invoke('vault_lock');
      setVaultUnlocked(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [setVaultUnlocked]);

  const store = useCallback(
    async (key: string, value: string) => {
      if (!isUnlocked) throw new Error('Vault is locked');
      setLoading(true);
      try {
        await invoke('vault_store', { key, value });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [isUnlocked]
  );

  const retrieve = useCallback(
    async (key: string): Promise<string | null> => {
      if (!isUnlocked) throw new Error('Vault is locked');
      try {
        return await invoke<string | null>('vault_retrieve', { key });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return null;
      }
    },
    [isUnlocked]
  );

  const remove = useCallback(
    async (key: string) => {
      if (!isUnlocked) throw new Error('Vault is locked');
      setLoading(true);
      try {
        await invoke('vault_delete', { key });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [isUnlocked]
  );

  return { isUnlocked, loading, error, unlock, lock, store, retrieve, remove };
}
