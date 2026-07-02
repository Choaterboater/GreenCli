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
const K_CLIENT_SECRET_IDENTITY = 'set:central:clientSecret:identity';
const K_TOKEN = 'set:central:token';
const K_TOKEN_IDENTITY = 'set:central:token:identity';
const K_APSTRA = 'set:apstra:password';
const K_APSTRA_IDENTITY = 'set:apstra:password:identity';
const K_MIST = 'set:mist:token';
const K_MIST_IDENTITY = 'set:mist:token:identity';
const acctSecretKey = (id: string) => `set:central-acct:${id}:clientSecret`;
const acctTokenKey = (id: string) => `set:central-acct:${id}:token`;
const acctSecretIdentityKey = (id: string) => `set:central-acct:${id}:clientSecret:identity`;
const acctTokenIdentityKey = (id: string) => `set:central-acct:${id}:token:identity`;
const K_INVALIDATED_IDENTITIES = 'greencli-invalidated-secret-identities-v1';

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
export async function deleteAccountSecrets(id: string): Promise<void> {
  await Promise.all([
    put(acctSecretKey(id), ''),
    put(acctSecretIdentityKey(id), ''),
    put(acctTokenKey(id), ''),
    put(acctTokenIdentityKey(id), ''),
  ]);
}

/** Write the current Central/Apstra secrets (and each saved account's secrets) to the vault. */
export async function persistSecrets(s: TerminalSettings): Promise<void> {
  await put(K_CLIENT_SECRET, s.centralClientSecret || '');
  await put(
    K_CLIENT_SECRET_IDENTITY,
    s.centralClientSecret
      ? identity({ baseUrl: s.centralBaseUrl, clientId: s.centralClientId, mode: 'creds' })
      : ''
  );
  await put(K_TOKEN, s.centralToken || '');
  await put(
    K_TOKEN_IDENTITY,
    s.centralToken ? identity({ baseUrl: s.centralBaseUrl, mode: 'token' }) : ''
  );
  await put(K_APSTRA, s.apstraPassword || '');
  await put(
    K_APSTRA_IDENTITY,
    s.apstraPassword ? identity({ host: s.apstraHost, username: s.apstraUsername }) : ''
  );
  await put(K_MIST, s.mistToken || '');
  await put(K_MIST_IDENTITY, s.mistToken ? identity({ baseUrl: s.mistBaseUrl }) : '');
  for (const a of s.centralAccounts || []) {
    await put(acctSecretKey(a.id), a.clientSecret || '');
    await put(
      acctSecretIdentityKey(a.id),
      a.clientSecret
        ? identity({ baseUrl: a.baseUrl, clientId: a.clientId })
        : ''
    );
    await put(acctTokenKey(a.id), a.token || '');
    await put(
      acctTokenIdentityKey(a.id),
      a.token ? identity({ baseUrl: a.baseUrl }) : ''
    );
  }
  clearSecretIdentitiesInvalidated([
    ...(s.centralClientSecret ? ['centralClientSecret'] : []),
    ...(s.centralToken ? ['centralToken'] : []),
    ...(s.apstraPassword ? ['apstraPassword'] : []),
    ...(s.mistToken ? ['mistToken'] : []),
    ...(s.centralAccounts || []).flatMap((account) => [
      ...(account.clientSecret ? [`centralAccountSecret:${account.id}`] : []),
      ...(account.token ? [`centralAccountToken:${account.id}`] : []),
    ]),
  ]);
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
    vApstra,
    vApstraIdentity,
    vMist,
    vMistIdentity,
  ] = await Promise.all([
    get(K_CLIENT_SECRET),
    get(K_CLIENT_SECRET_IDENTITY),
    get(K_TOKEN),
    get(K_TOKEN_IDENTITY),
    get(K_APSTRA),
    get(K_APSTRA_IDENTITY),
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
    apstraPassword: vaultSecretForIdentity(
      vApstra,
      vApstraIdentity,
      { host: s.apstraHost, username: s.apstraUsername },
      'apstraPassword',
    )
      || s.apstraPassword,
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
