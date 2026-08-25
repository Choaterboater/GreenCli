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
