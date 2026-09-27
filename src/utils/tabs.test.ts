import { describe, it, expect } from 'vitest';
import type { ConnectionConfig, Session } from '../types';
import {
  findHostTab,
  isAddressName,
  nextCopyNumber,
  savedHostId,
  tabConfigForOpen,
  tabLabel,
  tabTooltipName,
  tabsOfHost,
} from './tabs';

const host: ConnectionConfig = {
  id: 'saved-core',
  name: 'core-sw-01',
  protocol: 'ssh',
  host: '10.1.1.1',
  username: 'admin',
  deviceType: 'aruba-cx',
};

const tab = (
  sessionId: string,
  extra: Partial<ConnectionConfig> = {},
  state: Partial<Session> = {},
): Session => ({
  sessionId,
  connected: true,
  connectionStatus: 'connected',
  config: { ...host, id: sessionId, savedId: 'saved-core', ...extra },
  ...state,
});

const down = { connected: false, connectionStatus: 'disconnected' as const };

describe('savedHostId', () => {
  it('uses savedId when the tab has one', () => {
    expect(savedHostId({ id: 'tab-1', savedId: 'saved-core' })).toBe('saved-core');
  });

  it('falls back to the id for tabs from older workspaces (tab id = saved id)', () => {
    expect(savedHostId({ id: 'saved-core' })).toBe('saved-core');
  });
});

describe('tabsOfHost / findHostTab', () => {
  const legacy: Session = { ...tab('saved-core'), config: { ...host } };
  const other: Session = { ...tab('x'), config: { ...host, id: 'x', savedId: 'saved-edge' } };

  it('groups new and legacy tabs of one host', () => {
    const sessions = [legacy, tab('t2'), other];
    expect(tabsOfHost(sessions, 'saved-core').map((s) => s.sessionId)).toEqual(['saved-core', 't2']);
  });

  it('prefers the active tab when it is live', () => {
    const sessions = [tab('t1'), tab('t2')];
    expect(findHostTab(sessions, 'saved-core', 't2')?.sessionId).toBe('t2');
  });

  it('prefers a live tab over the active dropped one', () => {
    const sessions = [tab('t1', {}, down), tab('t2', {}, { connected: false, connectionStatus: 'connecting' })];
    expect(findHostTab(sessions, 'saved-core', 't1')?.sessionId).toBe('t2');
  });

  it('falls back to a dropped tab (active first) to reconnect in place', () => {
    const sessions = [tab('t1', {}, down), tab('t2', {}, down)];
    expect(findHostTab(sessions, 'saved-core', 't2')?.sessionId).toBe('t2');
    expect(findHostTab(sessions, 'saved-core', 'x')?.sessionId).toBe('t1');
  });

  it('finds nothing for a host with no tabs', () => {
    expect(findHostTab([other], 'saved-core', 'x')).toBeUndefined();
  });
});

describe('nextCopyNumber', () => {
  it('leaves the first copy unnumbered', () => {
    expect(nextCopyNumber([])).toBeUndefined();
  });

  it('numbers the next copies from 2', () => {
    expect(nextCopyNumber([undefined])).toBe(2);
    expect(nextCopyNumber([undefined, 2])).toBe(3);
  });

  it('reuses the lowest free number', () => {
    expect(nextCopyNumber([undefined, 3])).toBe(2);
    expect(nextCopyNumber([2, 3])).toBeUndefined();
  });
});

describe('tabConfigForOpen', () => {
  it('opens a first tab with its own id, pointing back at the saved host', () => {
    const cfg = tabConfigForOpen([], host, { newId: 'new-1' });
    expect(cfg).toMatchObject({ id: 'new-1', savedId: 'saved-core', name: 'core-sw-01', host: '10.1.1.1' });
    expect(cfg.copyNumber).toBeUndefined();
  });

  it('reuses the open tab on a plain open, keeping its tab-only fields', () => {
    const sessions = [tab('t1', { copyNumber: 2, tabName: 'uplink work' })];
    const cfg = tabConfigForOpen(sessions, { ...host, username: 'ops' }, { newId: 'new-1' });
    expect(cfg).toMatchObject({ id: 't1', savedId: 'saved-core', copyNumber: 2, tabName: 'uplink work', username: 'ops' });
  });

  it("keeps a username typed at the tab's login prompt when the host has none", () => {
    const sessions = [tab('t1', { username: 'typed' }, down)];
    expect(tabConfigForOpen(sessions, { ...host, username: undefined }, { newId: 'n' }).username).toBe('typed');
    expect(tabConfigForOpen(sessions, host, { newId: 'n' }).username).toBe('admin');
  });

  it('always opens another tab with newTab, numbered as the next copy', () => {
    const sessions = [tab('t1', { tabName: 'mine' })];
    const cfg = tabConfigForOpen(sessions, host, { newTab: true, newId: 'new-2' });
    expect(cfg).toMatchObject({ id: 'new-2', savedId: 'saved-core', copyNumber: 2 });
    expect(cfg.tabName).toBeUndefined();
  });

  it('duplicates a tab (or a legacy tab) into the same host group', () => {
    const legacy: Session = { ...tab('saved-core'), config: { ...host } };
    const cfg = tabConfigForOpen([legacy], legacy.config, { newTab: true, newId: 'dup' });
    expect(cfg).toMatchObject({ id: 'dup', savedId: 'saved-core', copyNumber: 2 });
  });
});

describe('isAddressName', () => {
  it('is true for empty names and names that only repeat the address', () => {
    expect(isAddressName({ name: '' })).toBe(true);
    expect(isAddressName({ name: '10.1.1.1', host: '10.1.1.1' })).toBe(true);
    expect(isAddressName({ name: 'sw.example.net', host: 'sw.example.net' })).toBe(true);
    expect(isAddressName({ name: 'admin@10.1.1.1', host: '10.1.1.1', username: 'admin' })).toBe(true);
    expect(isAddressName({ name: '192.168.0.9', host: 'jump' })).toBe(true);
    expect(isAddressName({ name: 'fe80::1', host: 'fe80::1' })).toBe(true);
    expect(isAddressName({ name: '/dev/cu.usbserial-1', serialPort: '/dev/cu.usbserial-1' })).toBe(true);
  });

  it('is false for a real name', () => {
    expect(isAddressName({ name: 'core-sw-01', host: '10.1.1.1' })).toBe(false);
    expect(isAddressName({ name: 'Local Shell' })).toBe(false);
  });
});

describe('tabLabel', () => {
  it('shows the host name, numbered from the second copy', () => {
    expect(tabLabel(tab('t1'))).toBe('core-sw-01');
    expect(tabLabel(tab('t2', { copyNumber: 2 }))).toBe('core-sw-01 (2)');
  });

  it('shows the prompt hostname when the name is just the address', () => {
    const byIp = tab('t1', { name: '10.1.1.1' }, { promptHost: 'core-sw-01' });
    expect(tabLabel(byIp)).toBe('core-sw-01');
    expect(tabLabel({ ...byIp, config: { ...byIp.config, copyNumber: 3 } })).toBe('core-sw-01 (3)');
  });

  it('keeps a real name over the prompt hostname', () => {
    expect(tabLabel(tab('t1', { name: 'Core A' }, { promptHost: 'core-sw-01' }))).toBe('Core A');
  });

  it('lets Rename tab win over everything', () => {
    const renamed = tab('t1', { name: '10.1.1.1', tabName: 'uplink work', copyNumber: 2 }, { promptHost: 'core-sw-01' });
    expect(tabLabel(renamed)).toBe('uplink work');
  });

  it('falls back to the address, then "Session"', () => {
    expect(tabLabel({ config: { id: 'a', name: '', protocol: 'ssh', host: '10.9.9.9', deviceType: 'generic' } })).toBe('10.9.9.9');
    expect(tabLabel({ config: { id: 'a', name: '', protocol: 'ssh', deviceType: 'generic' } })).toBe('Session');
  });
});

describe('tabTooltipName', () => {
  it('adds the address and detected hostname the label leaves out', () => {
    expect(tabTooltipName(tab('t1', { name: '10.1.1.1' }, { promptHost: 'core-sw-01' }))).toBe('core-sw-01 · 10.1.1.1');
    expect(tabTooltipName(tab('t1', { tabName: 'uplink work' }, { promptHost: 'core-sw-01' }))).toBe(
      'uplink work · core-sw-01 · 10.1.1.1',
    );
  });

  it("doesn't repeat what the label already says", () => {
    expect(tabTooltipName(tab('t1', { name: '10.1.1.1' }))).toBe('10.1.1.1');
  });
});
