// Vault-backed persistence for Central / Mist secrets.
//
// These secrets are intentionally kept OUT of localStorage (see settingsStore
// partialize). To survive a restart they're stored — encrypted, owner-only — in
// the same Rust credential vault as SSH passwords. That requires the vault to be
// unlocked; while locked, secrets live only in memory for the session (and writes
// no-op via the catch below), exactly like saved SSH passwords.

import { invoke } from '@tauri-apps/api/tauri';
import { TerminalSettings, CentralAccount } from '../types';

const K_CLIENT_SECRET = 'set:central:clientSecret';
const K_CLIENT_SECRET_IDENTITY = 'set:central:clientSecret:identity';
const K_TOKEN = 'set:central:token';
const K_TOKEN_IDENTITY = 'set:central:token:identity';
const K_MIST = 'set:mist:token';
const K_MIST_IDENTITY = 'set:mist:token:identity';
const acctSecretKey = (id: string) => `set:central-acct:${id}:clientSecret`;
const acctTokenKey = (id: string) => `set:central-acct:${id}:token`;
const acctSecretIdentityKey = (id: string) => `set:central-acct:${id}:clientSecret:identity`;
const acctTokenIdentityKey = (id: string) => `set:central-acct:${id}:token:identity`;
const K_INVALIDATED_IDENTITIES = 'greencli-invalidated-secret-identities-v1';

/** Store (or, for an empty value, delete) a vault entry.
 *  Returns false when the write failed — including the everyday "vault locked"
 *  case, which callers treat as expected — and logs the underlying error so
 *  real storage failures (disk full, permissions, corruption) are no longer
 *  indistinguishable from a locked vault. */
async function put(key: string, value: string): Promise<boolean> {
  try {
    if (value) await invoke('vault_store', { key, value });
    else await invoke('vault_delete', { key });
    return true;
  } catch (err) {
    console.error(`[secretVault] vault write failed for ${key} (locked or storage error):`, err);
    return false;
  }
}

async function get(key: string): Promise<string> {
  try {
    return (await invoke<string | null>('vault_retrieve', { key })) ?? '';
  } catch (err) {
    console.error(`[secretVault] vault read failed for ${key} (locked or storage error):`, err);
    return '';
  }
}

function identity(value: Record<string, string>): string {
  return JSON.stringify(value);
}

function identityMatches(stored: string, expected: Record<string, string>): boolean {
  if (!stored) return false;
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    return Object.entries(expected).every(([key, value]) => parsed[key] === value);
  } catch {
    return false;
  }
}

function invalidatedIdentities(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(K_INVALIDATED_IDENTITIES) || '[]'));
  } catch {
    return new Set();
  }
}

export function markSecretIdentitiesInvalidated(keys: string[]): void {
  if (!keys.length) return;
  const set = invalidatedIdentities();
  keys.forEach((key) => set.add(key));
  localStorage.setItem(K_INVALIDATED_IDENTITIES, JSON.stringify([...set]));
}

function clearSecretIdentitiesInvalidated(keys: string[]): void {
  if (!keys.length) return;
  const set = invalidatedIdentities();
  keys.forEach((key) => set.delete(key));
  localStorage.setItem(K_INVALIDATED_IDENTITIES, JSON.stringify([...set]));
}

function vaultSecretForIdentity(
  value: string,
  storedIdentity: string,
  expectedIdentity: Record<string, string>,
  invalidationKey: string,
): string {
  if (!value) return '';
  if (identityMatches(storedIdentity, expectedIdentity)) return value;
  if (!storedIdentity && !invalidatedIdentities().has(invalidationKey)) {
    return value;
  }
  return '';
}

/** Delete a removed Central account's vault-held secrets — persistSecrets only
 *  ever writes entries for accounts currently in settings, so a removed
 *  account's `set:central-acct:<id>:*` entries otherwise linger in the vault
 *  forever. */
export async function deleteAccountSecrets(id: string): Promise<boolean> {
  const results = await Promise.all([
    put(acctSecretKey(id), ''),
    put(acctSecretIdentityKey(id), ''),
    put(acctTokenKey(id), ''),
    put(acctTokenIdentityKey(id), ''),
  ]);
  return results.every(Boolean);
}

/** Write the current Central/Mist secrets (and each saved account's secrets) to the vault.
 *  Returns false if any entry failed to persist (e.g. vault locked or a storage
 *  error) so callers can warn instead of assuming the secrets survived. */
export async function persistSecrets(s: TerminalSettings): Promise<boolean> {
  let ok = true;
  const track = async (key: string, value: string) => {
    if (!(await put(key, value))) ok = false;
  };
  await track(K_CLIENT_SECRET, s.centralClientSecret || '');
  await track(
    K_CLIENT_SECRET_IDENTITY,
    s.centralClientSecret
      ? identity({ baseUrl: s.centralBaseUrl, clientId: s.centralClientId, mode: 'creds' })
      : ''
  );
  await track(K_TOKEN, s.centralToken || '');
  await track(
    K_TOKEN_IDENTITY,
    s.centralToken ? identity({ baseUrl: s.centralBaseUrl, mode: 'token' }) : ''
  );
  await track(K_MIST, s.mistToken || '');
  await track(K_MIST_IDENTITY, s.mistToken ? identity({ baseUrl: s.mistBaseUrl }) : '');
  for (const a of s.centralAccounts || []) {
    await track(acctSecretKey(a.id), a.clientSecret || '');
    await track(
      acctSecretIdentityKey(a.id),
      a.clientSecret
        ? identity({ baseUrl: a.baseUrl, clientId: a.clientId })
        : ''
    );
    await track(acctTokenKey(a.id), a.token || '');
    await track(
      acctTokenIdentityKey(a.id),
      a.token ? identity({ baseUrl: a.baseUrl }) : ''
    );
  }
  if (ok) {
    clearSecretIdentitiesInvalidated([
      ...(s.centralClientSecret ? ['centralClientSecret'] : []),
      ...(s.centralToken ? ['centralToken'] : []),
      ...(s.mistToken ? ['mistToken'] : []),
      ...(s.centralAccounts || []).flatMap((account) => [
        ...(account.clientSecret ? [`centralAccountSecret:${account.id}`] : []),
        ...(account.token ? [`centralAccountToken:${account.id}`] : []),
      ]),
    ]);
  }
  return ok;
}

/** Read secrets back from the vault, returning a patch to merge into settings. The
 *  account list (ids/names/urls) comes from localStorage; we only refill secrets.
 *  A vault value wins only when present, so a secret typed BEFORE unlock isn't
 *  clobbered by an empty vault entry (it gets persisted right after, by the caller). */
export async function loadSecrets(s: TerminalSettings): Promise<Partial<TerminalSettings>> {
  const [
    vSecret,
    vSecretIdentity,
    vToken,
    vTokenIdentity,
    vMist,
    vMistIdentity,
  ] = await Promise.all([
    get(K_CLIENT_SECRET),
    get(K_CLIENT_SECRET_IDENTITY),
    get(K_TOKEN),
    get(K_TOKEN_IDENTITY),
    get(K_MIST),
    get(K_MIST_IDENTITY),
  ]);
  const centralAccounts: CentralAccount[] = await Promise.all(
    (s.centralAccounts || []).map(async (a) => {
      const [secret, secretIdentity, token, tokenIdentity] = await Promise.all([
        get(acctSecretKey(a.id)),
        get(acctSecretIdentityKey(a.id)),
        get(acctTokenKey(a.id)),
        get(acctTokenIdentityKey(a.id)),
      ]);
      return {
        ...a,
        clientSecret:
          vaultSecretForIdentity(
            secret,
            secretIdentity,
            { baseUrl: a.baseUrl, clientId: a.clientId },
            `centralAccountSecret:${a.id}`,
          )
            || a.clientSecret,
        token:
          vaultSecretForIdentity(
            token,
            tokenIdentity,
            { baseUrl: a.baseUrl },
            `centralAccountToken:${a.id}`,
          )
            || a.token,
      };
    })
  );
  return {
    centralClientSecret: vaultSecretForIdentity(
      vSecret,
      vSecretIdentity,
      { baseUrl: s.centralBaseUrl, clientId: s.centralClientId, mode: 'creds' },
      'centralClientSecret',
    )
      || s.centralClientSecret,
    centralToken: vaultSecretForIdentity(
      vToken,
      vTokenIdentity,
      { baseUrl: s.centralBaseUrl, mode: 'token' },
      'centralToken',
    )
      || s.centralToken,
    mistToken: vaultSecretForIdentity(
      vMist,
      vMistIdentity,
      { baseUrl: s.mistBaseUrl },
      'mistToken',
    )
      || s.mistToken,
    centralAccounts,
  };
}
