import { describe, expect, it } from 'vitest';
import { cannotOpen, joinPath, relativeTo, visibleRows, type FolderEntry } from './folderTree';

const entries: FolderEntry[] = [
  { path: 'playbooks', isDir: true, size: 0 },
  { path: 'playbooks/roles', isDir: true, size: 0 },
  { path: 'playbooks/roles/vlans.yml', isDir: false, size: 10 },
  { path: 'playbooks/site.yml', isDir: false, size: 10 },
  { path: 'core-sw1.cfg', isDir: false, size: 10 },
];

describe('visibleRows', () => {
  it('shows only the children of open folders, with their depth', () => {
    expect(visibleRows(entries, new Set()).map((r) => r.path)).toEqual(['playbooks', 'core-sw1.cfg']);
    expect(visibleRows(entries, new Set(['playbooks'])).map((r) => [r.name, r.depth])).toEqual([
      ['playbooks', 0],
      ['roles', 1],
      ['site.yml', 1],
      ['core-sw1.cfg', 0],
    ]);
  });

  it('with a filter, shows matching files and the folders on their way', () => {
    expect(visibleRows(entries, new Set(), 'VLAN').map((r) => r.path)).toEqual([
      'playbooks',
      'playbooks/roles',
      'playbooks/roles/vlans.yml',
    ]);
  });
});

describe('joinPath', () => {
  it('uses the root\'s own separator', () => {
    expect(joinPath('/Users/me/net/', 'playbooks/site.yml')).toBe('/Users/me/net/playbooks/site.yml');
    expect(joinPath('C:\\net', 'playbooks/site.yml')).toBe('C:\\net\\playbooks\\site.yml');
  });
});

describe('cannotOpen', () => {
  it('refuses binaries and very big files', () => {
    expect(cannotOpen({ path: 'diagram.png', isDir: false, size: 1 })).toBe('Not a text file');
    expect(cannotOpen({ path: 'huge.log', isDir: false, size: 6 * 1024 * 1024 })).toMatch(/Too big/);
    expect(cannotOpen({ path: 'site.yml', isDir: false, size: 1 })).toBeNull();
  });
});

describe('relativeTo', () => {
  it('gives the path from the folder, and null outside it', () => {
    expect(relativeTo('/home/me/net', '/home/me/net/configs/sw1.cfg')).toBe('configs/sw1.cfg');
    expect(relativeTo('C:\\net', 'C:\\net\\configs\\sw1.cfg')).toBe('configs/sw1.cfg');
    expect(relativeTo('/home/me/net', '/home/me/network/x.cfg')).toBeNull();
    expect(relativeTo('/home/me/net', null)).toBeNull();
  });
});
