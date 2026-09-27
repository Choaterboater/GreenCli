import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from './settingsStore';

describe('settingsStore shared logins', () => {
  beforeEach(() => {
    useSettingsStore.setState({ loginProfiles: [] });
  });

  it('adds, renames and removes logins', () => {
    const s = useSettingsStore.getState();
    s.addLoginProfile({ id: 'l1', name: 'TACACS', username: 'jdoe' });
    s.addLoginProfile({ id: 'l2', name: 'Lab', username: 'lab' });
    s.updateLoginProfile('l1', { name: 'TACACS admin' });
    expect(useSettingsStore.getState().loginProfiles).toEqual([
      { id: 'l1', name: 'TACACS admin', username: 'jdoe' },
      { id: 'l2', name: 'Lab', username: 'lab' },
    ]);
    s.removeLoginProfile('l1');
    expect(useSettingsStore.getState().loginProfiles.map((p) => p.id)).toEqual(['l2']);
  });

  it('keeps logins through a settings reset (hosts and the vault still point at them)', () => {
    const s = useSettingsStore.getState();
    s.addLoginProfile({ id: 'l1', name: 'TACACS', username: 'jdoe' });
    s.setFontSize(20);
    s.resetToDefaults();
    const after = useSettingsStore.getState();
    expect(after.fontSize).toBe(14);
    expect(after.loginProfiles).toEqual([{ id: 'l1', name: 'TACACS', username: 'jdoe' }]);
  });

  it('persists login metadata only — there is no password field to leak', () => {
    useSettingsStore.getState().addLoginProfile({ id: 'l1', name: 'TACACS', username: 'jdoe' });
    const stored = JSON.parse(localStorage.getItem('atp-settings') ?? '{}');
    expect(stored.state.loginProfiles).toEqual([{ id: 'l1', name: 'TACACS', username: 'jdoe' }]);
  });
});
