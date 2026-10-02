import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const hideSecretsInText = vi.fn();
vi.mock('./secrets/forCopy', () => ({ hideSecretsInText: (text: string) => hideSecretsInText(text) }));

vi.mock('./terminal', () => ({
  sendAndCapture: vi.fn(async () => ({ output: 'hostname sw1\npassword secret1\n', truncated: false })),
}));
vi.mock('./paging', () => ({
  pagedCommand: (_p: unknown, cmd: string) => cmd,
  withPagingDisabled: async (_sid: string, _p: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./deviceProfiles', () => ({ profileForSession: () => ({ deviceType: 'aruba-cx' }) }));
vi.mock('../store/settingsStore', () => ({ useSettingsStore: { getState: () => ({ customDeviceProfiles: [] }) } }));
vi.mock('../store/toastStore', () => ({ notify: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
const app = vi.hoisted(() => ({ isTauri: true }));
vi.mock('./tauri', () => ({
  get isTauri() {
    return app.isTauri;
  },
}));

import type { Session } from '../types';
import {
  captureRunningConfig,
  HIDDEN_COPY_FILTER,
  makeHiddenCopies,
  refreshHiddenCopiesAtStart,
  refreshStaleHiddenCopies,
  resetHiddenRefreshForTests,
} from './configArchive';

const session = { sessionId: 'sid-1', connected: true, config: { name: 'sw1', host: '10.0.0.1', protocol: 'ssh' } } as unknown as Session;

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invoke.mockReset();
  hideSecretsInText.mockReset();
  resetHiddenRefreshForTests();
  app.isTauri = true;
});

describe('captureRunningConfig hidden copy', () => {
  it('sends the hidden copy and the filter version', async () => {
    hideSecretsInText.mockResolvedValue({ ok: true, text: 'hostname sw1\npassword <hidden>\n', hidden: 1, words: [] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'config_archive_capture') return { ts: 42 };
      if (cmd === 'config_archive_missing_hidden') return { missing: 0, stale: 0, current: 1, todo: [] };
      throw new Error(cmd);
    });
    const got = await captureRunningConfig(session, 'manual');
    expect(got).toEqual({ content: 'hostname sw1\npassword secret1\n', truncated: false, ts: 42 });
    expect(invoke).toHaveBeenCalledWith('config_archive_capture', {
      device: 'sw1',
      source: 'manual',
      content: 'hostname sw1\npassword secret1\n',
      hidden: 'hostname sw1\npassword <hidden>\n',
      filter: HIDDEN_COPY_FILTER,
    });
  });

  it('sends hidden: null when the filter fails, and still captures', async () => {
    hideSecretsInText.mockResolvedValue({ ok: false, reason: 'unsupported' });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'config_archive_capture') return { ts: 7 };
      return { missing: 0, stale: 0, current: 0, todo: [] };
    });
    const got = await captureRunningConfig(session, 'connect');
    expect(got?.ts).toBe(7);
    const args = invoke.mock.calls.find((c) => c[0] === 'config_archive_capture')?.[1];
    expect(args.hidden).toBeNull();
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('<hidden>');
  });
});

describe('makeHiddenCopies', () => {
  it('skips failures and makes the rest, stale ones included', async () => {
    const todo = [
      { device: 'sw1', ts: 1 },
      { device: 'sw1', ts: 2 },
      { device: 'sw2', ts: 3 },
      { device: 'sw2', ts: 4 },
    ];
    const saved: unknown[] = [];
    invoke.mockImplementation(async (cmd: string, args: { device: string; ts: number }) => {
      if (cmd === 'config_archive_missing_hidden') return { missing: 2, stale: 2, current: 0, todo };
      if (cmd === 'config_archive_get') {
        if (args.ts === 2) throw new Error('gone');
        return `raw-${args.ts}`;
      }
      if (cmd === 'config_archive_set_hidden') {
        saved.push(args);
        return null;
      }
      throw new Error(cmd);
    });
    hideSecretsInText.mockImplementation(async (text: string) =>
      text === 'raw-3' ? { ok: false, reason: 'too-big' } : { ok: true, text: `hidden-${text}`, hidden: 0, words: [] }
    );
    const result = await makeHiddenCopies();
    expect(result).toEqual({ made: 2, failed: 2, left: 0 });
    expect(saved).toEqual([
      { device: 'sw1', ts: 1, hidden: 'hidden-raw-1', filter: HIDDEN_COPY_FILTER },
      { device: 'sw2', ts: 4, hidden: 'hidden-raw-4', filter: HIDDEN_COPY_FILTER },
    ]);
  });

  it('stops at the limit', async () => {
    const todo = [1, 2, 3].map((ts) => ({ device: 'sw1', ts }));
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'config_archive_missing_hidden') return { missing: 3, stale: 0, current: 0, todo };
      if (cmd === 'config_archive_get') return 'raw';
      return null;
    });
    hideSecretsInText.mockResolvedValue({ ok: true, text: 'h', hidden: 0, words: [] });
    expect(await makeHiddenCopies({ limit: 2 })).toEqual({ made: 2, failed: 0, left: 1 });
  });
});

describe('refreshStaleHiddenCopies', () => {
  it('runs once, and only when some copies are stale', async () => {
    invoke.mockResolvedValue({ missing: 5, stale: 0, current: 0, todo: [] });
    refreshStaleHiddenCopies();
    refreshStaleHiddenCopies();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('config_archive_missing_hidden');
  });

  it('redoes stale copies in the background', async () => {
    const todo = [{ device: 'sw1', ts: 9 }];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'config_archive_missing_hidden') return { missing: 0, stale: 1, current: 0, todo };
      if (cmd === 'config_archive_get') return 'raw';
      return null;
    });
    hideSecretsInText.mockResolvedValue({ ok: true, text: 'h', hidden: 0, words: [] });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    refreshStaleHiddenCopies();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('config_archive_set_hidden', { device: 'sw1', ts: 9, hidden: 'h', filter: HIDDEN_COPY_FILTER }));
    await vi.waitFor(() => expect(info).toHaveBeenCalled());
    info.mockRestore();
  });

  it('every call gets the same promise, which ends when the run is done', async () => {
    invoke.mockResolvedValue({ missing: 0, stale: 0, current: 0, todo: [] });
    const run = refreshStaleHiddenCopies();
    expect(refreshStaleHiddenCopies()).toBe(run);
    await expect(run).resolves.toBeUndefined();
    expect(refreshStaleHiddenCopies()).toBe(run);
  });

  it('never throws outside the app', async () => {
    invoke.mockRejectedValue(new Error('no IPC'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(refreshStaleHiddenCopies()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('refreshHiddenCopiesAtStart', () => {
  it('checks the hidden copies once at start, and later calls share that run', async () => {
    invoke.mockResolvedValue({ missing: 0, stale: 0, current: 3, todo: [] });
    refreshHiddenCopiesAtStart();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('config_archive_missing_hidden');
    await refreshStaleHiddenCopies();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside the app', async () => {
    app.isTauri = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    refreshHiddenCopiesAtStart();
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
