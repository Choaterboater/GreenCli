import { describe, it, expect } from 'vitest';
import {
  buildConnectPayload,
  isAuthFailure,
  jumpCredentialKey,
  needsPasswordPrompt,
  resolveJumpLogin,
  resolveSshLogin,
  sshCredentialKey,
  VaultCredentialSource,
} from './connect';
import { loginSecretKey, PER_HOST_PASSWORD } from './logins';
import { ConnectionConfig, LoginProfile } from '../types';

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

  it("sends the TAB's id as the session id, never the saved host's", () => {
    const tab: ConnectionConfig = {
      id: 'tab-2',
      savedId: 'saved-core',
      copyNumber: 2,
      tabName: 'uplink work',
      name: 'core-sw-01',
      protocol: 'ssh',
      host: '10.1.1.1',
      deviceType: 'aruba-cx',
    };
    const payload = buildConnectPayload(tab, {}, BEHAVIOR);
    expect(payload.id).toBe('tab-2');
    expect(payload.name).toBe('core-sw-01');
    // Tab-only fields (savedId, copyNumber, tabName) don't reach the backend.
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

/** An in-memory vault: `entries` by key, plus lock state. Counts reads. */
function fakeVault(
  entries: Record<string, string>,
  state: { unlocked?: boolean; initialized?: boolean } = {},
) {
  const reads: string[] = [];
  const vault: VaultCredentialSource & { reads: string[]; unlocked: boolean } = {
    reads,
    unlocked: state.unlocked ?? true,
    isUnlocked: async () => vault.unlocked,
    isInitialized: async () => state.initialized ?? true,
    retrieve: async (key: string) => {
      reads.push(key);
      return entries[key] ?? null;
    },
  };
  return vault;
}

const TACACS: LoginProfile = { id: 'login-tacacs', name: 'TACACS admin', username: 'jdoe' };
const LAB: LoginProfile = { id: 'login-lab', name: 'Lab', username: 'labadmin' };
const PROFILES = [TACACS, LAB];

describe('resolveSshLogin', () => {
  it('rechecks the backend after unlock and resumes with the saved password', async () => {
    const vault = fakeVault({ [sshCredentialKey(baseConfig)]: 'saved-password' }, { unlocked: false });
    const ctx = { profiles: [] };

    const locked = await resolveSshLogin(baseConfig, ctx, vault);
    expect(locked.requiresVaultUnlock).toBe(true);
    expect(locked.password).toBeUndefined();
    expect(vault.reads).toEqual([]);

    vault.unlocked = true;
    const resumed = await resolveSshLogin(baseConfig, ctx, vault);
    expect(resumed).toMatchObject({
      password: 'saved-password',
      username: 'admin',
      source: 'host',
      requiresVaultUnlock: false,
    });
    expect(vault.reads).toEqual([sshCredentialKey(baseConfig)]);
  });

  it('uses the folder default login, filling in a blank username', async () => {
    const vault = fakeVault({ [loginSecretKey(TACACS.id)]: 'rotated-pw' });
    const host = { ...baseConfig, username: '' };
    const r = await resolveSshLogin(host, { profiles: PROFILES, folderLoginProfileId: TACACS.id }, vault);
    expect(r).toMatchObject({
      password: 'rotated-pw',
      username: 'jdoe',
      login: TACACS,
      source: 'login',
      requiresVaultUnlock: false,
    });
  });

  it("keeps the host's own username over the login's", async () => {
    const vault = fakeVault({ [loginSecretKey(TACACS.id)]: 'rotated-pw' });
    const r = await resolveSshLogin(baseConfig, { profiles: PROFILES, folderLoginProfileId: TACACS.id }, vault);
    expect(r.username).toBe('admin');
    expect(r.password).toBe('rotated-pw');
  });

  it("prefers the host's own login over its folder's", async () => {
    const vault = fakeVault({
      [loginSecretKey(TACACS.id)]: 'tacacs-pw',
      [loginSecretKey(LAB.id)]: 'lab-pw',
    });
    const r = await resolveSshLogin(
      { ...baseConfig, username: undefined, loginProfileId: LAB.id },
      { profiles: PROFILES, folderLoginProfileId: TACACS.id },
      vault,
    );
    expect(r).toMatchObject({ password: 'lab-pw', username: 'labadmin', login: LAB });
  });

  it('an inline password beats every saved one', async () => {
    const vault = fakeVault({ [loginSecretKey(TACACS.id)]: 'tacacs-pw' }, { unlocked: false });
    const r = await resolveSshLogin(
      { ...baseConfig, password: 'typed' },
      { profiles: PROFILES, folderLoginProfileId: TACACS.id },
      vault,
    );
    expect(r).toMatchObject({ password: 'typed', source: 'inline', requiresVaultUnlock: false });
    expect(vault.reads).toEqual([]);
  });

  it('"per-host password" ignores the folder login and reads the host key', async () => {
    const vault = fakeVault({
      [loginSecretKey(TACACS.id)]: 'tacacs-pw',
      [sshCredentialKey(baseConfig)]: 'own-pw',
    });
    const r = await resolveSshLogin(
      { ...baseConfig, loginProfileId: PER_HOST_PASSWORD },
      { profiles: PROFILES, folderLoginProfileId: TACACS.id },
      vault,
    );
    expect(r).toMatchObject({ password: 'own-pw', source: 'host', login: undefined });
    expect(vault.reads).toEqual([sshCredentialKey(baseConfig)]);
  });

  it("falls back to the per-host password when the login has none saved — never to another login's", async () => {
    const vault = fakeVault({
      [loginSecretKey(TACACS.id)]: 'tacacs-pw',
      [sshCredentialKey({ ...baseConfig, username: 'labadmin' })]: 'own-pw',
    });
    const r = await resolveSshLogin(
      { ...baseConfig, username: '', loginProfileId: LAB.id },
      { profiles: PROFILES, folderLoginProfileId: TACACS.id },
      vault,
    );
    // Keyed by the username actually sent, and still reports the login so
    // the dialog can offer to save the password to it.
    expect(r).toMatchObject({ password: 'own-pw', username: 'labadmin', login: LAB, source: 'host' });
    expect(vault.reads).not.toContain(loginSecretKey(TACACS.id));
  });

  it('reports the login even when nothing is saved, so the dialog can offer to save it', async () => {
    const r = await resolveSshLogin(
      { ...baseConfig, username: '' },
      { profiles: PROFILES, folderLoginProfileId: TACACS.id },
      fakeVault({}),
    );
    expect(r).toMatchObject({ password: undefined, username: 'jdoe', login: TACACS, source: undefined });
  });

  it('a locked vault with a login asks to unlock and still names the login', async () => {
    const r = await resolveSshLogin(
      { ...baseConfig, username: '' },
      { profiles: PROFILES, folderLoginProfileId: TACACS.id },
      fakeVault({}, { unlocked: false }),
    );
    expect(r).toMatchObject({ requiresVaultUnlock: true, username: 'jdoe', login: TACACS });
    // No vault yet at all: nothing to unlock, just ask for the password.
    const fresh = await resolveSshLogin(
      baseConfig,
      { profiles: PROFILES, folderLoginProfileId: TACACS.id },
      fakeVault({}, { unlocked: false, initialized: false }),
    );
    expect(fresh.requiresVaultUnlock).toBe(false);
  });

  it('treats a deleted login as unset (falls back to the folder)', async () => {
    const vault = fakeVault({ [loginSecretKey(TACACS.id)]: 'tacacs-pw' });
    const r = await resolveSshLogin(
      { ...baseConfig, loginProfileId: 'login-deleted' },
      { profiles: PROFILES, folderLoginProfileId: TACACS.id },
      vault,
    );
    expect(r.login).toBe(TACACS);
  });

  it('leaves key, agent and non-SSH logins alone', async () => {
    const vault = fakeVault({ [loginSecretKey(TACACS.id)]: 'tacacs-pw' });
    const ctx = { profiles: PROFILES, folderLoginProfileId: TACACS.id };
    for (const cfg of [
      { ...baseConfig, username: '', authType: 'key' as const },
      { ...baseConfig, username: '', authType: 'agent' as const },
      { ...baseConfig, username: '', protocol: 'telnet' as const },
    ]) {
      const r = await resolveSshLogin(cfg, ctx, vault);
      expect(r).toEqual({ password: undefined, username: '', requiresVaultUnlock: false });
    }
    expect(vault.reads).toEqual([]);
  });
});

describe('resolveJumpLogin', () => {
  const viaBastion: ConnectionConfig = {
    ...baseConfig,
    jumpHost: 'bastion.corp',
    jumpPort: 22,
    jumpUsername: 'ops',
  };

  it('uses a shared login for the bastion, filling in a blank jump user', async () => {
    const vault = fakeVault({ [loginSecretKey(TACACS.id)]: 'tacacs-pw' });
    const r = await resolveJumpLogin(
      { ...viaBastion, jumpUsername: '', jumpLoginProfileId: TACACS.id },
      PROFILES,
      vault,
    );
    expect(r).toMatchObject({ password: 'tacacs-pw', username: 'jdoe', login: TACACS, requiresVaultUnlock: false });
  });

  it("reads the jump host's own saved password when set to per-host", async () => {
    const vault = fakeVault({ [jumpCredentialKey(viaBastion)]: 'bastion-pw' });
    const r = await resolveJumpLogin({ ...viaBastion, jumpLoginProfileId: PER_HOST_PASSWORD }, PROFILES, vault);
    expect(r).toMatchObject({ password: 'bastion-pw', username: 'ops', requiresVaultUnlock: false });
    expect(jumpCredentialKey(viaBastion)).toBe('cred:bastion.corp:22:ops');
  });

  it('a typed jump password wins; with no saved one the vault is never touched', async () => {
    const vault = fakeVault({}, { unlocked: false });
    const typed = await resolveJumpLogin(
      { ...viaBastion, jumpPassword: 'typed', jumpLoginProfileId: TACACS.id },
      PROFILES,
      vault,
    );
    expect(typed).toMatchObject({ password: 'typed', requiresVaultUnlock: false });
    // Key / agent bastion (nothing chosen): no unlock prompt, no password.
    const keyOnly = await resolveJumpLogin(viaBastion, PROFILES, vault);
    expect(keyOnly).toEqual({ username: 'ops', requiresVaultUnlock: false });
    expect(vault.reads).toEqual([]);
  });

  it('asks to unlock the vault when the bastion password is saved there', async () => {
    const vault = fakeVault({}, { unlocked: false });
    for (const choice of [PER_HOST_PASSWORD, TACACS.id]) {
      const r = await resolveJumpLogin({ ...viaBastion, jumpLoginProfileId: choice }, PROFILES, vault);
      expect(r.requiresVaultUnlock).toBe(true);
    }
  });

  it('does nothing without a jump host', async () => {
    const r = await resolveJumpLogin({ ...baseConfig, jumpLoginProfileId: TACACS.id }, PROFILES, fakeVault({}));
    expect(r).toEqual({ password: undefined, username: undefined, requiresVaultUnlock: false });
  });

  it("keys a jump host's password by the device user when the jump user is blank", () => {
    expect(jumpCredentialKey({ jumpHost: 'b', jumpPort: undefined, jumpUsername: ' ', username: 'admin' })).toBe(
      'cred:b:22:admin',
    );
  });
});

describe('isAuthFailure', () => {
  // Real backend error strings (AppError Display + ssh/client.rs messages).
  it('treats rejected credentials as auth failures (re-prompt helps)', () => {
    for (const err of [
      'Auth Error: Password / keyboard-interactive authentication failed',
      'Auth Error: Public key authentication failed',
      'Auth Error: ssh-agent has no keys loaded (run `ssh-add`)',
      'SSH Error: Auth failed: Disconnected',
      'SSH Error: Key auth failed: Wrong key',
      'SSH Error: Keyboard-interactive respond: SendError',
      'SSH Error: Key decode: Crypto',
      "Could not read SSH private key file '/tmp/id': No such file or directory",
    ]) {
      expect(isAuthFailure(err), err).toBe(true);
    }
  });

  it("doesn't blame the device password for a refused jump host", () => {
    for (const err of [
      'Auth Error: Jump host authentication failed (tried password, key, and agent)',
      'SSH Error: Jump host auth failed: Disconnected',
      "Auth Error: The jump host asked for a second login step (MFA / one-time code). Jump hosts that need MFA aren't supported yet",
    ]) {
      expect(isAuthFailure(err), err).toBe(false);
    }
  });

  it('does not re-prompt for reachability, host-key, timeout or shell errors', () => {
    for (const err of [
      'SSH Error: Connection failed: Connection refused (os error 111)',
      'SSH Error: Connection failed: Unknown server key — Host key MISMATCH (manage saved host keys in Settings → Known Hosts)',
      'SSH Error: Timed out after 60s connecting to 10.0.0.1:22 (no answer, or the SSH login never finished)',
      'SSH Error: The server refused a PTY (the account or device may not allow an interactive shell)',
      'Telnet Error: Connect: timed out connecting to 10.0.0.1:23',
    ]) {
      expect(isAuthFailure(err), err).toBe(false);
    }
  });
});

describe('needsPasswordPrompt', () => {
  it('asks first when SSH password auth has no password (no doomed empty login)', () => {
    expect(needsPasswordPrompt({ protocol: 'ssh', authType: 'password' }, undefined)).toBe(true);
    expect(needsPasswordPrompt({ protocol: 'ssh', authType: undefined }, '')).toBe(true);
  });

  it('connects straight away when a password, key, agent, or non-SSH protocol is in play', () => {
    expect(needsPasswordPrompt({ protocol: 'ssh', authType: 'password' }, 'secret')).toBe(false);
    expect(needsPasswordPrompt({ protocol: 'ssh', authType: 'key' }, undefined)).toBe(false);
    expect(needsPasswordPrompt({ protocol: 'ssh', authType: 'agent' }, undefined)).toBe(false);
    expect(needsPasswordPrompt({ protocol: 'telnet', authType: undefined }, undefined)).toBe(false);
    expect(needsPasswordPrompt({ protocol: 'local', authType: undefined }, undefined)).toBe(false);
  });
});
