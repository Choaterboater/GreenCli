import { describe, it, expect } from 'vitest';
import {
  describeLoginUsage,
  effectiveLogin,
  loginChoiceFor,
  savedHostOf,
  loginSecretKey,
  loginUsage,
  PER_HOST_PASSWORD,
  withoutLogin,
} from './logins';
import { ConnectionConfig, LoginProfile, SessionFolder } from '../types';

const TACACS: LoginProfile = { id: 'login-tacacs', name: 'TACACS admin', username: 'jdoe' };
const LAB: LoginProfile = { id: 'login-lab', name: 'Lab', username: 'labadmin' };
const PROFILES = [TACACS, LAB];

const host = (id: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name: id,
  protocol: 'ssh',
  host: `${id}.corp`,
  deviceType: 'aruba-cx',
  ...extra,
});

const folders: SessionFolder[] = [
  {
    id: 'core',
    name: 'Core',
    expanded: true,
    loginProfileId: TACACS.id,
    items: [
      host('core-sw1'),
      host('core-sw2', { loginProfileId: PER_HOST_PASSWORD }),
      host('core-sw3', { loginProfileId: LAB.id }),
      host('core-key', { authType: 'key' }),
    ],
  },
  {
    id: 'lab',
    name: 'Lab',
    expanded: true,
    items: [host('lab-sw1', { loginProfileId: TACACS.id }), host('lab-sw2', { jumpLoginProfileId: TACACS.id })],
  },
];

describe('effectiveLogin', () => {
  it("uses the host's own login, else its folder's default", () => {
    expect(effectiveLogin(host('a', { loginProfileId: LAB.id }), TACACS.id, PROFILES)).toEqual({
      profile: LAB,
      fromFolder: false,
    });
    expect(effectiveLogin(host('a'), TACACS.id, PROFILES)).toEqual({ profile: TACACS, fromFolder: true });
    expect(effectiveLogin(host('a'), undefined, PROFILES)).toBeUndefined();
  });

  it('"per-host password" opts out of the folder default', () => {
    expect(effectiveLogin(host('a', { loginProfileId: PER_HOST_PASSWORD }), TACACS.id, PROFILES)).toBeUndefined();
  });

  it('ignores a deleted login id (the folder default applies instead)', () => {
    expect(effectiveLogin(host('a', { loginProfileId: 'gone' }), TACACS.id, PROFILES)?.profile).toBe(TACACS);
    expect(effectiveLogin(host('a'), 'gone', PROFILES)).toBeUndefined();
  });

  it('only applies to SSH password logins', () => {
    for (const h of [
      host('a', { authType: 'key' }),
      host('a', { authType: 'agent' }),
      host('a', { protocol: 'telnet' }),
      host('a', { protocol: 'serial' }),
    ]) {
      expect(effectiveLogin(h, TACACS.id, PROFILES)).toBeUndefined();
    }
  });
});

describe('loginUsage', () => {
  it('lists folders and hosts that pick it, and counts every host that logs in with it', () => {
    expect(loginUsage(TACACS.id, folders, PROFILES)).toEqual({
      folders: ['Core'],
      hosts: ['lab-sw1', 'lab-sw2'],
      // core-sw1 (folder default) + lab-sw1 (own) + lab-sw2 (jump host).
      hostCount: 3,
    });
    expect(loginUsage(LAB.id, folders, PROFILES)).toEqual({
      folders: [],
      hosts: ['core-sw3'],
      hostCount: 1,
    });
    expect(loginUsage('unused', folders, PROFILES)).toEqual({ folders: [], hosts: [], hostCount: 0 });
  });
});

describe('withoutLogin', () => {
  it('drops every reference to a deleted login and nothing else', () => {
    const next = withoutLogin(folders, TACACS.id);
    expect(next[0].loginProfileId).toBeUndefined();
    expect(next[0].items.map((h) => h.loginProfileId)).toEqual([undefined, PER_HOST_PASSWORD, LAB.id, undefined]);
    expect(next[1].items[0].loginProfileId).toBeUndefined();
    expect(next[1].items[1].jumpLoginProfileId).toBeUndefined();
    // Untouched hosts keep their identity (no needless re-renders).
    expect(next[0].items[1]).toBe(folders[0].items[1]);
    // The input isn't mutated.
    expect(folders[0].loginProfileId).toBe(TACACS.id);
    expect(loginUsage(TACACS.id, next, PROFILES).hostCount).toBe(0);
  });
});

describe('savedHostOf / loginSecretKey', () => {
  it('finds the saved host (and folder) behind a sidebar item or a tab', () => {
    expect(savedHostOf(folders, { id: 'lab-sw2' })?.folder.id).toBe('lab');
    // A tab has its own session id and points at the saved host via savedId.
    const found = savedHostOf(folders, { id: 'tab-123', savedId: 'core-sw3' });
    expect(found?.folder.id).toBe('core');
    expect(found?.host.loginProfileId).toBe(LAB.id);
    expect(savedHostOf(folders, { id: 'ad-hoc' })).toBeUndefined();
  });

  it("reads a tab's login choice from its saved host, not the tab's copy", () => {
    // The tab still says TACACS, but the saved host was since switched to Lab.
    expect(loginChoiceFor(folders, { id: 'tab-9', savedId: 'core-sw3', loginProfileId: TACACS.id })).toEqual({
      loginProfileId: LAB.id,
      folderLoginProfileId: TACACS.id,
    });
    // An unsaved connect keeps its own choice and has no folder default.
    expect(loginChoiceFor(folders, { id: 'ad-hoc', loginProfileId: LAB.id })).toEqual({ loginProfileId: LAB.id });
  });

  it('keys login passwords apart from per-host ones', () => {
    expect(loginSecretKey(TACACS.id)).toBe('login:login-tacacs');
  });
});

describe('describeLoginUsage', () => {
  it('names the folders and hosts that lose the login', () => {
    const text = describeLoginUsage(loginUsage(TACACS.id, folders, PROFILES));
    expect(text).toContain('default login of folder Core.');
    expect(text).toContain('set directly on lab-sw1 and lab-sw2.');
    expect(text).toContain('3 saved hosts log in with it.');
  });

  it('shortens long host lists', () => {
    const hosts = Array.from({ length: 7 }, (_, i) => `sw${i + 1}`);
    const text = describeLoginUsage({ folders: [], hosts, hostCount: 7 });
    expect(text).toContain('set directly on sw1, sw2, sw3, sw4 and 3 more.');
  });

  it('says so when nothing uses it', () => {
    expect(describeLoginUsage({ folders: [], hosts: [], hostCount: 0 })).toMatch(/^No folders or hosts use it/);
  });
});
