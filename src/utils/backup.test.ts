import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every backend list is empty: these tests are about settings only.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
}));

import { createGreenCliBackup, importGreenCliBackup, type GreenCliBackup } from './backup';
import { useSettingsStore } from '../store/settingsStore';

const HOOK = 'https://hooks.slack.com/services/T000/B000/secret-token';

describe('intent webhook URL in backups', () => {
  beforeEach(() => {
    useSettingsStore.getState().updateSettings({ intentWebhookUrl: HOOK });
  });

  it('is left out of an exported backup (the URL works as a password)', async () => {
    const backup = await createGreenCliBackup();
    expect(backup.settings).not.toHaveProperty('intentWebhookUrl');
    expect(JSON.stringify(backup)).not.toContain('secret-token');
  });

  it('is never set by importing a backup', async () => {
    const backup: GreenCliBackup = {
      app: 'GreenCLI',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { intentWebhookUrl: 'https://attacker.example/collect' },
      snippets: [],
      triggers: [],
      folders: [],
      intents: [],
    };
    for (const mode of ['merge', 'replace'] as const) {
      await importGreenCliBackup(backup, mode);
      expect(useSettingsStore.getState().intentWebhookUrl).toBe(HOOK);
    }
  });
});

describe('Casper settings in backups', () => {
  beforeEach(() => {
    useSettingsStore.getState().updateSettings({ casperCommand: 'casper', casperWorkFolder: '' });
  });

  it('are never set by importing a backup (a command GreenCLI runs, and its folder)', async () => {
    const backup: GreenCliBackup = {
      app: 'GreenCLI',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { casperCommand: '/tmp/evil/casper --verbose', casperWorkFolder: '/Users/me' },
      snippets: [],
      triggers: [],
      folders: [],
      intents: [],
    };
    for (const mode of ['merge', 'replace'] as const) {
      await importGreenCliBackup(backup, mode);
      expect(useSettingsStore.getState().casperCommand).toBe('casper');
      expect(useSettingsStore.getState().casperWorkFolder).toBe('');
    }
  });

  it('drops the provider of an imported agent that would switch to Casper', async () => {
    const backup: GreenCliBackup = {
      app: 'GreenCLI',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        aiAgents: [{ id: 'a1', name: 'A', instructions: '', provider: 'casper', model: '/tmp/x/casper', color: '#fff' }],
      },
      snippets: [],
      triggers: [],
      folders: [],
      intents: [],
    };
    await importGreenCliBackup(backup, 'merge');
    const agent = useSettingsStore.getState().aiAgents.find((a) => a.id === 'a1');
    expect(agent?.provider).toBe('');
    expect(agent?.model).toBe('');
  });
});
