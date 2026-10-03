// Where GreenCLI keeps AI keys and MCP logins (Rust: src-tauri/src/secret_store.rs).
// The keys themselves never come back to the webview: only whether one is saved.

import { invoke } from '@tauri-apps/api/core';
import { notify } from '../store/toastStore';

export type SecretStoreKind = 'keychain' | 'credential-manager' | 'secret-service' | 'file' | 'unavailable';

/** What `secret_store_status` returns. */
export interface SecretStoreStatus {
  kind: SecretStoreKind;
  reason?: string;
  /** Old 1.9 key files that couldn't be read at start and are still there. They may still hold keys. */
  leftoverFiles: string[];
  /** Some keys in an old 1.9 file didn't move yet; the next start tries again. */
  movePending: boolean;
}

export const UNAVAILABLE_LINE =
  "Can't reach the system password store. Keys saved on this computer are still there. Try again after you log in to the desktop.";
/** For an old key file that couldn't be read: where it is, and what to do. */
export function leftoverLine(path: string): string {
  return `An old key file couldn't be read and may still hold keys: ${path}. Delete it after you re-enter your keys.`;
}
export const MOVE_PENDING_LINE = 'Some keys from 1.9 were not moved yet. GreenCLI will try again next start.';
/** When the status can't be read (outside the app). */
export const UNKNOWN_LINE = 'Saved on this computer, outside the browser.';

const LINES: Record<SecretStoreKind, string> = {
  keychain: 'Saved in macOS Keychain.',
  'credential-manager': 'Saved in Windows Credential Manager.',
  'secret-service': 'Saved in your system keyring.',
  file: "Saved in a private file on this computer. The system password store couldn't be used when GreenCLI started; it tries again at each start.",
  unavailable: UNAVAILABLE_LINE,
};

/** The one line that says where keys are kept. */
export function secretStoreLine(status: SecretStoreStatus | null): string {
  if (!status) return UNKNOWN_LINE;
  return LINES[status.kind] ?? UNKNOWN_LINE;
}

/** The status, or null when it can't be read (outside the app, or an error). */
export async function loadSecretStoreStatus(): Promise<SecretStoreStatus | null> {
  try {
    return (await invoke<SecretStoreStatus>('secret_store_status')) ?? null;
  } catch {
    return null;
  }
}

/** Plain text of a command error (Rust returns a string). */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The line for a has-key check that failed: the store couldn't be asked, so
 * whether a key is saved is unknown (not "no key").
 */
export function keyCheckError(e: unknown): string {
  return errorText(e).trim() || UNAVAILABLE_LINE;
}

/**
 * Sent on `window` after an AI key is saved or removed, with the provider as
 * `detail`. A check that ran while the save was still going (the AI panel's,
 * when Settings closes with a typed key) asks again then.
 */
export const AI_KEY_CHANGED_EVENT = 'greencli:ai-key-changed';

/**
 * Save an AI key (empty removes it). Returns true when saved; on an error a
 * toast says why and false is returned.
 */
export async function saveAiKey(provider: string, key: string): Promise<boolean> {
  try {
    await invoke('ai_set_key', { provider, key });
  } catch (e) {
    notify.error(key ? 'API key not saved' : 'API key not removed', errorText(e));
    return false;
  }
  window.dispatchEvent(new CustomEvent<string>(AI_KEY_CHANGED_EVENT, { detail: provider }));
  return true;
}

/** Save an MCP server's login. Same contract as saveAiKey. */
export async function saveMcpLogin(name: string, content: string): Promise<boolean> {
  try {
    await invoke('mcp_set_credentials', { name, content });
    return true;
  } catch (e) {
    notify.error(`${name} login not saved`, errorText(e));
    return false;
  }
}
