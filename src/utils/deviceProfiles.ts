import { ConnectionConfig, DeviceProfile, DeviceType, DEVICE_TYPES } from '../types';
import { ArubaHighlighter } from '../syntax';

export const BUILTIN_DEVICE_PROFILES: DeviceProfile[] = [
  {
    id: 'builtin-generic',
    name: 'Normal Device',
    deviceType: 'generic',
    short: 'GEN',
    color: 'var(--vendor-generic)',
    description: 'Raw terminal mode with no forced vendor assumptions.',
    promptPatterns: [],
    fingerprints: [],
    commands: [],
    keywords: [],
    runningConfigCommand: 'show running-config',
  },
  {
    id: 'builtin-aruba-cx',
    name: 'Aruba AOS-CX Switch',
    deviceType: 'aruba-cx',
    short: 'CX',
    color: 'var(--vendor-aruba)',
    promptPatterns: ['switch#', 'switch(config)#'],
    fingerprints: ['vsx-sync', 'interface 1/', 'show running-config'],
    commands: ['show', 'configure', 'interface', 'vlan', 'router', 'write memory'],
    keywords: ['vsx', 'vlan access', 'vlan trunk', 'evpn', 'vxlan'],
    runningConfigCommand: 'show running-config',
    pagingDisableCommand: 'no page',
    pagingRestoreCommand: 'page',
  },
  {
    id: 'builtin-aruba-aos-s',
    name: 'Aruba AOS-S Switch',
    deviceType: 'aruba-aos-s',
    short: 'AOS-S',
    color: 'var(--vendor-aruba)',
    promptPatterns: ['switch#', 'switch(config)#'],
    fingerprints: ['show running-config', 'vlan', 'untagged', 'tagged'],
    commands: ['show', 'configure', 'vlan', 'interface', 'write memory'],
    keywords: ['tagged', 'untagged', 'trunk', 'ip address'],
    runningConfigCommand: 'show running-config',
    pagingDisableCommand: 'no page',
    pagingRestoreCommand: 'page',
  },
  {
    id: 'builtin-aruba-ap',
    name: 'Aruba Access Point',
    deviceType: 'aruba-ap',
    short: 'AP',
    color: 'var(--vendor-aruba)',
    promptPatterns: ['AP#', 'IAP#', 'VC#'],
    fingerprints: ['virtual-controller', 'iap-master', 'swarm', 'dot11a', 'dot11g'],
    commands: ['show', 'configure terminal', 'wlan', 'commit apply'],
    keywords: ['ssid-profile', 'virtual-controller', 'ap-name', 'cluster'],
    runningConfigCommand: 'show running-config',
  },
  {
    id: 'builtin-aruba-controller',
    name: 'Aruba Controller / AOS 8',
    deviceType: 'aruba-controller',
    short: 'MC',
    color: 'var(--vendor-aruba)',
    promptPatterns: ['(ArubaMC) #', '(config) #'],
    fingerprints: ['wlan virtual-ap', 'aaa-profile', 'ap-group', 'airgroup'],
    commands: ['show', 'configure terminal', 'write memory'],
    keywords: ['aaa-profile', 'virtual-ap', 'ap-group', 'lms-ip'],
    runningConfigCommand: 'show running-config',
    pagingDisableCommand: 'no paging',
    pagingRestoreCommand: 'paging',
  },
  {
    id: 'builtin-juniper-junos',
    name: 'Juniper Junos',
    deviceType: 'juniper-junos',
    short: 'JUNOS',
    color: 'var(--vendor-juniper)',
    promptPatterns: ['user@host>', 'user@host#', '[edit]'],
    fingerprints: ['set interfaces', 'family inet', 'commit confirmed', '| display set'],
    commands: ['show', 'set', 'delete', 'commit', 'rollback', 'configure'],
    keywords: ['interfaces', 'protocols', 'routing-options', 'vlans'],
    runningConfigCommand: 'show configuration | no-more',
  },
  {
    id: 'builtin-mist',
    name: 'Juniper Mist-managed Device',
    deviceType: 'mist',
    short: 'MIST',
    color: 'var(--vendor-mist)',
    promptPatterns: ['user@host>', 'user@host#'],
    fingerprints: ['set interfaces', 'family inet', 'mist'],
    commands: ['show', 'set', 'delete', 'commit', 'rollback'],
    keywords: ['interfaces', 'protocols', 'vlans'],
    runningConfigCommand: 'show configuration | no-more',
  },
];

export function allDeviceProfiles(customProfiles: DeviceProfile[] = []): DeviceProfile[] {
  return [...BUILTIN_DEVICE_PROFILES, ...customProfiles];
}

function optionalString(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

export function isValidDeviceProfile(profile: unknown): profile is DeviceProfile {
  if (!profile || typeof profile !== 'object') return false;
  const candidate = profile as DeviceProfile;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim().length > 0 &&
    typeof candidate.name === 'string' &&
    candidate.name.trim().length > 0 &&
    typeof candidate.deviceType === 'string' &&
    typeof candidate.short === 'string' &&
    typeof candidate.color === 'string' &&
    Array.isArray(candidate.promptPatterns) &&
    Array.isArray(candidate.fingerprints) &&
    Array.isArray(candidate.commands) &&
    Array.isArray(candidate.keywords) &&
    candidate.promptPatterns.every((item) => typeof item === 'string') &&
    candidate.fingerprints.every((item) => typeof item === 'string') &&
    candidate.commands.every((item) => typeof item === 'string') &&
    candidate.keywords.every((item) => typeof item === 'string') &&
    optionalString(candidate.description) &&
    optionalString(candidate.startupCommands) &&
    optionalString(candidate.runningConfigCommand) &&
    optionalString(candidate.pagingDisableCommand) &&
    optionalString(candidate.pagingRestoreCommand)
  );
}

export function validateDeviceProfiles(value: unknown): DeviceProfile[] {
  if (!Array.isArray(value)) throw new Error('Expected an array of device profiles');
  value.forEach((profile, index) => {
    if (!isValidDeviceProfile(profile)) {
      throw new Error(`Invalid device profile at index ${index}`);
    }
  });
  return value;
}

export function sanitizeStandaloneImportedProfiles(value: unknown): DeviceProfile[] {
  return validateDeviceProfiles(value).map((profile) => {
    const {
      startupCommands,
      runningConfigCommand,
      pagingDisableCommand,
      pagingRestoreCommand,
      ...safeProfile
    } = profile;
    void startupCommands;
    void runningConfigCommand;
    void pagingDisableCommand;
    void pagingRestoreCommand;
    return safeProfile;
  });
}

export function profileForDeviceType(deviceType: DeviceType): DeviceProfile {
  return (
    BUILTIN_DEVICE_PROFILES.find((p) => p.deviceType === deviceType) ??
    BUILTIN_DEVICE_PROFILES[0]
  );
}

export function profileById(id: string | undefined, customProfiles: DeviceProfile[] = []): DeviceProfile | undefined {
  if (!id) return undefined;
  return allDeviceProfiles(customProfiles).find((p) => p.id === id);
}

export function profileForSession(config: ConnectionConfig, customProfiles: DeviceProfile[] = []): DeviceProfile {
  return (
    profileById(config.deviceProfileId, customProfiles) ??
    profileForDeviceType(config.deviceType)
  );
}

export function detectProfileFromOutput(output: string, customProfiles: DeviceProfile[] = []): DeviceProfile {
  const detected = ArubaHighlighter.forDeviceType('generic').detectDeviceType(output);
  const customMatch = customProfiles.find((profile) => {
    const haystack = output.toLowerCase();
    const fingerprintMatch = profile.fingerprints.some((f) => f && haystack.includes(f.toLowerCase()));
    const promptMatch = profile.promptPatterns.some((pattern) => {
      try {
        return new RegExp(pattern, 'im').test(output);
      } catch {
        return false;
      }
    });
    return fingerprintMatch || promptMatch;
  });
  if (customMatch) return customMatch;
  return profileForDeviceType((detected as DeviceType) || 'generic');
}

export function profileReason(profile: DeviceProfile, output: string): string {
  if (profile.deviceType === 'generic') return 'No strong vendor fingerprints found.';
  const lower = output.toLowerCase();
  const fingerprint = profile.fingerprints.find((f) => f && lower.includes(f.toLowerCase()));
  if (fingerprint) return `Matched fingerprint "${fingerprint}".`;
  const prompt = profile.promptPatterns.find((pattern) => {
    try {
      return new RegExp(pattern, 'im').test(output);
    } catch {
      return false;
    }
  });
  if (prompt) return `Matched prompt pattern "${prompt}".`;
  return `Detected as ${profile.name} from recent terminal output.`;
}

export function saveSessionPayload(config: ConnectionConfig) {
  return {
    id: config.id,
    name: config.name,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    auth_type: config.authType || 'password',
    device_type: config.deviceType,
    device_profile_id: config.deviceProfileId,
    tags: config.tags,
    serial_port: config.serialPort,
    baud_rate: config.baudRate,
    data_bits: config.dataBits,
    parity: config.parity,
    stop_bits: config.stopBits,
    startup_commands: config.startupCommands,
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    jump_host: config.jumpHost,
    jump_port: config.jumpPort,
    jump_username: config.jumpUsername,
  };
}

export function deviceTypeLabel(deviceType: DeviceType): string {
  return DEVICE_TYPES.find((d) => d.value === deviceType)?.label ?? 'Normal Device';
}
