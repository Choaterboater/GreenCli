import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from './sessionStore';
import type { ConnectionConfig } from '../types';

const cfg = (id: string): ConnectionConfig => ({ id, name: id, protocol: 'ssh', host: id, deviceType: 'generic' });
const st = () => useSessionStore.getState();

describe('multi-send targets follow closed tabs', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: ['sw1', 'sw2'].map((id) => ({ config: cfg(id), sessionId: id, connected: true })),
      activeSessionId: 'sw1',
      splitView: false,
      splitPanes: [],
      poppedSessions: [],
      unseenOutput: [],
      multiSendTargets: { mode: 'selected', ids: ['sw1', 'sw2'] },
    });
  });

  // Saved hosts reopen under the same id: a closed tab left in the selection
  // would silently receive the next multi-send when it came back.
  it('closing a tab drops it from the selection', () => {
    st().removeSession('sw2');
    expect(st().multiSendTargets).toEqual({ mode: 'selected', ids: ['sw1'] });
  });

  it('clearing all sessions empties the selection', () => {
    st().clearSessions();
    expect(st().multiSendTargets).toEqual({ mode: 'selected', ids: [] });
  });
});
