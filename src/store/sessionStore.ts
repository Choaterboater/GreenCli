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
  secondarySessionId: string | null;
  showVaultUnlock: boolean;
  vaultUnlocked: boolean;

  // Actions
  addSession: (config: ConnectionConfig, sessionId: string) => void;
  removeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  updateSessionConnection: (sessionId: string, connected: boolean) => void;
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
  showConfigEditor: boolean;
  toggleConfigEditor: () => void;
  toggleApiExplorer: () => void;
  toggleAiAssistant: () => void;
  toggleBroadcast: () => void;
  toggleSplitView: () => void;
  setSecondarySession: (sessionId: string | null) => void;

  setFolders: (folders: SessionFolder[]) => void;
  addFolder: (folder: SessionFolder) => void;
  removeFolder: (folderId: string) => void;
  updateFolder: (folderId: string, updates: Partial<SessionFolder>) => void;
  addSessionToFolder: (folderId: string, config: ConnectionConfig) => void;
  removeSessionFromFolder: (folderId: string, sessionId: string) => void;
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
  secondarySessionId: null,
  showVaultUnlock: false,
  vaultUnlocked: false,

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
            lastActivity: Date.now(),
          },
        ],
        activeSessionId: sessionId,
      };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      const filtered = state.sessions.filter((s) => s.sessionId !== sessionId);
      return {
        sessions: filtered,
        activeSessionId:
          state.activeSessionId === sessionId
            ? filtered.length > 0
              ? filtered[filtered.length - 1].sessionId
              : null
            : state.activeSessionId,
      };
    }),

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  updateSessionConnection: (sessionId, connected) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.sessionId === sessionId
          ? { ...s, connected, lastActivity: Date.now() }
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
  toggleConfigEditor: () => set((state) => ({ showConfigEditor: !state.showConfigEditor })),
  // Panels coexist — Editor, API, and AI can all be open side-by-side (each is
  // independently resizable), with the terminal always present.
  toggleApiExplorer: () => set((state) => ({ showApiExplorer: !state.showApiExplorer })),
  toggleAiAssistant: () => set((state) => ({ showAiAssistant: !state.showAiAssistant })),
  toggleBroadcast: () => set((state) => ({ broadcastMode: !state.broadcastMode })),
  toggleSplitView: () =>
    set((state) => {
      const turningOn = !state.splitView;
      let secondary = state.secondarySessionId;
      // When enabling, default the second pane to another open session.
      if (turningOn && (!secondary || secondary === state.activeSessionId)) {
        secondary = state.sessions.find((s) => s.sessionId !== state.activeSessionId)?.sessionId ?? null;
      }
      return { splitView: turningOn, secondarySessionId: secondary };
    }),
  setSecondarySession: (sessionId) => set({ secondarySessionId: sessionId }),

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
}));
