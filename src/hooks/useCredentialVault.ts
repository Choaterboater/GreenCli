import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/tauri';

export function useCredentialVault() {
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = useCallback(async (password: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<boolean>('vault_unlock', { password });
      setIsUnlocked(result);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setIsUnlocked(false);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const lock = useCallback(async () => {
    setLoading(true);
    try {
      await invoke('vault_lock');
      setIsUnlocked(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

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
