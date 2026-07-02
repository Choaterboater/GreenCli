import { invoke } from '@tauri-apps/api/tauri';
import { DEFAULT_SETTINGS, SessionFolder, TerminalSettings } from '../types';
import { useSettingsStore } from '../store/settingsStore';
import { useSnippetsStore, Snippet } from '../store/snippetsStore';
import { useTriggersStore, Trigger } from '../store/triggersStore';
import { Intent } from './intent';
import { isValidDeviceProfile, sanitizeStandaloneImportedProfiles, saveSessionPayload } from './deviceProfiles';
import { markSecretIdentitiesInvalidated } from './secretVault';

export type BackupImportMode = 'merge' | 'replace';

export interface GreenCliBackup {
  app: 'GreenCLI';
  version: 1;
  exportedAt: string;
  settings: Partial<TerminalSettings>;
  snippets: Snippet[];
  triggers: Trigger[];
  folders: SessionFolder[];
  intents: Intent[];
}

export interface BackupImportResult {
  settings: boolean;
  snippets: number;
  triggers: number;
  sessions: number;
  folders: number;
  intents: number;
}

const SECRET_SETTING_KEYS = new Set<keyof TerminalSettings>([
  'centralClientSecret',
  'centralToken',
  'apstraPassword',
  'mistToken',
]);

const UNSAFE_IMPORT_SETTING_KEYS = new Set<keyof TerminalSettings>([
  'aiProvider',
  'localCliCommand',
  'ollamaUrl',
  'aiReferences',
  'aiUseTerminal',
  'aiUseCxRest',
  'aiUseMcp',
  'aiUseApstra',
  'verifyDeviceTls',
]);

const SAFE_AGENT_PROVIDERS = new Set(['anthropic', 'openrouter', 'moonshot', 'ollama']);

function sanitizeSettings(settings: TerminalSettings): Partial<TerminalSettings> {
  const output: Partial<TerminalSettings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof TerminalSettings>) {
    if (SECRET_SETTING_KEYS.has(key)) continue;
    if (key === 'centralAccounts') {
      output.centralAccounts = (settings.centralAccounts ?? []).map((account) => ({
        ...account,
        clientSecret: '',
        token: '',
      }));
      continue;
    }
    output[key] = settings[key] as never;
  }
  return output;
}

function sanitizeImportedSettings(settings: Partial<TerminalSettings> | undefined): Partial<TerminalSettings> {
  if (!settings) return {};
  const output: Partial<TerminalSettings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof TerminalSettings>) {
    if (SECRET_SETTING_KEYS.has(key)) continue;
    if (UNSAFE_IMPORT_SETTING_KEYS.has(key)) continue;
    if (!(key in settings)) continue;
    if (key === 'centralAccounts') {
      if (!Array.isArray(settings.centralAccounts)) {
        throw new Error('Backup setting "centralAccounts" must be an array');
      }
      settings.centralAccounts.forEach((account, index) => {
        if (
          !nonEmptyString(account?.id) ||
          typeof account.name !== 'string' ||
          typeof account.baseUrl !== 'string' ||
          typeof account.clientId !== 'string' ||
          (account.mode !== 'creds' && account.mode !== 'token')
        ) {
          throw new Error(`Invalid Central account at settings.centralAccounts[${index}]`);
        }
      });
      rejectDuplicateIds(settings.centralAccounts, 'Central account');
      output.centralAccounts = (settings.centralAccounts ?? []).map((account) => ({
        ...account,
        clientSecret: '',
        token: '',
      }));
      continue;
    }
    const value = settings[key];
    const defaultValue = DEFAULT_SETTINGS[key];
    if (Array.isArray(defaultValue)) {
      if (!Array.isArray(value)) throw new Error(`Backup setting "${key}" must be an array`);
      if (key === 'customDeviceProfiles') {
        (value as TerminalSettings['customDeviceProfiles']).forEach((profile, index) => {
          if (!isValidDeviceProfile(profile)) {
            throw new Error(`Invalid device profile at settings.customDeviceProfiles[${index}]`);
          }
        });
        rejectDuplicateIds(value as TerminalSettings['customDeviceProfiles'], 'device profile');
        output.customDeviceProfiles = sanitizeStandaloneImportedProfiles(value);
        continue;
      } else if (key === 'aiAgents') {
        const agents = value as TerminalSettings['aiAgents'];
        agents.forEach((agent, index) => {
          if (!nonEmptyString(agent?.id) || typeof agent.name !== 'string' || typeof agent.instructions !== 'string') {
            throw new Error(`Invalid AI agent at settings.aiAgents[${index}]`);
          }
        });
        rejectDuplicateIds(agents, 'AI agent');
        output.aiAgents = agents.map((agent) => {
          const provider = typeof agent.provider === 'string' ? agent.provider : '';
          const safeProvider = SAFE_AGENT_PROVIDERS.has(provider) ? provider : '';
          return {
            ...agent,
            provider: safeProvider,
            model: safeProvider ? (typeof agent.model === 'string' ? agent.model : '') : '',
          };
        });
        continue;
      }
    } else if (isObject(defaultValue)) {
      if (!isObject(value)) throw new Error(`Backup setting "${key}" must be an object`);
      if (key === 'sessionAgents') {
        Object.entries(value).forEach(([sessionId, agentId]) => {
          if (typeof sessionId !== 'string' || typeof agentId !== 'string') {
            throw new Error('Backup setting "sessionAgents" must map session IDs to agent IDs');
          }
        });
      }
    } else if (typeof value !== typeof defaultValue) {
      throw new Error(`Backup setting "${key}" has the wrong type`);
    }
    output[key] = settings[key] as never;
  }
  return output;
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => byId.set(item.id, item));
  return Array.from(byId.values());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function rejectDuplicateIds(items: Array<{ id: string }>, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate ${label} id "${item.id}"`);
    seen.add(item.id);
  }
}

function requireArray<T>(value: unknown, label: string): T[] {
  if (value == null) throw new Error(`Backup field "${label}" is missing`);
  if (!Array.isArray(value)) throw new Error(`Backup field "${label}" must be an array`);
  return value as T[];
}

function optionalString(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

function optionalIntInRange(value: unknown, min: number, max: number): boolean {
  return value == null || (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max);
}

function requiredIntInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function optionalStringArray(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function validateBackup(raw: GreenCliBackup): GreenCliBackup {
  if (!isObject(raw) || raw.app !== 'GreenCLI' || raw.version !== 1) {
    throw new Error('Not a supported GreenCLI backup file');
  }
  if (!isObject(raw.settings)) {
    throw new Error('Backup field "settings" is missing or invalid');
  }

  const snippets = requireArray<Snippet>(raw.snippets, 'snippets');
  const triggers = requireArray<Trigger>(raw.triggers, 'triggers');
  const folders = requireArray<SessionFolder>(raw.folders, 'folders');
  const intents = requireArray<Intent>(raw.intents, 'intents');

  snippets.forEach((snippet, index) => {
    if (!nonEmptyString(snippet?.id) || typeof snippet.label !== 'string' || typeof snippet.command !== 'string') {
      throw new Error(`Invalid snippet at index ${index}`);
    }
  });
  rejectDuplicateIds(snippets, 'snippet');
  triggers.forEach((trigger, index) => {
    if (
      !nonEmptyString(trigger?.id) ||
      typeof trigger.pattern !== 'string' ||
      typeof trigger.isRegex !== 'boolean' ||
      typeof trigger.bell !== 'boolean'
    ) {
      throw new Error(`Invalid trigger at index ${index}`);
    }
  });
  rejectDuplicateIds(triggers, 'trigger');
  const allSessions: SessionFolder['items'] = [];
  folders.forEach((folder, index) => {
    if (!nonEmptyString(folder?.id) || typeof folder.name !== 'string' || typeof folder.expanded !== 'boolean' || !Array.isArray(folder.items)) {
      throw new Error(`Invalid folder at index ${index}`);
    }
    folder.items.forEach((item, itemIndex) => {
      if (
        !nonEmptyString(item?.id) ||
        typeof item.name !== 'string' ||
        !['ssh', 'telnet', 'serial', 'local'].includes(item.protocol) ||
        typeof item.deviceType !== 'string' ||
        !optionalString(item.host) ||
        !optionalIntInRange(item.port, 1, 65_535) ||
        !optionalString(item.username) ||
        !optionalString(item.authType) ||
        !optionalString(item.deviceProfileId) ||
        !optionalString(item.serialPort) ||
        !optionalIntInRange(item.baudRate, 1, 4_294_967_295) ||
        !optionalIntInRange(item.dataBits, 5, 8) ||
        !optionalString(item.parity) ||
        !optionalIntInRange(item.stopBits, 1, 2) ||
        !optionalString(item.startupCommands) ||
        !optionalStringArray(item.tags) ||
        !optionalString(item.jumpHost) ||
        !optionalIntInRange(item.jumpPort, 1, 65_535) ||
        !optionalString(item.jumpUsername) ||
        !optionalString(item.command) ||
        !optionalStringArray(item.args) ||
        !optionalString(item.cwd)
      ) {
        throw new Error(`Invalid session at folders[${index}].items[${itemIndex}]`);
      }
      allSessions.push(item);
    });
  });
  rejectDuplicateIds(folders, 'folder');
  rejectDuplicateIds(allSessions, 'session');
  intents.forEach((intent, index) => {
    if (
      !nonEmptyString(intent?.id) ||
      typeof intent.name !== 'string' ||
      (intent.kind !== 'config' && intent.kind !== 'operational') ||
      typeof intent.command !== 'string' ||
      !intent.matcher ||
      !['contains', 'notContains', 'regex', 'regexAbsent'].includes(intent.matcher.kind) ||
      typeof intent.matcher.value !== 'string' ||
      !['critical', 'warning', 'info'].includes(intent.severity) ||
      !intent.scope ||
      typeof intent.scope.all !== 'boolean' ||
      !optionalStringArray(intent.scope.tags) ||
      !optionalStringArray(intent.scope.deviceTypes) ||
      !optionalString(intent.description)
    ) {
      throw new Error(`Invalid intent at index ${index}`);
    }
    if (intent.lastResult != null) {
      if (
        !['ok', 'violation', 'unknown'].includes(intent.lastResult.status) ||
        typeof intent.lastResult.detail !== 'string' ||
        !requiredIntInRange(intent.lastResult.at, 0, Number.MAX_SAFE_INTEGER) ||
        (intent.lastResult.perDevice != null && !Array.isArray(intent.lastResult.perDevice)) ||
        !(intent.lastResult.perDevice ?? []).every(
          (result) =>
            typeof result.device === 'string' &&
            ['ok', 'violation', 'unknown'].includes(result.status) &&
            typeof result.detail === 'string',
        )
      ) {
        throw new Error(`Invalid intent result at index ${index}`);
      }
    }
  });
  rejectDuplicateIds(intents, 'intent');

  return {
    app: 'GreenCLI',
    version: 1,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    settings: isObject(raw.settings) ? raw.settings : {},
    snippets,
    triggers,
    folders,
    intents,
  };
}

function withExistingCentralSecrets(
  incoming: TerminalSettings['centralAccounts'],
  current: TerminalSettings['centralAccounts'],
): TerminalSettings['centralAccounts'] {
  const currentById = new Map(current.map((account) => [account.id, account]));
  return incoming.map((account) => {
    const existing = currentById.get(account.id);
    const sameSecretIdentity =
      existing &&
      existing.baseUrl === account.baseUrl &&
      existing.clientId === account.clientId;
    const sameTokenIdentity =
      existing &&
      existing.baseUrl === account.baseUrl;
    return {
      ...account,
      clientSecret: sameSecretIdentity ? existing.clientSecret : '',
      token: sameTokenIdentity ? existing.token : '',
    };
  });
}

function mergedSettingsPatch(
  incoming: Partial<TerminalSettings>,
  mode: BackupImportMode,
): Partial<TerminalSettings> {
  const current = useSettingsStore.getState();
  const patch = { ...incoming };

  if (incoming.centralAccounts) {
    const sanitizedAccounts = withExistingCentralSecrets(incoming.centralAccounts, current.centralAccounts ?? []);
    patch.centralAccounts =
      mode === 'merge'
        ? mergeById(current.centralAccounts ?? [], sanitizedAccounts)
        : sanitizedAccounts;
  }
  if (mode === 'merge') {
    if (incoming.customDeviceProfiles) {
      patch.customDeviceProfiles = mergeById(current.customDeviceProfiles ?? [], incoming.customDeviceProfiles);
    }
    if (incoming.aiAgents) {
      patch.aiAgents = mergeById(current.aiAgents ?? [], incoming.aiAgents);
    }
    if (incoming.sessionAgents) {
      patch.sessionAgents = { ...(current.sessionAgents ?? {}), ...incoming.sessionAgents };
    }
  }
  if (
    (incoming.centralBaseUrl != null && incoming.centralBaseUrl !== current.centralBaseUrl) ||
    (incoming.centralClientId != null && incoming.centralClientId !== current.centralClientId)
  ) {
    patch.centralClientSecret = '';
  }
  if (incoming.centralBaseUrl != null && incoming.centralBaseUrl !== current.centralBaseUrl) {
    patch.centralToken = '';
  }
  if (
    (incoming.apstraHost != null && incoming.apstraHost !== current.apstraHost) ||
    (incoming.apstraUsername != null && incoming.apstraUsername !== current.apstraUsername)
  ) {
    patch.apstraPassword = '';
  }
  if (incoming.mistBaseUrl != null && incoming.mistBaseUrl !== current.mistBaseUrl) {
    patch.mistToken = '';
  }

  return patch;
}

function secretInvalidationsForImport(incoming: Partial<TerminalSettings>): string[] {
  const current = useSettingsStore.getState();
  const invalidations: string[] = [];
  if (
    (incoming.centralBaseUrl != null && incoming.centralBaseUrl !== current.centralBaseUrl) ||
    (incoming.centralClientId != null && incoming.centralClientId !== current.centralClientId)
  ) {
    invalidations.push('centralClientSecret');
  }
  if (incoming.centralBaseUrl != null && incoming.centralBaseUrl !== current.centralBaseUrl) {
    invalidations.push('centralToken');
  }
  if (
    (incoming.apstraHost != null && incoming.apstraHost !== current.apstraHost) ||
    (incoming.apstraUsername != null && incoming.apstraUsername !== current.apstraUsername)
  ) {
    invalidations.push('apstraPassword');
  }
  if (incoming.mistBaseUrl != null && incoming.mistBaseUrl !== current.mistBaseUrl) {
    invalidations.push('mistToken');
  }
  if (incoming.centralAccounts) {
    const currentById = new Map((current.centralAccounts ?? []).map((account) => [account.id, account]));
    incoming.centralAccounts.forEach((account) => {
      const existing = currentById.get(account.id);
      if (!existing) {
        invalidations.push(`centralAccountSecret:${account.id}`, `centralAccountToken:${account.id}`);
        return;
      }
      const sameSecretIdentity =
        existing.baseUrl === account.baseUrl &&
        existing.clientId === account.clientId;
      const sameTokenIdentity = existing.baseUrl === account.baseUrl;
      if (!sameSecretIdentity) invalidations.push(`centralAccountSecret:${account.id}`);
      if (!sameTokenIdentity) invalidations.push(`centralAccountToken:${account.id}`);
    });
  }
  return invalidations;
}

function foldersWithAllSessions(
  folders: SessionFolder[],
  sessions: SessionFolder['items'],
): SessionFolder[] {
  const nextFolders = folders.map((folder) => ({ ...folder, items: [...folder.items] }));
  const seen = new Set(nextFolders.flatMap((folder) => folder.items.map((item) => item.id)));
  const looseSessions = sessions.filter((session) => !seen.has(session.id));
  if (looseSessions.length === 0) return nextFolders;

  let defaultFolder = nextFolders.find((folder) => folder.id === 'default');
  if (!defaultFolder) {
    defaultFolder = {
      id: 'default',
      name: 'Sessions',
      expanded: true,
      items: [],
    };
    nextFolders.unshift(defaultFolder);
  }
  defaultFolder.items.push(...looseSessions);
  return nextFolders;
}

function stripExecutableSessionFields(item: SessionFolder['items'][number]): SessionFolder['items'][number] {
  return {
    ...item,
    startupCommands: undefined,
    command: undefined,
    args: undefined,
    cwd: undefined,
  };
}

function sanitizeImportedIntent(intent: Intent): Intent {
  return {
    ...intent,
    description: [
      'Imported from backup with command disabled for review before evaluation.',
      intent.description,
    ].filter(Boolean).join('\n\n'),
    command: '',
    scope: { all: false, tags: [], deviceTypes: [] },
    lastResult: undefined,
  };
}

export async function createGreenCliBackup(): Promise<GreenCliBackup> {
  const [folders, sessions, intents] = await Promise.all([
    invoke<SessionFolder[]>('list_folders'),
    invoke<SessionFolder['items']>('list_sessions'),
    invoke<Intent[]>('intent_list_strict'),
  ]);
  return {
    app: 'GreenCLI',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: sanitizeSettings(useSettingsStore.getState()),
    snippets: useSnippetsStore.getState().snippets,
    triggers: useTriggersStore.getState().triggers,
    folders: foldersWithAllSessions(folders, sessions),
    intents,
  };
}

async function replaceSavedSessions(): Promise<void> {
  const [current, allSessions] = await Promise.all([
    invoke<SessionFolder[]>('list_folders'),
    invoke<SessionFolder['items']>('list_sessions'),
  ]);
  const deleted = new Set<string>();
  for (const folder of current) {
    for (const item of folder.items) {
      await invoke('delete_session', { id: item.id });
      deleted.add(item.id);
    }
  }
  for (const item of allSessions) {
    if (deleted.has(item.id)) continue;
    await invoke('delete_session', { id: item.id });
    deleted.add(item.id);
  }
  for (const folder of current) {
    if (folder.id !== 'default') {
      await invoke('delete_folder', { id: folder.id });
    }
  }
}

async function importFolders(folders: SessionFolder[], mode: BackupImportMode): Promise<{ folders: number; sessions: number }> {
  if (mode === 'replace') {
    await replaceSavedSessions();
  }

  const existingFolders = mode === 'merge'
    ? await invoke<SessionFolder[]>('list_folders')
    : [];
  let folderCount = 0;
  let sessionCount = 0;
  for (const folder of folders ?? []) {
    let targetFolderId = folder.id === 'default' ? 'default' : '';
    if (!targetFolderId) {
      const existing = existingFolders.find((candidate) => candidate.id === folder.id)
        ?? existingFolders.find((candidate) => candidate.name === folder.name);
      if (existing) {
        targetFolderId = existing.id;
      } else {
        targetFolderId = await invoke<string>('create_folder', { name: folder.name });
        folderCount += 1;
      }
    }
    await invoke('update_folder', {
      id: targetFolderId,
      name: folder.name,
      expanded: folder.expanded,
    });

    for (const item of folder.items ?? []) {
      await invoke('save_session', {
        config: saveSessionPayload(stripExecutableSessionFields(item)),
        folderId: targetFolderId,
      });
      sessionCount += 1;
    }
  }
  return { folders: folderCount, sessions: sessionCount };
}

export async function importGreenCliBackup(
  backup: GreenCliBackup,
  mode: BackupImportMode,
): Promise<BackupImportResult> {
  const validated = validateBackup(backup);
  const importedSettings = sanitizeImportedSettings(validated.settings);
  const settings = mergedSettingsPatch(importedSettings, mode);
  const currentIntents = await invoke<Intent[]>('intent_list_strict');
  if (mode === 'replace') {
    await Promise.all([
      invoke<SessionFolder[]>('list_folders'),
      invoke<SessionFolder['items']>('list_sessions'),
    ]);
  } else {
    await invoke<SessionFolder[]>('list_folders');
  }

  markSecretIdentitiesInvalidated(secretInvalidationsForImport(importedSettings));
  useSettingsStore.getState().updateSettings(settings);

  const snippets =
    mode === 'replace'
      ? validated.snippets
      : mergeById(useSnippetsStore.getState().snippets, validated.snippets);
  useSnippetsStore.setState({ snippets });

  const triggers =
    mode === 'replace'
      ? validated.triggers
      : mergeById(useTriggersStore.getState().triggers, validated.triggers);
  useTriggersStore.setState({ triggers });

  const sessionResult = await importFolders(validated.folders, mode);

  if (mode === 'replace') {
    for (const intent of currentIntents) {
      await invoke('intent_delete', { id: intent.id });
    }
  }
  // intent_save upserts by id, and imported intents are sanitized (command
  // cleared for review) — so in merge mode an id collision would overwrite the
  // user's WORKING intent with a disabled copy. Keep the existing one instead.
  const existingIntentIds = new Set(
    mode === 'replace' ? [] : currentIntents.map((i) => i.id),
  );
  let intentsImported = 0;
  for (const intent of validated.intents) {
    if (existingIntentIds.has(intent.id)) continue;
    await invoke('intent_save', { intent: sanitizeImportedIntent(intent) });
    intentsImported++;
  }

  return {
    settings: true,
    // Counts report what the BACKUP contributed, not the post-merge totals
    // (which inflated the toast in merge mode).
    snippets: validated.snippets.length,
    triggers: validated.triggers.length,
    folders: sessionResult.folders,
    sessions: sessionResult.sessions,
    intents: intentsImported,
  };
}
