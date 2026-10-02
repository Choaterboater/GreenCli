import { describe, it, expect, vi } from 'vitest';
import { exitHolds, holdExit, registerBeforeExit, runBeforeExit } from './beforeExit';

describe('beforeExit', () => {
  it('runs every handler, waits for async ones, and keeps going past errors', async () => {
    const order: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const offs = [
      registerBeforeExit(async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('slow');
      }),
      registerBeforeExit(() => {
        throw new Error('boom');
      }),
      registerBeforeExit(() => Promise.reject(new Error('nope'))),
      registerBeforeExit(() => {
        order.push('sync');
      }),
    ];
    await runBeforeExit();
    expect(order.sort()).toEqual(['slow', 'sync']);
    expect(warn).toHaveBeenCalledTimes(2);
    offs.forEach((off) => off());
    warn.mockRestore();
  });

  it('stops running a handler once it is removed', async () => {
    const fn = vi.fn();
    const off = registerBeforeExit(fn);
    off();
    await runBeforeExit();
    expect(fn).not.toHaveBeenCalled();
  });

  it('lists what holds the exit until each lets go', () => {
    expect(exitHolds()).toEqual([]);
    const a = holdExit('A Change Job is running.');
    const b = holdExit('A bulk run is running.');
    const c = holdExit('A bulk run is running.');
    expect(exitHolds()).toEqual(['A Change Job is running.', 'A bulk run is running.']);
    a();
    b();
    expect(exitHolds()).toEqual(['A bulk run is running.']);
    c();
    c();
    expect(exitHolds()).toEqual([]);
  });
});
