import { describe, it, expect } from 'vitest';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, groupForFocus, searchSettings } from './settingsSections';
import { HELP_TOPICS } from '../data/helpContent';

const ids = (q: string) => searchSettings(q).map((s) => s.id);

describe('settings sections', () => {
  it('puts every section in a known group, in group order', () => {
    const order = SETTINGS_GROUPS.map((g) => g.id);
    const groupIdx = SETTINGS_SECTIONS.map((s) => order.indexOf(s.group));
    expect(groupIdx.every((i) => i >= 0)).toBe(true);
    expect(groupIdx).toEqual([...groupIdx].sort((a, b) => a - b));
  });

  it('finds sections by any label, needing every word', () => {
    expect(ids('keep-alive')).toEqual(['connection']);
    expect(ids('host key')).toEqual(['hosts']);
    expect(ids('Paste Guard')).toEqual(['terminal']);
    expect(ids('webhook')).toEqual(['intent-schedule']);
    expect(ids('mist')).toContain('mist');
    expect(ids('zzz nothing')).toEqual([]);
    // Casper's own settings, and the MCP export for Casper.
    expect(ids('casper')).toEqual(['ai', 'mcp']);
    expect(ids('allow writes')).toEqual(['mcp']);
    expect(ids('read-only')).toEqual(['mcp']);
    expect(ids('run plain show commands')).toEqual(['mcp']);
    expect(ids('export')).toContain('mcp');
    expect(ids('working folder')).toEqual(['ai']);
    expect(ids('check casper')).toEqual(['ai']);
    expect(ids('check for updates')).toEqual(['updates']);
    expect(ids('new version')).toEqual(['updates']);
    // greencli-mcp, and where AI keys and MCP logins are kept.
    expect(ids('greencli-mcp')).toEqual(['config-archive', 'mcp']);
    expect(ids('claude mcp add')).toEqual(['mcp']);
    expect(ids('hidden copy')).toEqual(['config-archive', 'mcp']);
    expect(ids('make hidden copies')).toEqual(['config-archive']);
    for (const q of ['keychain', 'credential manager', 'password store', 'keyring']) {
      expect(ids(q)).toEqual(['ai', 'mcp']);
    }
  });

  it('matches group names too, and returns everything for an empty search', () => {
    expect(ids('integrations')).toEqual(['central', 'mist']);
    expect(searchSettings('   ')).toHaveLength(SETTINGS_SECTIONS.length);
  });

  it('resolves every Help deep-link to a group', () => {
    const focuses = HELP_TOPICS.map((t) => t.action)
      .filter((a) => a?.id === 'open-settings' && a.focus)
      .map((a) => a!.focus!);
    expect(focuses.length).toBeGreaterThan(0);
    for (const f of focuses) expect(groupForFocus(f)).not.toBeNull();
    // Deep links used from elsewhere in the app.
    for (const f of ['mcp', 'agents', 'logins', 'central', 'mist', 'import']) {
      expect(groupForFocus(f)).not.toBeNull();
    }
  });
});
