import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('./tauri', () => ({ isTauri: true }));
const askConfirm = vi.hoisted(() => vi.fn());
vi.mock('../store/dialogStore', () => ({ askConfirm }));

import {
  DAY_MS,
  UPDATE_TEXT,
  dailyCheckDue,
  dailyCheckOn,
  dailyUpdateCheck,
  lastCheckAt,
  offText,
  recordCheck,
  restartToUpdate,
  setDailyCheck,
  updateErrorText,
  type UpdateStatus,
} from './updates';
import { holdExit, registerBeforeExit } from './beforeExit';
import { useToastStore } from '../store/toastStore';
import { useSessionStore } from '../store/sessionStore';
import { useSidePanelStore } from '../store/sidePanelStore';

const ON: UpdateStatus = { version: '2.0.0', enabled: true, reason: null, place: 'normal', ready: null };
const NOW = 1_800_000_000_000;

/** invoke mock answering update_status / update_check / update_install. */
function answer(map: Record<string, unknown>) {
  invoke.mockImplementation(async (cmd: string) => {
    const v = map[cmd];
    if (v instanceof Error) throw v.message;
    return v;
  });
}

const calls = () => invoke.mock.calls.map((c) => c[0]);
const toasts = () => useToastStore.getState().toasts;

describe('update helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is due a day after the last check, when never checked, or when the clock went back', () => {
    expect(dailyCheckDue(NOW, null)).toBe(true);
    expect(dailyCheckDue(NOW, NOW - DAY_MS)).toBe(true);
    expect(dailyCheckDue(NOW, NOW - DAY_MS + 1)).toBe(false);
    expect(dailyCheckDue(NOW, NOW - 60_000)).toBe(false);
    expect(dailyCheckDue(NOW, NOW + 60_000)).toBe(true);
  });

  it('keeps the last check and the daily option in localStorage', () => {
    expect(lastCheckAt()).toBeNull();
    recordCheck(NOW);
    expect(lastCheckAt()).toBe(NOW);
    expect(dailyCheckOn()).toBe(true);
    setDailyCheck(false);
    expect(dailyCheckOn()).toBe(false);
    setDailyCheck(true);
    expect(dailyCheckOn()).toBe(true);
  });

  it('says why updates are off', () => {
    expect(offText(ON)).toBeNull();
    expect(offText({ ...ON, enabled: false, reason: 'dev' })).toBe(UPDATE_TEXT.offDev);
    expect(offText({ ...ON, enabled: false, reason: 'platform' })).toBe(UPDATE_TEXT.off);
    expect(offText(null)).toBe(UPDATE_TEXT.off);
  });

  it('shows the short Rust error, or the plain fallback', () => {
    expect(updateErrorText("The update didn't pass its signature check.")).toBe(
      "The update didn't pass its signature check.",
    );
    expect(updateErrorText(new Error('x'))).toBe(UPDATE_TEXT.checkFailed);
    expect(updateErrorText('')).toBe(UPDATE_TEXT.checkFailed);
  });
});

describe('dailyUpdateCheck', () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    useToastStore.getState().clear();
  });

  it('makes no call when the daily check is off', async () => {
    setDailyCheck(false);
    answer({ update_status: ON, update_check: '2.0.1' });
    await dailyUpdateCheck(NOW);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('makes no call when the last check was under a day ago', async () => {
    recordCheck(NOW - DAY_MS + 60_000);
    answer({ update_status: ON, update_check: '2.0.1' });
    await dailyUpdateCheck(NOW);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('never checks when updates are off', async () => {
    answer({ update_status: { ...ON, enabled: false, reason: 'platform' } });
    await dailyUpdateCheck(NOW);
    expect(calls()).toEqual(['update_status']);
    expect(lastCheckAt()).toBeNull();
  });

  it('shows a sticky toast with Restart to update when a version is ready', async () => {
    answer({ update_status: ON, update_check: '2.0.1' });
    await dailyUpdateCheck(NOW);
    expect(calls()).toEqual(['update_status', 'update_check']);
    expect(lastCheckAt()).toBe(NOW);
    const [t] = toasts();
    expect(t.title).toBe('GreenCLI 2.0.1 is ready.');
    expect(t.duration).toBe(0);
    expect(t.action?.label).toBe('Restart to update');
  });

  it('stays quiet with no update', async () => {
    answer({ update_status: ON, update_check: null });
    await dailyUpdateCheck(NOW);
    expect(toasts()).toEqual([]);
  });

  it('only logs errors, and waits a day before trying again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer({ update_status: ON, update_check: new Error(UPDATE_TEXT.checkFailed) });
    await expect(dailyUpdateCheck(NOW)).resolves.toBeUndefined();
    expect(toasts()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    invoke.mockClear();
    await dailyUpdateCheck(NOW + 60_000);
    expect(invoke).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('restartToUpdate', () => {
  beforeEach(() => {
    invoke.mockReset();
    askConfirm.mockReset();
    useToastStore.getState().clear();
    useSidePanelStore.getState().setStatus('editor', null);
    useSessionStore.setState({ sessions: [] });
  });

  it('confirms with the open session count, saves, then installs', async () => {
    const order: string[] = [];
    useSessionStore.setState({ sessions: [{ sessionId: 'a' }, { sessionId: 'b' }] as never });
    const off = registerBeforeExit(async () => {
      order.push('save');
    });
    askConfirm.mockImplementation(async () => {
      order.push('confirm');
      return true;
    });
    invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
    });
    await expect(restartToUpdate('2.0.1')).resolves.toBe(true);
    off();
    expect(order).toEqual(['confirm', 'save', 'update_install']);
    const opts = askConfirm.mock.calls[0][0];
    expect(opts.title).toBe('Restart now?');
    expect(opts.message).toContain('2 open sessions will close.');
    expect(opts.message).not.toContain(UPDATE_TEXT.dirtyEditor);
    expect(opts.confirmLabel).toBe('Restart to update');
  });

  it('warns about unsaved editor edits, and does nothing on No', async () => {
    useSessionStore.setState({ sessions: [{ sessionId: 'a' }] as never });
    useSidePanelStore.getState().setStatus('editor', 'dirty');
    const save = vi.fn();
    const off = registerBeforeExit(save);
    askConfirm.mockResolvedValue(false);
    await expect(restartToUpdate('2.0.1')).resolves.toBe(false);
    off();
    const opts = askConfirm.mock.calls[0][0];
    expect(opts.message).toContain('1 open session will close.');
    expect(opts.message).toContain('The config editor has unsaved edits. They will be lost.');
    expect(opts.danger).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses while a Change Job or bulk run is going', async () => {
    const release = holdExit('A Change Job is running.');
    await expect(restartToUpdate('2.0.1')).resolves.toBe(false);
    release();
    expect(askConfirm).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(toasts()[0].message).toContain('A Change Job is running.');
  });

  it('shows the error when installing fails', async () => {
    askConfirm.mockResolvedValue(true);
    invoke.mockRejectedValue('Move GreenCLI to Applications, then try again.');
    await expect(restartToUpdate('2.0.1')).resolves.toBe(false);
    expect(toasts()[0].message).toBe('Move GreenCLI to Applications, then try again.');
  });
});
