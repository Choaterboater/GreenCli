// Single builder for the `connect` Tauri command payload. Both the direct
// connect path and the auth-dialog retry path in App.tsx go through this so the
// retry can't silently drop fields the backend accepts (the auth path used to
// omit data_bits/parity/stop_bits/command/args/cwd).

import { ConnectionConfig } from '../types';

/** Credentials gathered at connect time (inline config, vault, or auth dialog). */
export interface ConnectCredentials {
  password?: string;
  privateKey?: string;
  keyPassphrase?: string;
  /** Overrides config.authType when set (the auth dialog lets the user pick). */
  authType?: 'password' | 'key' | 'agent';
}

/** Live connection-behavior settings read from the settings store. */
export interface ConnectBehavior {
  keepAliveInterval: number;
  autoReconnect: boolean;
}

export interface VaultCredentialSource {
  isUnlocked: () => Promise<boolean>;
  isInitialized: () => Promise<boolean>;
  retrieve: (key: string) => Promise<string | null>;
}

/** How a connect attempt ended — for callers that connect on the user's
 *  behalf (Change Jobs) and must not stop to ask for a password or a vault
 *  unlock: those come back as 'needs-login' instead of opening a dialog. */
export type ConnectOutcome =
  /** `sessionId`: the tab the connect used — a saved host's tab need not
   *  share the saved host's id, so callers must not assume it does. */
  | { status: 'connected'; sessionId: string }
  /** Already connecting (or reconnecting): wait for the session to come up. */
  | { status: 'in-progress'; sessionId: string }
  | { status: 'needs-login'; reason: string }
  | { status: 'failed'; reason: string };

export interface SshPasswordResolution {
  password?: string;
  requiresVaultUnlock: boolean;
}

export function sshCredentialKey(
  config: Pick<ConnectionConfig, 'host' | 'port' | 'username'>,
): string {
  return `cred:${config.host ?? ''}:${config.port ?? 22}:${config.username ?? ''}`;
}

/** True when a failed `connect` was rejected on CREDENTIALS (so asking for a
 *  password / key again can help), as opposed to the host being unreachable,
 *  a host-key mismatch, a timeout, a refused PTY, … where the password dialog
 *  only hides the real error. Matches the backend's AppError strings. */
export function isAuthFailure(error: string): boolean {
  return /Auth Error:|Auth failed|Keyboard-interactive|Key decode|Key UTF-8|private key|passphrase/i.test(
    error
  );
}

/** True when an SSH connect would log in with a password that nobody has
 *  supplied (not inline, not in the vault). Sending that login anyway is a
 *  guaranteed failed attempt on the device — it counts toward TACACS/RADIUS
 *  lockout — so the caller should ask for the password first instead. */
export function needsPasswordPrompt(
  config: Pick<ConnectionConfig, 'protocol' | 'authType'>,
  password: string | undefined,
): boolean {
  return config.protocol === 'ssh' && (config.authType ?? 'password') === 'password' && !password;
}

/** Resolve password auth from the live backend vault state, not React's cached
 *  startup state. This matters immediately after vault_unlock: the backend is
 *  unlocked before React has rendered the updated store value. */
export async function resolveSshPassword(
  config: Pick<
    ConnectionConfig,
    'protocol' | 'authType' | 'password' | 'host' | 'port' | 'username'
  >,
  vault: VaultCredentialSource,
): Promise<SshPasswordResolution> {
  const usesPassword =
    config.protocol === 'ssh' && (config.authType ?? 'password') === 'password';
  if (config.password || !usesPassword) {
    return { password: config.password, requiresVaultUnlock: false };
  }

  if (await vault.isUnlocked()) {
    const password = (await vault.retrieve(sshCredentialKey(config))) ?? undefined;
    return { password, requiresVaultUnlock: false };
  }

  return {
    password: undefined,
    requiresVaultUnlock: await vault.isInitialized(),
  };
}

/**
 * Map a ConnectionConfig + credentials + behavior settings onto the exact
 * `config` object the `connect` Tauri command accepts. Keep this the superset
 * of every field the backend reads — add new fields here, not at call sites.
 */
export function buildConnectPayload(
  config: ConnectionConfig,
  creds: ConnectCredentials,
  behavior: ConnectBehavior,
) {
  return {
    // The backend keys the session by this: it is the TAB's id, so two tabs
    // of one saved host are two sessions (config.savedId stays front-end).
    id: config.id,
    name: config.name,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    // Wire name per the B17 contract: ConnectionConfigRequest.key_path ↔
    // JSON `keyPath`. Backend reads the identity file at connect when
    // private_key is absent and keyPath is set.
    auth_type: creds.authType ?? config.authType ?? 'password',
    keyPath: config.keyPath,
    password: creds.password,
    private_key: creds.privateKey ?? config.privateKey,
    key_passphrase: creds.keyPassphrase ?? config.keyPassphrase,
    serial_port: config.serialPort,
    baud_rate: config.baudRate,
    data_bits: config.dataBits,
    parity: config.parity,
    stop_bits: config.stopBits,
    device_type: config.deviceType,
    device_profile_id: config.deviceProfileId,
    keep_alive_interval: behavior.keepAliveInterval,
    auto_reconnect: behavior.autoReconnect,
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    jump_host: config.jumpHost,
    jump_port: config.jumpPort,
    jump_username: config.jumpUsername,
    jump_password: config.jumpPassword,
  };
}
