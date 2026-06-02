// Vault-backed persistence for Central / Apstra secrets.
//
// These secrets are intentionally kept OUT of localStorage (see settingsStore
// partialize). To survive a restart they're stored — encrypted, owner-only — in
// the same Rust credential vault as SSH passwords. That requires the vault to be
// unlocked; while locked, secrets live only in memory for the session (and writes
// no-op via the catch below), exactly like saved SSH passwords.

import { invoke } from '@tauri-apps/api/tauri';
import { TerminalSettings, CentralAccount } from '../types';

const K_CLIENT_SECRET = 'set:central:clientSecret';
const K_TOKEN = 'set:central:token';
const K_APSTRA = 'set:apstra:password';
const K_MIST = 'set:mist:token';
const acctSecretKey = (id: string) => `set:central-acct:${id}:clientSecret`;
const acctTokenKey = (id: string) => `set:central-acct:${id}:token`;

async function put(key: string, value: string): Promise<void> {
  try {
    if (value) await invoke('vault_store', { key, value });
    else await invoke('vault_delete', { key });
  } catch {
    /* vault locked / unavailable — secret stays in-memory only */
  }
}

async function get(key: string): Promise<string> {
  try {
    return (await invoke<string | null>('vault_retrieve', { key })) ?? '';
  } catch {
    return '';
  }
}

/** Write the current Central/Apstra secrets (and each saved account's secrets) to the vault. */
export async function persistSecrets(s: TerminalSettings): Promise<void> {
  await put(K_CLIENT_SECRET, s.centralClientSecret || '');
  await put(K_TOKEN, s.centralToken || '');
  await put(K_APSTRA, s.apstraPassword || '');
  await put(K_MIST, s.mistToken || '');
  for (const a of s.centralAccounts || []) {
    await put(acctSecretKey(a.id), a.clientSecret || '');
    await put(acctTokenKey(a.id), a.token || '');
  }
}

/** Read secrets back from the vault, returning a patch to merge into settings. The
 *  account list (ids/names/urls) comes from localStorage; we only refill secrets.
 *  A vault value wins only when present, so a secret typed BEFORE unlock isn't
 *  clobbered by an empty vault entry (it gets persisted right after, by the caller). */
export async function loadSecrets(s: TerminalSettings): Promise<Partial<TerminalSettings>> {
  const [vSecret, vToken, vApstra, vMist] = await Promise.all([
    get(K_CLIENT_SECRET),
    get(K_TOKEN),
    get(K_APSTRA),
    get(K_MIST),
  ]);
  const centralAccounts: CentralAccount[] = await Promise.all(
    (s.centralAccounts || []).map(async (a) => ({
      ...a,
      clientSecret: (await get(acctSecretKey(a.id))) || a.clientSecret,
      token: (await get(acctTokenKey(a.id))) || a.token,
    }))
  );
  return {
    centralClientSecret: vSecret || s.centralClientSecret,
    centralToken: vToken || s.centralToken,
    apstraPassword: vApstra || s.apstraPassword,
    mistToken: vMist || s.mistToken,
    centralAccounts,
  };
}
