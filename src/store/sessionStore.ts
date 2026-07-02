import { create } from 'zustand';
import { ConnectionConfig, Session, SessionFolder } from '../types';

interface SessionState {
  // Active sessions (tabs)
  sessions: Session[];
  activeSessionId: string | null;
  sidebarVisible: boolean;

  // Session folders
  folders: SessionFolder[];

  // UI state
  showAuthDialog: boolean;
  pendingConnection: ConnectionConfig | null;
  showSettings: boolean;
  showSearch: boolean;
  showQuickConnect: boolean;
  showApiExplorer: boolean;
  showAiAssistant: boolean;
  broadcastMode: boolean;
  showCommandPalette: boolean;
  splitView: boolean;
  /** Sessions shown alongside the active one in split view (pane 2..N, max 3
   *  extras → 4 columns). The active session is always pane 1. */
  splitPanes: string[];
  /** Sessions currently popped out into their own OS window — hidden in the
   *  main window (terminal stays mounted so scrollback survives pop-in). */
  poppedSessions: string[];
  /** Background sessions that produced output since they were last viewed
   *  (drives the activity dot on their tab). */
  unseenOutput: string[];
  showVaultUnlock: boolean;
  vaultUnlocked: boolean;
  showBulkRunner: boolean;
  showSftp: boolean;
  showTunnels: boolean;
  showIntent: boolean;
  showHelp: boolean;
  showApstra: boolean;
  /** When opening Settings via a Help deep-link, the section id to scroll to + flash. */
  settingsFocus: string | null;

  // Actions
  addSession: (config: ConnectionConfig, sessionId: string) => void;
  removeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  updateSessionConfig: (sessionId: string, updates: Partial<ConnectionConfig>) => void;
  updateSessionConnection: (
    sessionId: string,
    connected: boolean,
    connectionStatus?: Session['connectionStatus'],
  ) => void;
  clearSessions: () => void;
  toggleSidebar: () => void;
  setSidebarVisible: (visible: boolean) => void;

  setShowAuthDialog: (show: boolean) => void;
  setPendingConnection: (config: ConnectionConfig | null) => void;
  setShowSettings: (show: boolean) => void;
  setShowSearch: (show: boolean) => void;
  setShowQuickConnect: (show: boolean) => void;
  setShowApiExplorer: (show: boolean) => void;
  setShowAiAssistant: (show: boolean) => void;
  setShowCommandPalette: (show: boolean) => void;
  setShowVaultUnlock: (show: boolean) => void;
  setVaultUnlocked: (unlocked: boolean) => void;
  setShowBulkRunner: (show: boolean) => void;
  setShowSftp: (show: boolean) => void;
  setShowTunnels: (show: boolean) => void;
  setShowIntent: (show: boolean) => void;
  setShowHelp: (show: boolean) => void;
  setShowApstra: (show: boolean) => void;
  setSettingsFocus: (id: string | null) => void;
  showConfigEditor: boolean;
  toggleConfigEditor: () => void;
  toggleApiExplorer: () => void;
  toggleAiAssistant: () => void;
  toggleBroadcast: () => void;
  toggleSplitView: () => void;
  addSplitPane: () => void;
  removeSplitPane: (sessionId: string) => void;
  setSplitPaneAt: (index: number, sessionId: string) => void;
  markPoppedOut: (sessionId: string) => void;
  restorePoppedOut: (sessionId: string) => void;
  markUnseenOutput: (sessionId: string) => void;

  setFolders: (folders: SessionFolder[]) => void;
  addFolder: (folder: SessionFolder) => void;
  removeFolder: (folderId: string) => void;
  updateFolder: (folderId: string, updates: Partial<SessionFolder>) => void;
  addSessionToFolder: (folderId: string, config: ConnectionConfig) => void;
  removeSessionFromFolder: (folderId: string, sessionId: string) => void;
  moveSessionToFolder: (sessionId: string, fromFolderId: string, toFolderId: string) => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  sidebarVisible: true,
  folders: [
    {
      id: 'default',
      name: 'Sessions',
      items: [],
      expanded: true,
    },
  ],
  showAuthDialog: false,
  pendingConnection: null,
  showSettings: false,
  showSearch: false,
  showQuickConnect: false,
  showApiExplorer: false,
  showAiAssistant: false,
  showConfigEditor: false,
  broadcastMode: false,
  showCommandPalette: false,
  splitView: false,
  splitPanes: [],
  poppedSessions: [],
  unseenOutput: [],
  showVaultUnlock: false,
  vaultUnlocked: false,
  showBulkRunner: false,
  showSftp: false,
  showTunnels: false,
  showIntent: false,
  showHelp: false,
  showApstra: false,
  settingsFocus: null,

  addSession: (config, sessionId) =>
    set((state) => {
      // Check if already exists
      const exists = state.sessions.some((s) => s.sessionId === sessionId);
      if (exists) return state;

      return {
        sessions: [
          ...state.sessions,
          {
            config,
            sessionId,
            connected: false,
            connectionStatus: 'connecting',
            lastActivity: Date.now(),
          },
        ],
        activeSessionId: sessionId,
      };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      const filtered = state.sessions.filter((s) => s.sessionId !== sessionId);
      const splitPanes = state.splitPanes.filter((id) => id !== sessionId);
      // Promote a session that actually renders in this window — a popped-out
      // one lives in its own OS window and would leave the tab area blank.
      const inWindow = filtered.filter((s) => !state.poppedSessions.includes(s.sessionId));
      const nextActive =
        state.activeSessionId === sessionId
          ? (inWindow.length > 0
              ? inWindow[inWindow.length - 1].sessionId
              : filtered.length > 0
                ? filtered[filtered.length - 1].sessionId
                : null)
          : state.activeSessionId;
      return {
        sessions: filtered,
        // Closing a popped-out session's tab must not leak its tracking state.
        poppedSessions: state.poppedSessions.filter((id) => id !== sessionId),
        // The newly-promoted session is now in view — clear its activity dot
        // along with the removed session's.
        unseenOutput: state.unseenOutput.filter((id) => id !== sessionId && id !== nextActive),
        activeSessionId: nextActive,
        // Don't leave a split pane pointing at a destroyed session.
        splitPanes,
        splitView: splitPanes.length > 0 ? state.splitView : false,
      };
    }),

  setActiveSession: (sessionId) =>
    set((state) => ({
      activeSessionId: sessionId,
      // Viewing a session clears its activity dot.
      unseenOutput: sessionId
        ? state.unseenOutput.filter((id) => id !== sessionId)
        : state.unseenOutput,
    })),

  updateSessionConfig: (sessionId, updates) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.sessionId === sessionId
          ? { ...s, config: { ...s.config, ...updates } }
          : s
      ),
      folders: state.folders.map((f) => ({
        ...f,
        items: f.items.map((item) =>
          item.id === sessionId ? { ...item, ...updates } : item
        ),
      })),
    })),

  markUnseenOutput: (sessionId) =>
    set((state) =>
      state.unseenOutput.includes(sessionId)
        ? state
        : { unseenOutput: [...state.unseenOutput, sessionId] },
    ),

  updateSessionConnection: (sessionId, connected, connectionStatus) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.sessionId === sessionId
          ? {
              ...s,
              connected,
              connectionStatus: connectionStatus ?? (connected ? 'connected' : 'disconnected'),
              lastActivity: Date.now(),
            }
          : s
      ),
    })),

  clearSessions: () => set({ sessions: [], activeSessionId: null }),

  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  setSidebarVisible: (visible) => set({ sidebarVisible: visible }),

  setShowAuthDialog: (show) => set({ showAuthDialog: show }),
  setPendingConnection: (config) => set({ pendingConnection: config }),
  setShowSettings: (show) => set({ showSettings: show }),
  setShowSearch: (show) => set({ showSearch: show }),
  setShowQuickConnect: (show) => set({ showQuickConnect: show }),
  setShowApiExplorer: (show) => set({ showApiExplorer: show }),
  setShowAiAssistant: (show) => set({ showAiAssistant: show }),
  setShowCommandPalette: (show) => set({ showCommandPalette: show }),
  setShowVaultUnlock: (show) => set({ showVaultUnlock: show }),
  setVaultUnlocked: (unlocked) => set({ vaultUnlocked: unlocked }),
  setShowBulkRunner: (show) => set({ showBulkRunner: show }),
  setShowSftp: (show) => set({ showSftp: show }),
  setShowTunnels: (show) => set({ showTunnels: show }),
  setShowIntent: (show) => set({ showIntent: show }),
  setShowHelp: (show) => set({ showHelp: show }),
  setShowApstra: (show) => set({ showApstra: show }),
  setSettingsFocus: (id) => set({ settingsFocus: id }),
  toggleConfigEditor: () => set((state) => ({ showConfigEditor: !state.showConfigEditor })),
  // Panels coexist — Editor, API, and AI can all be open side-by-side (each is
  // independently resizable), with the terminal always present.
  toggleApiExplorer: () => set((state) => ({ showApiExplorer: !state.showApiExplorer })),
  toggleAiAssistant: () => set((state) => ({ showAiAssistant: !state.showAiAssistant })),
  toggleBroadcast: () => set((state) => ({ broadcastMode: !state.broadcastMode })),
  toggleSplitView: () =>
    set((state) => {
      if (state.splitView) return { splitView: false, splitPanes: [] };
      // When enabling, seed pane 2 with another open session — skipping
      // popped-out ones (they render in their own window, so picking one
      // here would leave the pane blank).
      const next = state.sessions.find(
        (s) =>
          s.sessionId !== state.activeSessionId &&
          !state.poppedSessions.includes(s.sessionId),
      );
      return { splitView: true, splitPanes: next ? [next.sessionId] : [] };
    }),
  addSplitPane: () =>
    set((state) => {
      if (!state.splitView || state.splitPanes.length >= 3) return state;
      const used = new Set([state.activeSessionId, ...state.splitPanes]);
      const next = state.sessions.find(
        (s) => !used.has(s.sessionId) && !state.poppedSessions.includes(s.sessionId),
      );
      return next ? { splitPanes: [...state.splitPanes, next.sessionId] } : state;
    }),
  removeSplitPane: (sessionId) =>
    set((state) => {
      const splitPanes = state.splitPanes.filter((id) => id !== sessionId);
      // Removing the last extra pane exits split view.
      return { splitPanes, splitView: splitPanes.length > 0 ? state.splitView : false };
    }),
  setSplitPaneAt: (index, sessionId) =>
    set((state) => {
      if (index < 0 || index >= state.splitPanes.length) return state;
      const splitPanes = [...state.splitPanes];
      splitPanes[index] = sessionId;
      return { splitPanes };
    }),

  markPoppedOut: (sessionId) =>
    set((state) => {
      if (state.poppedSessions.includes(sessionId)) return state;
      const remaining = state.sessions.filter(
        (s) => s.sessionId !== sessionId && !state.poppedSessions.includes(s.sessionId),
      );
      return {
        poppedSessions: [...state.poppedSessions, sessionId],
        // A popped session's tab is never "viewed" here — clear (and stop
        // accruing) its activity dot; the data listener skips popped sessions.
        unseenOutput: state.unseenOutput.filter((id) => id !== sessionId),
        // Hand the active tab to another visible session.
        activeSessionId:
          state.activeSessionId === sessionId
            ? remaining[remaining.length - 1]?.sessionId ?? null
            : state.activeSessionId,
        // Don't leave a split pane pointing at a popped-out session.
        splitPanes: state.splitPanes.filter((id) => id !== sessionId),
      };
    }),
  restorePoppedOut: (sessionId) =>
    set((state) => ({
      poppedSessions: state.poppedSessions.filter((id) => id !== sessionId),
      unseenOutput: state.unseenOutput.filter((id) => id !== sessionId),
      // Bring the returning session to the front if it still exists.
      activeSessionId: state.sessions.some((s) => s.sessionId === sessionId)
        ? sessionId
        : state.activeSessionId,
    })),

  setFolders: (folders) => set({ folders }),

  addFolder: (folder) =>
    set((state) => ({ folders: [...state.folders, folder] })),

  removeFolder: (folderId) =>
    set((state) => ({
      folders: state.folders.filter((f) => f.id !== folderId),
    })),

  updateFolder: (folderId, updates) =>
    set((state) => ({
      folders: state.folders.map((f) =>
        f.id === folderId ? { ...f, ...updates } : f
      ),
    })),

  addSessionToFolder: (folderId, config) =>
    set((state) => ({
      folders: state.folders.map((f) =>
        f.id === folderId
          ? { ...f, items: [...f.items, config] }
          : f
      ),
    })),

  removeSessionFromFolder: (folderId, sessionId) =>
    set((state) => ({
      folders: state.folders.map((f) =>
        f.id === folderId
          ? { ...f, items: f.items.filter((s) => s.id !== sessionId) }
          : f
      ),
    })),

  moveSessionToFolder: (sessionId, fromFolderId, toFolderId) =>
    set((state) => {
      if (fromFolderId === toFolderId) return state;
      const moved = state.folders
        .find((f) => f.id === fromFolderId)
        ?.items.find((s) => s.id === sessionId);
      if (!moved) return state;
      return {
        folders: state.folders.map((f) => {
          if (f.id === fromFolderId) {
            return { ...f, items: f.items.filter((s) => s.id !== sessionId) };
          }
          if (f.id === toFolderId) {
            return { ...f, items: [...f.items, moved] };
          }
          return f;
        }),
      };
    }),
}));
