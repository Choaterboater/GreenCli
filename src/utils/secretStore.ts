// Where GreenCLI keeps AI keys and MCP logins (Rust: src-tauri/src/secret_store.rs).
// The keys themselves never come back to the webview: only whether one is saved.

import { invoke } from '@tauri-apps/api/core';
import { notify } from '../store/toastStore';

export type SecretStoreKind = 'keychain' | 'credential-manager' | 'secret-service' | 'file' | 'unavailable';

/** What `secret_store_status` returns. */
export interface SecretStoreStatus {
  kind: SecretStoreKind;
  reason?: string;
  /** An old key file couldn't be read and was left in place. */
  leftover: boolean;
}

export const UNAVAILABLE_LINE =
  "Can't reach the system password store. Your keys are still there. Try again after you log in to the desktop.";
export const LEFTOVER_LINE = "An old key file couldn't be read. It was left in place.";
/** When the status can't be read (outside the app). */
export const UNKNOWN_LINE = 'Saved on this computer, outside the browser.';

const LINES: Record<SecretStoreKind, string> = {
  keychain: 'Saved in macOS Keychain.',
  'credential-manager': 'Saved in Windows Credential Manager.',
  'secret-service': 'Saved in your system keyring.',
  file: 'Saved in a private file on this computer. No system password store was found.',
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
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Save an AI key (empty removes it). Returns true when saved; on an error a
 * toast says why and false is returned.
 */
export async function saveAiKey(provider: string, key: string): Promise<boolean> {
  try {
    await invoke('ai_set_key', { provider, key });
    return true;
  } catch (e) {
    notify.error(key ? 'API key not saved' : 'API key not removed', errorText(e));
    return false;
  }
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
