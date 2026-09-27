// Single builder for the `connect` Tauri command payload. Both the direct
// connect path and the auth-dialog retry path in App.tsx go through this so the
// retry can't silently drop fields the backend accepts (the auth path used to
// omit data_bits/parity/stop_bits/command/args/cwd).

import { ConnectionConfig, LoginProfile } from '../types';
import { effectiveLogin, loginSecretKey, PER_HOST_PASSWORD, usesPasswordLogin } from './logins';

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

export function sshCredentialKey(
  config: Pick<ConnectionConfig, 'host' | 'port' | 'username'>,
): string {
  return `cred:${config.host ?? ''}:${config.port ?? 22}:${config.username ?? ''}`;
}

/** Vault key for a jump host's own saved password (jumpLoginProfileId =
 *  PER_HOST_PASSWORD). Built only from the saved host's fields — never from a
 *  shared login's username — so Quick Connect's save and the connect-time
 *  lookup always agree; an empty jump user falls back to the device user,
 *  as the backend does. */
export function jumpCredentialKey(
  config: Pick<ConnectionConfig, 'jumpHost' | 'jumpPort' | 'jumpUsername' | 'username'>,
): string {
  return sshCredentialKey({
    host: config.jumpHost,
    port: config.jumpPort ?? 22,
    username: config.jumpUsername?.trim() || config.username?.trim() || '',
  });
}

/** True when a failed `connect` was rejected on CREDENTIALS (so asking for a
 *  password / key again can help), as opposed to the host being unreachable,
 *  a host-key mismatch, a timeout, a refused PTY, … where the password dialog
 *  only hides the real error. Matches the backend's AppError strings. */
export function isAuthFailure(error: string): boolean {
  // A bastion refusing its login is not the device refusing the password —
  // the device password dialog can't fix it (and the bastion error says why).
  if (/jump host/i.test(error)) return false;
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

/** The shared logins in play for one connect: every login, plus the default
 *  of the folder the host is saved in (none for an unsaved Quick Connect). */
export interface LoginContext {
  profiles: LoginProfile[];
  folderLoginProfileId?: string;
}

export interface SshLoginResolution {
  /** Password to send; undefined = nobody has supplied one (ask first). */
  password?: string;
  /** Who to log in as: the host's own username, else the shared login's. */
  username?: string;
  /** The shared login this host uses, if any — even when its password is
   *  missing, so the password dialog can offer to save it there. */
  login?: LoginProfile;
  /** Where `password` came from. 'login' = the shared login's saved password
   *  (so a rejection means that login is wrong, for every host using it). */
  source?: 'inline' | 'login' | 'host';
  requiresVaultUnlock: boolean;
}

/**
 * Work out the SSH login for a host, in order: a password already on the
 * config (typed in Quick Connect) → the host's shared login → its folder's
 * default login → the per-host password saved in the vault → nothing (the
 * caller asks). Once a shared login applies, only ITS password is tried —
 * never another login's, which would go out under the wrong username and
 * count toward a TACACS lockout.
 *
 * Reads the live backend vault state, not React's cached flag: right after
 * vault_unlock the backend is unlocked before React re-renders.
 */
export async function resolveSshLogin(
  config: Pick<
    ConnectionConfig,
    'protocol' | 'authType' | 'password' | 'host' | 'port' | 'username' | 'loginProfileId'
  >,
  logins: LoginContext,
  vault: VaultCredentialSource,
): Promise<SshLoginResolution> {
  if (!usesPasswordLogin(config)) {
    return { password: config.password, username: config.username, requiresVaultUnlock: false };
  }
  const login = effectiveLogin(config, logins.folderLoginProfileId, logins.profiles)?.profile;
  const username = config.username?.trim() ? config.username : login?.username || config.username;

  if (config.password) {
    return { password: config.password, username, login, source: 'inline', requiresVaultUnlock: false };
  }
  if (!(await vault.isUnlocked())) {
    return { username, login, requiresVaultUnlock: await vault.isInitialized() };
  }
  if (login) {
    const shared = await vault.retrieve(loginSecretKey(login.id));
    if (shared) return { password: shared, username, login, source: 'login', requiresVaultUnlock: false };
  }
  const own = await vault.retrieve(sshCredentialKey({ ...config, username }));
  return {
    password: own || undefined,
    username,
    login,
    source: own ? 'host' : undefined,
    requiresVaultUnlock: false,
  };
}

export interface JumpLoginResolution {
  password?: string;
  username?: string;
  /** The shared login used for the bastion, to name it when it's refused. */
  login?: LoginProfile;
  requiresVaultUnlock: boolean;
}

/**
 * Work out the jump host (bastion) login: a password typed for this connect →
 * the jump host's shared login → its own password saved in the vault (only
 * when the host says it has one — see jumpLoginProfileId) → none, leaving the
 * backend to try the key and ssh-agent. A bastion with no saved password never
 * asks to unlock the vault, so key-only bastions connect as before.
 */
export async function resolveJumpLogin(
  config: Pick<
    ConnectionConfig,
    | 'protocol'
    | 'jumpHost'
    | 'jumpPort'
    | 'jumpUsername'
    | 'jumpPassword'
    | 'jumpLoginProfileId'
    | 'username'
  >,
  profiles: LoginProfile[],
  vault: VaultCredentialSource,
): Promise<JumpLoginResolution> {
  if (config.protocol !== 'ssh' || !config.jumpHost) {
    return { password: config.jumpPassword, username: config.jumpUsername, requiresVaultUnlock: false };
  }
  const choice = config.jumpLoginProfileId;
  const login = choice ? profiles.find((p) => p.id === choice) : undefined;
  const username = config.jumpUsername?.trim() ? config.jumpUsername : login?.username || config.jumpUsername;

  if (config.jumpPassword) {
    return { password: config.jumpPassword, username, login, requiresVaultUnlock: false };
  }
  if (!login && choice !== PER_HOST_PASSWORD) {
    return { username, requiresVaultUnlock: false };
  }
  if (!(await vault.isUnlocked())) {
    return { username, login, requiresVaultUnlock: await vault.isInitialized() };
  }
  const key = login ? loginSecretKey(login.id) : jumpCredentialKey(config);
  return {
    password: (await vault.retrieve(key)) || undefined,
    username,
    login,
    requiresVaultUnlock: false,
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
