import { describe, it, expect } from 'vitest';
import { Session } from '../types';
import {
  configModeSummary,
  isMultiSendTarget,
  multiSendTargetSessions,
  pushHistory,
  stepHistory,
} from './multiSend';

const session = (sessionId: string, connected = true): Session => ({
  sessionId,
  connected,
  config: { id: sessionId, name: sessionId, protocol: 'ssh', deviceType: 'aruba-cx' },
});

describe('multi-send targets', () => {
  const sessions = [session('a'), session('b'), session('c', false)];

  it('"all" means every CONNECTED session', () => {
    expect(multiSendTargetSessions(sessions, { mode: 'all', ids: [] }).map((s) => s.sessionId)).toEqual(['a', 'b']);
  });

  it('"selected" means only the chosen, connected sessions', () => {
    const t = { mode: 'selected' as const, ids: ['b', 'c'] };
    expect(multiSendTargetSessions(sessions, t).map((s) => s.sessionId)).toEqual(['b']);
    expect(isMultiSendTarget(sessions[0], t)).toBe(false);
    expect(isMultiSendTarget(sessions[2], t)).toBe(false);
  });
});

describe('pushHistory', () => {
  it('skips blanks and immediate repeats, keeps the newest max', () => {
    let h: string[] = [];
    h = pushHistory(h, 'show version');
    h = pushHistory(h, 'show version');
    h = pushHistory(h, '   ');
    h = pushHistory(h, 'show vlan');
    expect(h).toEqual(['show version', 'show vlan']);
    expect(pushHistory(['1', '2', '3'], '4', 3)).toEqual(['2', '3', '4']);
  });
});

describe('stepHistory', () => {
  const h = ['one', 'two', 'three'];

  it('walks back with Up and stops at the oldest', () => {
    expect(stepHistory(h, null, 'up')).toBe(2);
    expect(stepHistory(h, 2, 'up')).toBe(1);
    expect(stepHistory(h, 0, 'up')).toBe(0);
  });

  it('walks forward with Down and returns to the typed line past the newest', () => {
    expect(stepHistory(h, 1, 'down')).toBe(2);
    expect(stepHistory(h, 2, 'down')).toBeNull();
    expect(stepHistory(h, null, 'down')).toBeNull();
  });

  it('does nothing with an empty history', () => {
    expect(stepHistory([], null, 'up')).toBeNull();
  });
});

describe('configModeSummary', () => {
  const inConfig = (id: string): Session => ({ ...session(id), configMode: true });

  it('says nothing when no target is in config mode', () => {
    expect(configModeSummary([])).toBeNull();
    expect(configModeSummary([session('a'), session('b')])).toBeNull();
  });

  it('counts the targets in config mode', () => {
    const targets = [inConfig('a'), inConfig('b'), session('c'), session('d'), session('e')];
    expect(configModeSummary(targets)).toBe('2 of 5 targets in config mode');
  });

  it('reads naturally for one target or all of them', () => {
    expect(configModeSummary([inConfig('a')])).toBe('Target is in config mode');
    expect(configModeSummary([inConfig('a'), inConfig('b')])).toBe('All 2 targets in config mode');
  });
});
