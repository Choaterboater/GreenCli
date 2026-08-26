import { describe, it, expect } from 'vitest';
import { buildConnectPayload, resolveSshPassword, sshCredentialKey } from './connect';
import { ConnectionConfig } from '../types';

const BEHAVIOR = { keepAliveInterval: 30, autoReconnect: true };

/** Every key the `connect` Tauri command reads — the payload must be the
 *  superset, on BOTH the direct-connect and auth-retry paths. */
const ALL_KEYS = [
  'id',
  'name',
  'protocol',
  'host',
  'port',
  'username',
  'auth_type',
  'keyPath',
  'password',
  'private_key',
  'key_passphrase',
  'serial_port',
  'baud_rate',
  'data_bits',
  'parity',
  'stop_bits',
  'device_type',
  'device_profile_id',
  'keep_alive_interval',
  'auto_reconnect',
  'command',
  'args',
  'cwd',
  'jump_host',
  'jump_port',
  'jump_username',
  'jump_password',
];

const baseConfig: ConnectionConfig = {
  id: 'sess-1',
  name: 'core-sw',
  protocol: 'ssh',
  host: '10.0.0.5',
  port: 22,
  username: 'admin',
  deviceType: 'aruba-cx',
};

describe('buildConnectPayload', () => {
  it('emits the complete superset of fields the connect command accepts', () => {
    const payload = buildConnectPayload(baseConfig, {}, BEHAVIOR);
    expect(Object.keys(payload).sort()).toEqual([...ALL_KEYS].sort());
  });

  it('maps camelCase config fields onto the wire names', () => {
    const payload = buildConnectPayload(
      {
        ...baseConfig,
        authType: 'key',
        keyPath: '/home/u/.ssh/id_ed25519',
        privateKey: 'PRIVATEKEY',
        keyPassphrase: 'kp',
        deviceProfileId: 'aos-cx',
        jumpHost: 'bastion',
        jumpPort: 2222,
        jumpUsername: 'jumpuser',
        jumpPassword: 'jumppw',
      },
      { password: 'pw' },
      BEHAVIOR
    );
    expect(payload).toMatchObject({
      id: 'sess-1',
      protocol: 'ssh',
      host: '10.0.0.5',
      port: 22,
      username: 'admin',
      auth_type: 'key',
      keyPath: '/home/u/.ssh/id_ed25519',
      password: 'pw',
      private_key: 'PRIVATEKEY',
      key_passphrase: 'kp',
      device_type: 'aruba-cx',
      device_profile_id: 'aos-cx',
      keep_alive_interval: 30,
      auto_reconnect: true,
      jump_host: 'bastion',
      jump_port: 2222,
      jump_username: 'jumpuser',
      jump_password: 'jumppw',
    });
  });

  it('keeps serial line settings (regression: auth retry used to drop them)', () => {
    const payload = buildConnectPayload(
      {
        id: 'sess-2',
        name: 'console',
        protocol: 'serial',
        deviceType: 'aruba-cx',
        serialPort: '/dev/ttyUSB0',
        baudRate: 115200,
        dataBits: 7,
        parity: 'even',
        stopBits: 2,
      },
      {},
      BEHAVIOR
    );
    expect(payload).toMatchObject({
      serial_port: '/dev/ttyUSB0',
      baud_rate: 115200,
      data_bits: 7,
      parity: 'even',
      stop_bits: 2,
    });
  });

  it('keeps local-shell launch details (regression: auth retry used to drop them)', () => {
    const payload = buildConnectPayload(
      {
        id: 'sess-3',
        name: 'local bash',
        protocol: 'local',
        deviceType: 'generic',
        command: 'bash',
        args: ['-l'],
        cwd: '/tmp',
      },
      {},
      BEHAVIOR
    );
    expect(payload).toMatchObject({ command: 'bash', args: ['-l'], cwd: '/tmp' });
  });

  it('defaults auth_type from the config, and lets dialog credentials override it', () => {
    expect(buildConnectPayload(baseConfig, {}, BEHAVIOR).auth_type).toBe('password');
    expect(
      buildConnectPayload({ ...baseConfig, authType: 'agent' }, {}, BEHAVIOR).auth_type
    ).toBe('agent');
    // The auth dialog's explicit choice wins over the stored config.
    expect(
      buildConnectPayload({ ...baseConfig, authType: 'password' }, { authType: 'key' }, BEHAVIOR)
        .auth_type
    ).toBe('key');
  });

  it('falls back to config key material when dialog creds omit it', () => {
    const payload = buildConnectPayload(
      { ...baseConfig, privateKey: 'FROM-CONFIG', keyPassphrase: 'CFG' },
      { password: 'dialog-pw' },
      BEHAVIOR
    );
    expect(payload.private_key).toBe('FROM-CONFIG');
    expect(payload.key_passphrase).toBe('CFG');
    expect(payload.password).toBe('dialog-pw');
  });
});

describe('resolveSshPassword', () => {
  it('rechecks the backend after unlock and resumes with the saved password', async () => {
    let unlocked = false;
    let retrieveCalls = 0;
    const vault = {
      isUnlocked: async () => unlocked,
      isInitialized: async () => true,
      retrieve: async (key: string) => {
        retrieveCalls += 1;
        expect(key).toBe(sshCredentialKey(baseConfig));
        return 'saved-password';
      },
    };

    const locked = await resolveSshPassword({ ...baseConfig, authType: 'password' }, vault);
    expect(locked).toEqual({ password: undefined, requiresVaultUnlock: true });
    expect(retrieveCalls).toBe(0);

    unlocked = true;
    const resumed = await resolveSshPassword({ ...baseConfig, authType: 'password' }, vault);
    expect(resumed).toEqual({ password: 'saved-password', requiresVaultUnlock: false });
    expect(retrieveCalls).toBe(1);
  });
});
