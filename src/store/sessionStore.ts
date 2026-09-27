import { create } from 'zustand';
import { ConnectionConfig, Session, SessionFolder } from '../types';
import {
  MAX_PANES,
  placeInFocusedPane,
  removeFromPanes,
  setPaneAt,
  settleSplit,
} from '../utils/splitPanes';
import type { ImportSource } from '../utils/importHosts';
import { savedHostId } from '../utils/tabs';
import type { DevicePrompt } from '../utils/devicePrompt';

/** Why the last login for a session was rejected. Shown inside the password
 *  dialog, because the error toast sits behind the modal. */
export interface AuthFailure {
  message: string;
  /** Failed logins in a row — repeated failures can lock TACACS/RADIUS accounts. */
  attempts: number;
  /** Set when the rejected password was a shared login's, so the dialog can
   *  say "Login 'TACACS admin' was rejected" rather than blame this host. */
  login?: { id: string; name: string };
}

/** The shared login behind a password prompt, so the dialog can name it and
 *  offer to update it once for every host that uses it. */
export interface PromptLogin {
  id: string;
  name: string;
  /** rejected: the device refused it. missing: it has no saved password yet.
   *  locked: the vault stayed locked (Skip), so its password couldn't be read.
   *  hostPassword: the last try used a password typed just for this host. */
  reason: 'rejected' | 'missing' | 'locked' | 'hostPassword';
}

/** Quick Connect opened with something already filled in. */
export interface QuickConnectDraft {
  /** A saved host being edited: Save writes it back under the same id instead
   *  of connecting. */
  editing?: { config: ConnectionConfig; folderId: string };
  /** Start with "Save to Sidebar" ticked (the sidebar's "Add a host"). */
  save?: boolean;
}

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
  /** Last rejected login per session id (cleared on success / dismiss). */
  authErrors: Record<string, AuthFailure>;
  /** Shared login behind each session's pending password prompt. */
  authLogins: Record<string, PromptLogin>;
  showSettings: boolean;
  showSearch: boolean;
  showQuickConnect: boolean;
  quickConnectDraft: QuickConnectDraft | null;
  showApiExplorer: boolean;
  showAiAssistant: boolean;
  broadcastMode: boolean;
  /** Multi-send bar targets: every connected session ('all') or the listed
   *  ids ('selected'). Lives here so the terminal panes can outline targets. */
  multiSendTargets: { mode: 'all' | 'selected'; ids: string[] };
  showCommandPalette: boolean;
  splitView: boolean;
  /** Split view: every pane's session in column order (max 4). The focused
   *  pane is activeSessionId — clicking a pane focuses it without reordering
   *  the columns, so session actions follow the pane you're working in. */
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
  /** Change Jobs: push one config change to many devices (dry run, canary). */
  showChangeJobs: boolean;
  showSftp: boolean;
  showTunnels: boolean;
  showIntent: boolean;
  showHelp: boolean;
  /** Config Editor archive panel (lifted so Tools / palette can open it). */
  showArchive: boolean;
  /** Import hosts dialog, and the source tab it opens on. */
  showImportHosts: boolean;
  importHostsSource: ImportSource;
  /** When opening Settings via a Help deep-link, the section id to scroll to + flash. */
  settingsFocus: string | null;

  // Actions
  /** Open a tab for `config`. `activate: false` adds it in the background
   *  (no focus change, no split-pane swap) — for connects made on the user's
   *  behalf, like Change Jobs, that must not pull the view (and the keyboard)
   *  onto the device being changed. */
  addSession: (config: ConnectionConfig, sessionId: string, opts?: { activate?: boolean }) => void;
  removeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  /** Change ONE tab's config (e.g. the username typed at the login prompt,
   *  Rename tab). The saved host is left alone — see updateSavedHost. */
  updateSessionConfig: (sessionId: string, updates: Partial<ConnectionConfig>) => void;
  /** Change a saved host (sidebar item) and every open tab of it, so their
   *  Reconnect uses the new details. Tab ids and tab-only fields are kept. */
  updateSavedHost: (savedId: string, updates: Partial<ConnectionConfig>) => void;
  /** Record the device prompt read from a session's output (no-op when it
   *  hasn't changed — this is called from the ~8ms output flush). */
  setPromptState: (sessionId: string, prompt: DevicePrompt) => void;
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
  recordAuthError: (sessionId: string, message: string, login?: AuthFailure['login']) => void;
  setAuthLogin: (sessionId: string, login: PromptLogin | null) => void;
  clearAuthError: (sessionId: string) => void;
  setShowSettings: (show: boolean) => void;
  setShowSearch: (show: boolean) => void;
  setShowQuickConnect: (show: boolean) => void;
  openQuickConnect: (draft?: QuickConnectDraft) => void;
  setShowApiExplorer: (show: boolean) => void;
  setShowAiAssistant: (show: boolean) => void;
  setShowCommandPalette: (show: boolean) => void;
  setShowVaultUnlock: (show: boolean) => void;
  setVaultUnlocked: (unlocked: boolean) => void;
  setShowBulkRunner: (show: boolean) => void;
  setShowChangeJobs: (show: boolean) => void;
  setShowSftp: (show: boolean) => void;
  setShowTunnels: (show: boolean) => void;
  setShowIntent: (show: boolean) => void;
  setShowHelp: (show: boolean) => void;
  setShowArchive: (show: boolean) => void;
  openImportHosts: (source?: ImportSource) => void;
  setShowImportHosts: (show: boolean) => void;
  setSettingsFocus: (id: string | null) => void;
  showConfigEditor: boolean;
  setShowConfigEditor: (show: boolean) => void;
  toggleConfigEditor: () => void;
  toggleApiExplorer: () => void;
  toggleAiAssistant: () => void;
  toggleBroadcast: () => void;
  setMultiSendTargets: (targets: { mode: 'all' | 'selected'; ids: string[] }) => void;
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

/** Fields that say WHERE and HOW a session connects. Changing any of them
 *  only means something for the next connect, so they never overwrite a tab
 *  that is live (see updateSavedHost). */
export const CONNECTION_FIELDS = [
  'protocol', 'host', 'port', 'username', 'authType', 'keyPath',
  'serialPort', 'baudRate', 'dataBits', 'parity', 'stopBits',
  'command', 'args', 'cwd',
  'jumpHost', 'jumpPort', 'jumpUsername',
] as const;

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
  authErrors: {},
  authLogins: {},
  showSettings: false,
  showSearch: false,
  showQuickConnect: false,
  quickConnectDraft: null,
  showApiExplorer: false,
  showAiAssistant: false,
  showConfigEditor: false,
  broadcastMode: false,
  multiSendTargets: { mode: 'selected', ids: [] },
  showCommandPalette: false,
  splitView: false,
  splitPanes: [],
  poppedSessions: [],
  unseenOutput: [],
  showVaultUnlock: false,
  vaultUnlocked: false,
  showBulkRunner: false,
  showChangeJobs: false,
  showSftp: false,
  showTunnels: false,
  showIntent: false,
  showHelp: false,
  showArchive: false,
  showImportHosts: false,
  importHostsSource: 'csv',
  settingsFocus: null,

  addSession: (config, sessionId, opts) =>
    set((state) => {
      // Check if already exists
      const exists = state.sessions.some((s) => s.sessionId === sessionId);
      if (exists) return state;
      const tab = {
        config,
        sessionId,
        connected: false,
        connectionStatus: 'connecting' as const,
        lastActivity: Date.now(),
      };
      if (opts?.activate === false) return { sessions: [...state.sessions, tab] };

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
        // In split view the new session opens in the focused pane.
        splitPanes: state.splitView
          ? placeInFocusedPane(state.splitPanes, state.activeSessionId, sessionId)
          : state.splitPanes,
      };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      const filtered = state.sessions.filter((s) => s.sessionId !== sessionId);
      // Closing the focused pane's session hands focus to its neighbouring
      // pane rather than some unrelated tab; fewer than two panes left
      // empties the layout (settleSplit), which exits split view below.
      const pane = removeFromPanes(state.splitPanes, state.activeSessionId, sessionId);
      const splitPanes = state.splitPanes.includes(sessionId)
        ? settleSplit(pane.panes, state.splitView).splitPanes
        : state.splitPanes;
      // Promote a session that actually renders in this window — a popped-out
      // one lives in its own OS window and would leave the tab area blank.
      const inWindow = filtered.filter((s) => !state.poppedSessions.includes(s.sessionId));
      const nextActive =
        state.activeSessionId === sessionId
          ? (pane.focus && pane.focus !== sessionId
              ? pane.focus
              : inWindow.length > 0
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
        showSftp: nextActive != null ? state.showSftp : false,
        // A closed tab leaves the multi-send selection: saved hosts reopen
        // under the same id and would silently be a target again.
        multiSendTargets: {
          ...state.multiSendTargets,
          ids: state.multiSendTargets.ids.filter((id) => id !== sessionId),
        },
        // Don't leave a split pane pointing at a destroyed session.
        splitPanes,
        splitView: splitPanes.length > 0 ? state.splitView : false,
      };
    }),

  setActiveSession: (sessionId) =>
    set((state) => {
      // A popped-out session lives in its own window — making it active here
      // would blank the terminal area (e.g. a reconnect requested from its
      // pop-out). The tab strip / palette focus its window instead.
      if (sessionId && state.poppedSessions.includes(sessionId)) return state;
      return {
        activeSessionId: sessionId,
        // Split view: focus the session's pane, or show it in the focused pane.
        splitPanes:
          state.splitView && sessionId
            ? placeInFocusedPane(state.splitPanes, state.activeSessionId, sessionId)
            : state.splitPanes,
        // Viewing a session clears its activity dot.
        unseenOutput: sessionId
          ? state.unseenOutput.filter((id) => id !== sessionId)
          : state.unseenOutput,
      };
    }),

  // Tab only. This used to mirror the change onto the sidebar item with the
  // same id — back when a tab's id WAS its saved host's id — so a username
  // typed at one tab's login prompt quietly changed the sidebar's copy of the
  // host too. Host-wide changes go through updateSavedHost.
  updateSessionConfig: (sessionId, updates) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.sessionId === sessionId
          ? { ...s, config: { ...s.config, ...updates, id: s.config.id } }
          : s
      ),
    })),

  updateSavedHost: (savedId, updates) =>
    set((state) => {
      // The host's own identity and tab-only fields never flow onto its tabs.
      const { id, savedId: _saved, copyNumber, tabName, ...hostFields } = updates;
      void id;
      void _saved;
      void copyNumber;
      void tabName;
      // A LIVE tab is still connected to the old address: rewriting its
      // host/port/user/protocol would label it as the new device while its
      // keystrokes still reach the old one (tab, status bar, multi-send, Config
      // Editor's "Send to …" would all lie). Live tabs keep their connection
      // fields — and their name, when the address changed, since auto-names
      // follow the address — and pick the new details up on Reconnect.
      const changesConnection = CONNECTION_FIELDS.some((k) => k in hostFields);
      const liveFields = Object.fromEntries(
        Object.entries(hostFields).filter(
          ([k]) =>
            !(CONNECTION_FIELDS as readonly string[]).includes(k) &&
            !(changesConnection && k === 'name')
        )
      ) as Partial<ConnectionConfig>;
      return {
        sessions: state.sessions.map((s) => {
          if (savedHostId(s.config) !== savedId) return s;
          const live =
            s.connected || s.connectionStatus === 'connecting' || s.connectionStatus === 'reconnecting';
          return { ...s, config: { ...s.config, ...(live ? liveFields : hostFields) } };
        }),
        folders: state.folders.map((f) => ({
          ...f,
          items: f.items.map((item) =>
            item.id === savedId ? { ...item, ...hostFields } : item
          ),
        })),
      };
    }),

  setPromptState: (sessionId, prompt) =>
    set((state) => {
      const s = state.sessions.find((x) => x.sessionId === sessionId);
      // Local shells aren't devices: a root shell's `host#` is not a prompt
      // to name the tab after or to read a mode from.
      if (!s || s.config.protocol === 'local') return state;
      if (s.promptHost === prompt.host && !!s.configMode === prompt.configMode) return state;
      return {
        sessions: state.sessions.map((x) =>
          x.sessionId === sessionId
            ? { ...x, promptHost: prompt.host, configMode: prompt.configMode }
            : x
        ),
      };
    }),

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
              // A dropped session's next login starts outside config mode, so
              // don't leave its CONFIG badge up; the next prompt sets it again.
              configMode: connected ? s.configMode : false,
            }
          : s
      ),
    })),

  clearSessions: () =>
    set({
      sessions: [],
      activeSessionId: null,
      // Don't leave split/popped/unseen tracking pointing at destroyed sessions.
      splitPanes: [],
      splitView: false,
      poppedSessions: [],
      unseenOutput: [],
      showSftp: false,
      multiSendTargets: { mode: 'selected', ids: [] },
    }),

  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  setSidebarVisible: (visible) => set({ sidebarVisible: visible }),

  setShowAuthDialog: (show) => set({ showAuthDialog: show }),
  setPendingConnection: (config) => set({ pendingConnection: config }),
  recordAuthError: (sessionId, message, login) =>
    set((state) => ({
      authErrors: {
        ...state.authErrors,
        [sessionId]: {
          message,
          attempts: (state.authErrors[sessionId]?.attempts ?? 0) + 1,
          login,
        },
      },
    })),
  setAuthLogin: (sessionId, login) =>
    set((state) => {
      if (!login && !(sessionId in state.authLogins)) return state;
      const authLogins = { ...state.authLogins };
      if (login) authLogins[sessionId] = login;
      else delete authLogins[sessionId];
      return { authLogins };
    }),
  // Ends the prompt's whole story: the failure count and its login context.
  clearAuthError: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.authErrors) && !(sessionId in state.authLogins)) return state;
      const authErrors = { ...state.authErrors };
      const authLogins = { ...state.authLogins };
      delete authErrors[sessionId];
      delete authLogins[sessionId];
      return { authErrors, authLogins };
    }),
  setShowSettings: (show) => set({ showSettings: show }),
  setShowSearch: (show) => set({ showSearch: show }),
  // Plain open/close carries no prefill — a draft left over from an earlier
  // "Edit…" must not turn the next Quick Connect into an edit.
  setShowQuickConnect: (show) => set({ showQuickConnect: show, quickConnectDraft: null }),
  openQuickConnect: (draft) => set({ showQuickConnect: true, quickConnectDraft: draft ?? null }),
  setShowApiExplorer: (show) => set({ showApiExplorer: show }),
  setShowAiAssistant: (show) => set({ showAiAssistant: show }),
  setShowCommandPalette: (show) => set({ showCommandPalette: show }),
  setShowVaultUnlock: (show) => set({ showVaultUnlock: show }),
  setVaultUnlocked: (unlocked) => set({ vaultUnlocked: unlocked }),
  setShowBulkRunner: (show) => set({ showBulkRunner: show }),
  setShowChangeJobs: (show) => set({ showChangeJobs: show }),
  // SFTP browses the ACTIVE session; "open" with no session rendered nothing
  // but left the flag set, so the modal popped over the next tab and Ctrl+W /
  // file drops stayed disabled until then.
  setShowSftp: (show) => set((state) => ({ showSftp: show && state.activeSessionId != null })),
  setShowTunnels: (show) => set({ showTunnels: show }),
  setShowIntent: (show) => set({ showIntent: show }),
  setShowHelp: (show) => set({ showHelp: show }),
  setShowArchive: (show) => set({ showArchive: show }),
  // No source = the tab used last time (it stays in the store).
  openImportHosts: (source) =>
    set((state) => ({ showImportHosts: true, importHostsSource: source ?? state.importHostsSource })),
  setShowImportHosts: (show) => set({ showImportHosts: show }),
  setSettingsFocus: (id) => set({ settingsFocus: id }),
  setShowConfigEditor: (show) => set({ showConfigEditor: show }),
  toggleConfigEditor: () => set((state) => ({ showConfigEditor: !state.showConfigEditor })),
  // Panels coexist — Editor, API, and AI can all be open side-by-side (each is
  // independently resizable), with the terminal always present.
  toggleApiExplorer: () => set((state) => ({ showApiExplorer: !state.showApiExplorer })),
  toggleAiAssistant: () => set((state) => ({ showAiAssistant: !state.showAiAssistant })),
  toggleBroadcast: () => set((state) => ({ broadcastMode: !state.broadcastMode })),
  setMultiSendTargets: (targets) => set({ multiSendTargets: targets }),
  toggleSplitView: () =>
    set((state) => {
      if (state.splitView) return { splitView: false, splitPanes: [] };
      // When enabling, the active session is the first (focused) column and
      // the second is seeded with another open session — skipping popped-out
      // ones (they render in their own window, so the pane would be blank).
      const active =
        state.activeSessionId && !state.poppedSessions.includes(state.activeSessionId)
          ? state.activeSessionId
          : null;
      const next = state.sessions.find(
        (s) => s.sessionId !== active && !state.poppedSessions.includes(s.sessionId),
      );
      const splitPanes = [active, next?.sessionId].filter((id): id is string => !!id);
      return { splitView: true, splitPanes };
    }),
  addSplitPane: () =>
    set((state) => {
      if (!state.splitView || state.splitPanes.length >= MAX_PANES) return state;
      const used = new Set([state.activeSessionId, ...state.splitPanes]);
      const next = state.sessions.find(
        (s) => !used.has(s.sessionId) && !state.poppedSessions.includes(s.sessionId),
      );
      return next ? { splitPanes: [...state.splitPanes, next.sessionId] } : state;
    }),
  removeSplitPane: (sessionId) =>
    set((state) => {
      // Closing a pane keeps its session open as a tab. With fewer than two
      // panes left split view exits and the remaining pane fills the view.
      const pane = removeFromPanes(state.splitPanes, state.activeSessionId, sessionId);
      return {
        ...settleSplit(pane.panes, state.splitView),
        activeSessionId: pane.focus ?? state.activeSessionId,
      };
    }),
  setSplitPaneAt: (index, sessionId) =>
    set((state) => {
      const pane = setPaneAt(state.splitPanes, state.activeSessionId, index, sessionId);
      return { splitPanes: pane.panes, activeSessionId: pane.focus };
    }),

  markPoppedOut: (sessionId) =>
    set((state) => {
      if (state.poppedSessions.includes(sessionId)) return state;
      const remaining = state.sessions.filter(
        (s) => s.sessionId !== sessionId && !state.poppedSessions.includes(s.sessionId),
      );
      // Don't leave a split pane pointing at a popped-out session. Popping out
      // the focused pane hands focus to its neighbouring pane; fewer than two
      // panes left empties the layout, which exits split view below.
      const pane = removeFromPanes(state.splitPanes, state.activeSessionId, sessionId);
      const splitPanes = state.splitPanes.includes(sessionId)
        ? settleSplit(pane.panes, state.splitView).splitPanes
        : state.splitPanes;
      // Hand the active tab to another visible session.
      const activeSessionId =
        state.activeSessionId === sessionId
          ? (pane.focus && pane.focus !== sessionId
              ? pane.focus
              : remaining[remaining.length - 1]?.sessionId ?? null)
          : state.activeSessionId;
      return {
        poppedSessions: [...state.poppedSessions, sessionId],
        // A popped session's tab is never "viewed" here — clear (and stop
        // accruing) its activity dot; the data listener skips popped sessions.
        // The newly-promoted active session is now in view — clear its dot too
        // (mirrors removeSession / setActiveSession).
        unseenOutput: state.unseenOutput.filter(
          (id) => id !== sessionId && id !== activeSessionId,
        ),
        activeSessionId,
        splitPanes,
        // Popping out the last extra pane must exit split view, or the main
        // window keeps rendering a split layout with an empty second pane
        // (mirrors removeSplitPane / removeSession).
        splitView: splitPanes.length > 0 ? state.splitView : false,
      };
    }),
  restorePoppedOut: (sessionId) =>
    set((state) => {
      // Bring the returning session to the front (into the focused pane in
      // split view) if it still exists.
      const exists = state.sessions.some((s) => s.sessionId === sessionId);
      return {
        poppedSessions: state.poppedSessions.filter((id) => id !== sessionId),
        unseenOutput: state.unseenOutput.filter((id) => id !== sessionId),
        activeSessionId: exists ? sessionId : state.activeSessionId,
        splitPanes:
          exists && state.splitView
            ? placeInFocusedPane(state.splitPanes, state.activeSessionId, sessionId)
            : state.splitPanes,
      };
    }),

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
      // Don't detach from the source unless the target folder actually exists,
      // otherwise the session would be dropped from the tree entirely.
      if (!state.folders.some((f) => f.id === toFolderId)) return state;
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
