import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { DeviceProfile, DeviceType } from '../types';
import { profileForDeviceType } from './deviceProfiles';
import { endsAtPager, pagedCommand, pagerQuitKey, pagingCommands, withPagingDisabled } from './paging';

const mockInvoke = vi.mocked(invoke);
const builtin = (t: DeviceType) => profileForDeviceType(t);

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

describe('pagingCommands', () => {
  it('uses each vendor’s paging toggle', () => {
    expect(pagingCommands(builtin('aruba-cx'))).toEqual({ disable: 'no page', restore: 'page' });
    expect(pagingCommands(builtin('aruba-aos-s'))).toEqual({ disable: 'no page', restore: 'page' });
    expect(pagingCommands(builtin('aruba-controller'))).toEqual({ disable: 'no paging', restore: 'paging' });
    expect(pagingCommands(builtin('juniper-junos'))).toEqual({ disable: undefined, restore: undefined });
    expect(pagingCommands(builtin('generic'))).toEqual({ disable: undefined, restore: undefined });
  });

  it('falls back to the vendor default for a custom profile without overrides', () => {
    const custom: DeviceProfile = { ...builtin('aruba-cx'), id: 'custom-cx', pagingDisableCommand: undefined, pagingRestoreCommand: undefined };
    expect(pagingCommands(custom)).toEqual({ disable: 'no page', restore: 'page' });
    const blank: DeviceProfile = { ...custom, pagingDisableCommand: '', pagingRestoreCommand: '' };
    expect(pagingCommands(blank)).toEqual({ disable: '', restore: '' });
  });
});

describe('pagedCommand', () => {
  it('pipes Junos/Mist show commands through no-more once', () => {
    expect(pagedCommand(builtin('juniper-junos'), 'show interfaces terse')).toBe('show interfaces terse | no-more');
    expect(pagedCommand(builtin('mist'), 'show version')).toBe('show version | no-more');
    expect(pagedCommand(builtin('juniper-junos'), 'show configuration | no-more')).toBe('show configuration | no-more');
    expect(pagedCommand(builtin('juniper-junos'), 'request system alarms')).toBe('request system alarms');
  });

  it('leaves other vendors alone', () => {
    expect(pagedCommand(builtin('aruba-cx'), 'show running-config')).toBe('show running-config');
  });
});

describe('withPagingDisabled', () => {
  it('disables paging, runs, then restores', async () => {
    const sent: string[] = [];
    mockInvoke.mockImplementation((_cmd: string, args?: unknown) => {
      sent.push((args as { data: string }).data);
      return Promise.resolve(undefined);
    });
    const result = await withPagingDisabled('s1', builtin('aruba-cx'), async () => {
      sent.push('<run>');
      return 42;
    });
    expect(result).toBe(42);
    expect(sent).toEqual(['no page\r', '<run>', 'page\r']);
  });

  it('still restores paging when the capture throws', async () => {
    const sent: string[] = [];
    mockInvoke.mockImplementation((_cmd: string, args?: unknown) => {
      sent.push((args as { data: string }).data);
      return Promise.resolve(undefined);
    });
    await expect(
      withPagingDisabled('s1', builtin('aruba-controller'), () => Promise.reject(new Error('gone')))
    ).rejects.toThrow('gone');
    expect(sent).toEqual(['no paging\r', 'paging\r']);
  });

  it('sends nothing extra for vendors without a paging toggle', async () => {
    await withPagingDisabled('s1', builtin('juniper-junos'), async () => 'ok');
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('pager prompts', () => {
  it('detects a trailing pager prompt per vendor', () => {
    expect(endsAtPager('line\n-- MORE --, next page: Space, next line: Enter, quit: Control-C')).toBe(true);
    expect(endsAtPager('line\n---(more 42%)---')).toBe(true);
    expect(endsAtPager('line\n--More-- (q) Quit (space/n) Next page')).toBe(true);
    expect(endsAtPager('line\nswitch#')).toBe(false);
  });

  it('ignores a "--more" far from the end of the output', () => {
    expect(endsAtPager(`--More--\n${'x'.repeat(200)}\nswitch#`)).toBe(false);
  });

  it('quits with Ctrl+C where the prompt asks for it, q otherwise', () => {
    expect(pagerQuitKey('-- MORE --, next page: Space, next line: Enter, quit: Control-C')).toBe('\x03');
    expect(pagerQuitKey('---(more)---')).toBe('q');
    expect(pagerQuitKey('--More-- (q) Quit')).toBe('q');
  });
});
