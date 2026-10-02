import { invoke } from '@tauri-apps/api/core';
import { closeWindow } from './tauri';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { askConfirm } from '../store/dialogStore';
import type { Session } from '../types';
import { tabLabel } from './tabs';

// The tab's own label — "core-sw-01 (2)" — so closing one of two sessions to
// a host says which.
const nameOf = (s: Session): string => tabLabel(s);

/** Confirm wording for closing `total` tabs, `live` of which are still connected. */
export function closeConfirmText(live: Session[], total: number): { title: string; message: string } {
  const hint = 'You can turn this question off in Settings → Terminal.';
  if (total === 1 && live.length === 1) {
    return {
      title: `Close ${nameOf(live[0])}?`,
      message: `This session is still connected. Closing the tab disconnects it. ${hint}`,
    };
  }
  const n = live.length;
  return {
    title: `Close ${total} session${total === 1 ? '' : 's'}?`,
    message: `${n} ${n === 1 ? 'is' : 'are'} still connected and will be disconnected. ${hint}`,
  };
}

/**
 * Close session tabs: disconnect the backend, close a pop-out window showing
 * one, and drop the tab. A still-CONNECTED session asks first (setting
 * `confirmCloseConnected`) — Cmd+W / Ctrl+Shift+W or a stray click on the tab
 * X used to drop a live device session with no way back. Disconnected tabs
 * close straight away. Resolves false when the user cancelled.
 */
export async function closeSessions(sessionIds: string[]): Promise<boolean> {
  const targets = useSessionStore
    .getState()
    .sessions.filter((s) => sessionIds.includes(s.sessionId));
  if (targets.length === 0) return false;
  const live = targets.filter((s) => s.connected);
  if (live.length > 0 && useSettingsStore.getState().confirmCloseConnected) {
    const { title, message } = closeConfirmText(live, targets.length);
    const ok = await askConfirm({ title, message, confirmLabel: 'Close', danger: true });
    if (!ok) return false;
  }
  for (const { sessionId } of targets) {
    const st = useSessionStore.getState();
    // The tab may have been closed some other way while the question was up.
    if (!st.sessions.some((s) => s.sessionId === sessionId)) continue;
    // Tear down the backend connection before dropping the tab so SSH/serial
    // sessions aren't leaked.
    invoke('disconnect', { sessionId }).catch(() => {});
    // A session living in a pop-out window: close that window too, or it
    // would linger showing a dead, disconnected terminal.
    if (st.poppedSessions.includes(sessionId)) {
      closeWindow(`popout-${sessionId}`).catch(() => {});
    }
    st.removeSession(sessionId);
  }
  return true;
}
