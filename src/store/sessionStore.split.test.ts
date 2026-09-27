import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from './sessionStore';
import type { ConnectionConfig } from '../types';

const cfg = (id: string): ConnectionConfig => ({ id, name: id, protocol: 'ssh', host: id, deviceType: 'generic' });

// Open tabs a..d with `active` focused and split view off.
function openTabs(ids: string[], active: string) {
  useSessionStore.setState({
    sessions: ids.map((id) => ({ config: cfg(id), sessionId: id, connected: true })),
    activeSessionId: active,
    splitView: false,
    splitPanes: [],
    poppedSessions: [],
    unseenOutput: [],
  });
}

const st = () => useSessionStore.getState();

describe('split view focus', () => {
  beforeEach(() => openTabs(['a', 'b', 'c', 'd'], 'a'));

  it('starts with the active session in the first column', () => {
    st().toggleSplitView();
    expect(st().splitView).toBe(true);
    expect(st().splitPanes).toEqual(['a', 'b']);
  });

  it('focusing another pane makes it active without reordering the columns', () => {
    st().toggleSplitView();
    st().addSplitPane();
    expect(st().splitPanes).toEqual(['a', 'b', 'c']);
    st().setActiveSession('c');
    expect(st().activeSessionId).toBe('c');
    expect(st().splitPanes).toEqual(['a', 'b', 'c']);
  });

  it('picking a tab without a pane shows it in the focused pane', () => {
    st().toggleSplitView();
    st().setActiveSession('b');
    st().setActiveSession('d');
    expect(st().splitPanes).toEqual(['a', 'd']);
    expect(st().activeSessionId).toBe('d');
  });

  it('closing the focused pane session focuses its neighbour and exits split when one pane is left', () => {
    st().toggleSplitView();
    st().addSplitPane(); // a b c
    st().setActiveSession('b');
    st().removeSession('b');
    expect(st().splitPanes).toEqual(['a', 'c']);
    expect(st().activeSessionId).toBe('c');
    st().removeSession('c');
    expect(st().splitView).toBe(false);
    expect(st().activeSessionId).toBe('a');
  });

  it('closing a pane keeps its session as a tab', () => {
    st().toggleSplitView();
    st().setActiveSession('b');
    st().removeSplitPane('b');
    expect(st().splitView).toBe(false);
    expect(st().activeSessionId).toBe('a');
    expect(st().sessions.map((s) => s.sessionId)).toContain('b');
  });

  it('popping out the focused pane hands focus to another pane', () => {
    st().toggleSplitView();
    st().addSplitPane(); // a b c
    st().setActiveSession('c');
    st().markPoppedOut('c');
    expect(st().splitPanes).toEqual(['a', 'b']);
    expect(st().activeSessionId).toBe('b');
  });
});

describe('setActiveSession', () => {
  beforeEach(() => openTabs(['a', 'b'], 'a'));

  it('ignores a popped-out session (it lives in its own window)', () => {
    st().markPoppedOut('b');
    st().setActiveSession('b');
    expect(st().activeSessionId).toBe('a');
  });
});
