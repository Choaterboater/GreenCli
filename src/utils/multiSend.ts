// Multi-send bar helpers: who receives a send, and the in-memory history of
// what was sent (Up/Down recall, like a shell).

import { Session } from '../types';

export interface MultiSendTargets {
  mode: 'all' | 'selected';
  ids: string[];
}

/** True when `s` would receive the next multi-send: connected, and either
 *  every session is targeted or `s` is in the selection. */
export function isMultiSendTarget(s: Session, t: MultiSendTargets): boolean {
  return s.connected && (t.mode === 'all' || t.ids.includes(s.sessionId));
}

/** The connected sessions the next multi-send goes to, in tab order. */
export function multiSendTargetSessions(sessions: Session[], t: MultiSendTargets): Session[] {
  return sessions.filter((s) => isMultiSendTarget(s, t));
}

export const SEND_HISTORY_MAX = 50;

/** Append a sent command, skipping blanks and an immediate repeat; keeps the newest `max`. */
export function pushHistory(history: string[], entry: string, max = SEND_HISTORY_MAX): string[] {
  if (!entry.trim() || history[history.length - 1] === entry) return history;
  return [...history, entry].slice(-max);
}

/**
 * Move through `history` (oldest first) from `pos`, where null means "the
 * line being typed". Up walks back and stops at the oldest; Down walks
 * forward and returns null past the newest (back to the typed line).
 */
export function stepHistory(history: string[], pos: number | null, dir: 'up' | 'down'): number | null {
  if (dir === 'up') {
    if (history.length === 0) return pos;
    return pos === null ? history.length - 1 : Math.max(0, pos - 1);
  }
  if (pos === null || pos >= history.length - 1) return null;
  return pos + 1;
}
