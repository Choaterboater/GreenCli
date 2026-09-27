import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from './sessionStore';
import type { ConnectionConfig, Session } from '../types';

const saved: ConnectionConfig = {
  id: 'saved-core',
  name: 'core-sw-01',
  protocol: 'ssh',
  host: '10.1.1.1',
  deviceType: 'generic',
};

const tab = (sessionId: string, extra: Partial<ConnectionConfig> = {}): Session => ({
  sessionId,
  connected: true,
  connectionStatus: 'connected',
  config: { ...saved, id: sessionId, savedId: 'saved-core', ...extra },
});

const st = () => useSessionStore.getState();
const tabOf = (id: string) => st().sessions.find((s) => s.sessionId === id)!;

beforeEach(() => {
  useSessionStore.setState({
    sessions: [
      tab('t1'),
      tab('t2', { copyNumber: 2, tabName: 'uplink work' }),
      // A tab restored from an older workspace: its id IS the saved id.
      { ...tab('saved-core'), config: { ...saved } },
      { ...tab('other'), config: { ...saved, id: 'other', savedId: 'saved-edge', name: 'edge' } },
    ],
    folders: [{ id: 'default', name: 'Sessions', expanded: true, items: [saved] }],
    activeSessionId: 't1',
  });
});

describe('two tabs to one saved host', () => {
  it('addSession keeps a second tab of the same host', () => {
    st().addSession({ ...saved, id: 't3', savedId: 'saved-core', copyNumber: 3 }, 't3');
    expect(st().sessions.map((s) => s.sessionId)).toContain('t3');
    expect(st().activeSessionId).toBe('t3');
  });

  it('updateSessionConfig changes only that tab — not the saved host', () => {
    st().updateSessionConfig('saved-core', { username: 'typed' });
    expect(tabOf('saved-core').config.username).toBe('typed');
    expect(st().folders[0].items[0].username).toBeUndefined();
    expect(tabOf('t1').config.username).toBeUndefined();
  });

  it('updateSessionConfig never changes the tab id', () => {
    st().updateSessionConfig('t1', { id: 'saved-core', tabName: 'mine' });
    expect(tabOf('t1').config).toMatchObject({ id: 't1', tabName: 'mine' });
  });

  it('updateSavedHost updates the sidebar item and every tab of the host', () => {
    st().updateSavedHost('saved-core', { id: 'saved-core', host: '10.1.1.2', deviceType: 'aruba-cx' });
    expect(st().folders[0].items[0]).toMatchObject({ id: 'saved-core', host: '10.1.1.2' });
    for (const id of ['t1', 't2', 'saved-core']) {
      expect(tabOf(id).config).toMatchObject({ id, host: '10.1.1.2', deviceType: 'aruba-cx' });
    }
    // Tab-only fields and other hosts' tabs are left alone.
    expect(tabOf('t2').config).toMatchObject({ copyNumber: 2, tabName: 'uplink work' });
    expect(tabOf('other').config.host).toBe('10.1.1.1');
  });
});

describe('prompt state', () => {
  it('records the prompt hostname and mode', () => {
    st().setPromptState('t1', { host: 'core-sw-01', configMode: true });
    expect(tabOf('t1')).toMatchObject({ promptHost: 'core-sw-01', configMode: true });
  });

  it('leaves the store untouched when nothing changed (no re-render per flush)', () => {
    st().setPromptState('t1', { host: 'core-sw-01', configMode: false });
    const before = st().sessions;
    st().setPromptState('t1', { host: 'core-sw-01', configMode: false });
    expect(st().sessions).toBe(before);
  });

  it('ignores local shells', () => {
    useSessionStore.setState({
      sessions: [{ ...tab('sh'), config: { id: 'sh', name: 'Local Shell', protocol: 'local', deviceType: 'generic' } }],
    });
    const before = st().sessions;
    st().setPromptState('sh', { host: 'mac', configMode: false });
    expect(st().sessions).toBe(before);
  });

  it('drops the CONFIG state when the session disconnects, keeping the hostname', () => {
    st().setPromptState('t1', { host: 'core-sw-01', configMode: true });
    st().updateSessionConnection('t1', false, 'disconnected');
    expect(tabOf('t1')).toMatchObject({ promptHost: 'core-sw-01', configMode: false });
  });
});
