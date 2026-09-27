import { useEffect, useCallback, useState, useRef, memo } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  Settings,
  Search,
  PanelLeft,
  Plug,
  Command,
  Globe,
  Sparkles,
  FileCode,
  TerminalSquare,
  X,
  Plus,
  RefreshCw,
} from 'lucide-react';

import { useSessionStore } from './store/sessionStore';
import { useSettingsStore } from './store/settingsStore';
import { useDialogStore } from './store/dialogStore';
import { loadSecrets, persistSecrets } from './utils/secretVault';
import { useTheme } from './hooks/useTheme';
import { useSidePanelFit } from './hooks/useSidePanelFit';
import { ConnectionConfig, Protocol, DeviceType, vendorColor } from './types';
import { generateId, shellQuote } from './utils';
import { listen } from '@tauri-apps/api/event';
import { notify } from './store/toastStore';
import { useRecentStore, timeAgo, RecentConnection } from './store/recentStore';
import { armIntentScheduler } from './utils/intentScheduler';
import {
  buildConnectPayload,
  type ConnectOutcome,
  isAuthFailure,
  needsPasswordPrompt,
  resolveSshPassword,
  sshCredentialKey,
} from './utils/connect';
import { getTerminalActionAdapter } from './utils/terminalActions';
import { isMultiSendTarget } from './utils/multiSend';
import { openTerminalSearch, sendSearchCommand } from './utils/terminalSearch';
import { closeSessions } from './utils/closeSessions';
import { MAX_PANES } from './utils/splitPanes';
import {
  findStep,
  isFindChord,
  isPcNewConnectionChord,
  isPcPaletteChord,
  resolveTabSwitch,
  shortcutLabel,
  tabSwitchIntent,
  withShortcut,
} from './utils/shortcuts';
import { appWindow } from '@tauri-apps/api/window';
import Toaster from './components/Toaster';
import DialogHost from './components/DialogHost';

import Terminal from './components/Terminal';
import TerminalTabs from './components/TerminalTabs';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import QuickConnect from './components/QuickConnect';
import SshAuthDialog, { AuthCredentials } from './components/SshAuthDialog';
import SettingsPanel from './components/SettingsPanel';
import SearchOverlay from './components/SearchOverlay';
import ApiExplorer from './components/ApiExplorer';
import AiAssistant from './components/AiAssistant';
import ConfigEditor from './components/ConfigEditor';
import SnippetsMenu from './components/SnippetsMenu';
import WorkspaceMenu from './components/WorkspaceMenu';
import CommandPalette from './components/CommandPalette';
import TunnelsManager from './components/TunnelsManager';
import IntentPanel from './components/IntentPanel';
import HelpPanel from './components/HelpPanel';
import VaultUnlock from './components/VaultUnlock';
import BulkRunner from './components/BulkRunner';
import ChangeJobs from './components/ChangeJobs';
import MultiSendBar from './components/MultiSendBar';
import SftpBrowser from './components/SftpBrowser';
import DeviceMapper from './components/DeviceMapper';

// Run a session's per-host startup commands once the shell is ready. Shared by the
// direct-connect path and the auth-dialog retry path so behaviour is consistent.
const WORKSPACE_KEY = 'greencli-workspace-v1';

type WorkspaceSnapshot = {
  activeSessionId: string | null;
  sessions: Array<{ sessionId: string; config: ConnectionConfig }>;
};

function safeWorkspaceConfig(config: ConnectionConfig): ConnectionConfig {
  const { password, jumpPassword, privateKey, keyPassphrase, ...safe } = config;
  void password;
  void jumpPassword;
  void privateKey;
  void keyPassphrase;
  return safe;
}

/** Shape of the `connect` invoke result (matches `ConnectResponse` in ssh/client.rs). */
type ConnectInvokeResult = {
  success: boolean;
  error?: string;
  warning?: string;
};

type HostKeyWarningPayload = {
  sessionId?: string;
  message?: string;
};

// Direct connect both emits `host-key-warning` and returns `warning` on the
// invoke result; reconnect only emits the event. Dedupe so the user sees one toast.
let lastHostKeyToast = { message: '', at: 0 };
function toastHostKeyWarning(message: string | undefined) {
  const text = message?.trim();
  if (!text) return;
  const now = Date.now();
  if (text === lastHostKeyToast.message && now - lastHostKeyToast.at < 2000) return;
  lastHostKeyToast = { message: text, at: now };
  notify.warning('Host key warning', text);
}

// Is this session's terminal on screen — the active tab, a split pane, or its
// own pop-out window? Connect/disconnect toasts are only for background tabs:
// a visible terminal already shows the change, and opening ten devices used to
// stack ten "Connected" toasts.
function isSessionOnScreen(sessionId: string): boolean {
  const st = useSessionStore.getState();
  return (
    st.activeSessionId === sessionId ||
    st.poppedSessions.includes(sessionId) ||
    (st.splitView && st.splitPanes.includes(sessionId))
  );
}

function runStartupCommands(sessionId: string, startupCommands?: string) {
  const startup = startupCommands?.trim();
  if (!startup) return;
  const cmds = startup.split('\n').map((c) => c.trim()).filter(Boolean);
  setTimeout(() => {
    cmds.forEach((c, i) =>
      setTimeout(() => invoke('send_data', { sessionId, data: c + '\r' }).catch(() => {}), i * 250)
    );
  }, 700);
}

// Set by App to its reconnect handler, so the module-level send handlers below
// can offer SecureCRT-style "press Enter to reconnect" on a dropped session.
let reconnectFromTerminal: ((sessionId: string) => void) | null = null;

// One stable onSend per session id — the memoized per-session Terminal below
// would otherwise be re-rendered by a fresh inline closure on every App render.
const sessionSendHandlers = new Map<string, (data: string) => void>();
function sendHandlerFor(sessionId: string): (data: string) => void {
  let handler = sessionSendHandlers.get(sessionId);
  if (!handler) {
    handler = (data: string) => {
      const current = useSessionStore
        .getState()
        .sessions.find((session) => session.sessionId === sessionId);
      if (!current?.connected) {
        if (data === '\r' && current?.connectionStatus === 'disconnected') {
          reconnectFromTerminal?.(sessionId);
        }
        return;
      }
      invoke('send_data', { sessionId, data }).catch(console.error);
    };
    sessionSendHandlers.set(sessionId, handler);
  }
  return handler;
}

// Keep-mounted terminals re-render only when their own props change.
const MemoTerminal = memo(Terminal);

// GreenCLI brand glyph — a terminal prompt `>_` (uses currentColor).
function PromptGlyph({ size, style }: { size: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M6.5 7 L11.5 12 L6.5 17" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.6 16.5 H18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

function App() {
  const { theme } = useTheme();
  // Narrow per-field selectors (the pattern Terminal.tsx uses): subscribing to
  // the whole store re-rendered App — and every session's terminal — on any
  // session/UI state change.
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sidebarVisible = useSessionStore((s) => s.sidebarVisible);
  const showApiExplorer = useSessionStore((s) => s.showApiExplorer);
  const showAiAssistant = useSessionStore((s) => s.showAiAssistant);
  const showConfigEditor = useSessionStore((s) => s.showConfigEditor);
  const setShowSettings = useSessionStore((s) => s.setShowSettings);
  const addSession = useSessionStore((s) => s.addSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const setPendingConnection = useSessionStore((s) => s.setPendingConnection);
  const setShowAuthDialog = useSessionStore((s) => s.setShowAuthDialog);
  const toggleApiExplorer = useSessionStore((s) => s.toggleApiExplorer);
  const toggleAiAssistant = useSessionStore((s) => s.toggleAiAssistant);
  const toggleConfigEditor = useSessionStore((s) => s.toggleConfigEditor);
  const broadcastMode = useSessionStore((s) => s.broadcastMode);
  const multiSendTargets = useSessionStore((s) => s.multiSendTargets);
  const toggleBroadcast = useSessionStore((s) => s.toggleBroadcast);
  const splitView = useSessionStore((s) => s.splitView);
  const splitPanes = useSessionStore((s) => s.splitPanes);
  const toggleSplitView = useSessionStore((s) => s.toggleSplitView);
  const addSplitPane = useSessionStore((s) => s.addSplitPane);
  const removeSplitPane = useSessionStore((s) => s.removeSplitPane);
  const setSplitPaneAt = useSessionStore((s) => s.setSplitPaneAt);
  const poppedSessions = useSessionStore((s) => s.poppedSessions);
  const markPoppedOut = useSessionStore((s) => s.markPoppedOut);
  const restorePoppedOut = useSessionStore((s) => s.restorePoppedOut);
  const vaultUnlocked = useSessionStore((s) => s.vaultUnlocked);
  const setVaultUnlocked = useSessionStore((s) => s.setVaultUnlocked);
  const setShowVaultUnlock = useSessionStore((s) => s.setShowVaultUnlock);
  const setFolders = useSessionStore((s) => s.setFolders);
  const showSftp = useSessionStore((s) => s.showSftp);
  const setShowSftp = useSessionStore((s) => s.setShowSftp);

  const recents = useRecentStore((s) => s.recents);
  const clearRecents = useRecentStore((s) => s.clearRecents);

  // The terminal + side panels row. Opening panels shrinks (or closes) them so
  // the terminal keeps a usable width — see useSidePanelFit.
  const panelRowRef = useRef<HTMLDivElement>(null);
  useSidePanelFit(panelRowRef);

  // Credential save deferred until the vault is unlocked.
  const pendingCredSave = useRef<{ key: string; value: string } | null>(null);
  const connectingIdsRef = useRef<Set<string>>(new Set());
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [mappingSessionId, setMappingSessionId] = useState<string | null>(null);

  const flushPendingCredSave = useCallback(() => {
    const pending = pendingCredSave.current;
    if (!pending) return;
    pendingCredSave.current = null;
    invoke('vault_store', { key: pending.key, value: pending.value }).catch(() => {});
  }, []);

  // Connects parked waiting for the vault unlock prompt: kept in a ref so the
  // unlock completion can resume them (see handleConnect's locked-vault
  // branch). A LIST, not one slot: opening a second session before unlocking
  // used to overwrite the first, stranding its tab on 'connecting' forever
  // (and handleConnect refuses to restart a 'connecting' tab).
  const pendingVaultConnectsRef = useRef<ConnectionConfig[]>([]);
  // Their names, for the vault prompt ("…saved password for core-sw-01").
  // State rather than read from the ref at render, so a connect parked while
  // the prompt is already open still shows up in it.
  const [vaultWaiting, setVaultWaiting] = useState<string[]>([]);
  const syncVaultWaiting = useCallback(() => {
    setVaultWaiting(pendingVaultConnectsRef.current.map((c) => c.name || c.host || 'session'));
  }, []);

  // Sessions waiting for the password dialog while it is already showing for
  // another session. The dialog is one slot too: a second failed connect used
  // to swap it to the new host mid-typing (the password typed for A went to
  // B) and made A's in-flight login look "superseded", tearing it down.
  const authQueueRef = useRef<ConnectionConfig[]>([]);
  const showAuthDialog = useSessionStore((s) => s.showAuthDialog);

  const promptForAuth = useCallback(
    (config: ConnectionConfig, error?: string) => {
      // Shown inside the dialog with an attempt count — the error toast sits
      // behind the modal, so a wrong password used to look like nothing happened.
      if (error) useSessionStore.getState().recordAuthError(config.id, error);
      const st = useSessionStore.getState();
      if (st.showAuthDialog && st.pendingConnection && st.pendingConnection.id !== config.id) {
        if (!authQueueRef.current.some((c) => c.id === config.id)) {
          authQueueRef.current.push(config);
        }
        return;
      }
      setPendingConnection(config);
      setShowAuthDialog(true);
    },
    [setPendingConnection, setShowAuthDialog]
  );

  // When the dialog closes (submitted or dismissed), prompt for the next
  // queued session that still needs credentials.
  useEffect(() => {
    if (showAuthDialog) return;
    while (authQueueRef.current.length > 0) {
      const next = authQueueRef.current.shift()!;
      const s = useSessionStore.getState().sessions.find((x) => x.sessionId === next.id);
      if (!s || s.connected || s.connectionStatus === 'connecting' || s.connectionStatus === 'reconnecting') {
        continue;
      }
      setPendingConnection(next);
      setShowAuthDialog(true);
      break;
    }
  }, [showAuthDialog, setPendingConnection, setShowAuthDialog]);

  // xterm only refits on window resize, so nudge a resize when the pane layout
  // changes so both terminals size correctly.
  const refitTerminals = () =>
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);

  // When the visible terminal changes (tab switch / split toggle), refit it — the
  // one that was hidden had its fit skipped while it had zero size. Keyed on
  // what is SHOWN: moving focus between split panes changes the active
  // session but not the layout, so it doesn't refit every pane.
  const visibleLayout = splitView ? splitPanes.join('|') : activeSessionId;
  useEffect(() => {
    refitTerminals();
  }, [visibleLayout, splitView, poppedSessions]);

  // Pop a session out into its own OS window. The main-window terminal stays
  // mounted but hidden (scrollback survives); only the pop-out fits the PTY, so
  // the two windows never fight over cols/rows. Closing the pop-out restores
  // the tab here.
  const popOutSession = useCallback((sessionId: string) => {
    const s = useSessionStore.getState().sessions.find((x) => x.sessionId === sessionId);
    if (!s) return;
    try {
      localStorage.setItem(
        `popout-meta-${sessionId}`,
        JSON.stringify({
          deviceType: s.config.deviceType,
          name: s.config.name || s.config.host || s.config.serialPort,
          // Starting state for the pop-out's status header; live changes
          // arrive via connection_status events.
          status: s.connectionStatus ?? (s.connected ? 'connected' : 'disconnected'),
        }),
      );
    } catch {
      /* meta is best-effort; pop-out falls back to generic highlighting */
    }
    useSessionStore.getState().markPoppedOut(sessionId);
    invoke('pop_out_session', {
      sessionId,
      title: s.config.name || s.config.host || 'GreenCli',
    }).catch((err) => {
      useSessionStore.getState().restorePoppedOut(sessionId);
      notify.error('Pop-out failed', String(err));
    });
  }, []);

  useEffect(() => {
    const un = listen<string>('popout_closed', (e) => {
      useSessionStore.getState().restorePoppedOut(e.payload);
      // The handover metadata has served its purpose.
      try {
        localStorage.removeItem(`popout-meta-${e.payload}`);
      } catch {
        /* ignore */
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Reconnect (and connect) emit this when a known host presents a new key
  // algorithm. Toast only — no confirm dialog this change.
  useEffect(() => {
    const un = listen<HostKeyWarningPayload>('host-key-warning', (e) => {
      toastHostKeyWarning(e.payload?.message);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Restore tabs after a WebView/app reload as disconnected, reconnectable tabs.
  // This keeps the user's working context without silently reconnecting to devices.
  useEffect(() => {
    let cancelled = false;
    const restoreWorkspace = async () => {
      try {
        const raw = localStorage.getItem(WORKSPACE_KEY);
        const snapshot = raw ? (JSON.parse(raw) as WorkspaceSnapshot) : null;
        if (snapshot?.sessions?.length && useSessionStore.getState().sessions.length === 0) {
          await Promise.all(
            snapshot.sessions.map(({ sessionId }) =>
              invoke('disconnect', { sessionId }).catch(() => {})
            )
          );
          if (cancelled) return;
          snapshot.sessions.forEach(({ sessionId, config }) => {
            addSession(config, sessionId);
            useSessionStore.getState().updateSessionConnection(sessionId, false, 'disconnected');
          });
          if (snapshot.activeSessionId) {
            useSessionStore.getState().setActiveSession(snapshot.activeSessionId);
          }
        }
      } catch {
        localStorage.removeItem(WORKSPACE_KEY);
      } finally {
        if (!cancelled) setWorkspaceLoaded(true);
      }
    };
    void restoreWorkspace();
    return () => {
      cancelled = true;
    };
  }, [addSession]);

  // First-run: open Help once on an empty workspace, then never again.
  useEffect(() => {
    if (!workspaceLoaded) return;
    if (useSessionStore.getState().sessions.length > 0) return;
    const FLAG = 'greencli-help-seen-v1';
    try {
      if (localStorage.getItem(FLAG)) return;
      localStorage.setItem(FLAG, '1');
    } catch {
      return;
    }
    useSessionStore.getState().setShowHelp(true);
  }, [workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded) return;
    // Debounced: session objects churn on every connection-status/activity
    // update, and serializing the whole workspace per change is wasted work.
    const t = setTimeout(() => {
      const snapshot: WorkspaceSnapshot = {
        activeSessionId,
        sessions: sessions.map((session) => ({
          sessionId: session.sessionId,
          config: safeWorkspaceConfig(session.config),
        })),
      };
      try {
        localStorage.setItem(WORKSPACE_KEY, JSON.stringify(snapshot));
      } catch {
        // Workspace persistence is best-effort; active sessions continue normally.
      }
    }, 500);
    return () => clearTimeout(t);
  }, [activeSessionId, sessions, workspaceLoaded]);

  // Browser/WebView reloads destroy the React state while backend sessions are
  // still live. Block accidental navigation whenever session tabs are open.
  useEffect(() => {
    const preventSessionReload = (event: BeforeUnloadEvent) => {
      if (useSessionStore.getState().sessions.length === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventSessionReload);
    return () => window.removeEventListener('beforeunload', preventSessionReload);
  }, []);

  // Split-view column widths (fractions summing to 1, one per pane). Dragging
  // the divider between pane i and i+1 trades width between just those two.
  const [paneRatios, setPaneRatios] = useState<number[]>([1]);
  const [splitDragIdx, setSplitDragIdx] = useState<number | null>(null);
  const MIN_PANE = 0.15;
  const startSplitDrag = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const start = paneRatios.slice();
    const pairSum = start[i] + start[i + 1];
    const prefix = start.slice(0, i).reduce((a, b) => a + b, 0);
    setSplitDragIdx(i);
    const move = (ev: MouseEvent) => {
      const boundary = (ev.clientX - rect.left) / rect.width;
      const left = Math.min(pairSum - MIN_PANE, Math.max(MIN_PANE, boundary - prefix));
      const next = start.slice();
      next[i] = left;
      next[i + 1] = pairSum - left;
      setPaneRatios(next);
    };
    const up = () => {
      setSplitDragIdx(null);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      refitTerminals();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // Detect macOS desktop build so the title bar can clear the native traffic
  // lights (window uses an overlay title bar). In the browser dev preview there
  // is no Tauri IPC, so we keep the normal inset.
  const isTauriMac =
    typeof navigator !== 'undefined' &&
    /Mac/.test(navigator.userAgent) &&
    typeof window !== 'undefined' &&
    '__TAURI_IPC__' in window;


  // Load saved sessions from backend on mount
  useEffect(() => {
    invoke<Array<{ id: string; name: string; items: Array<{ id: string; name: string; protocol: string; host?: string; port?: number; username?: string; authType?: string; keyPath?: string; deviceType: string; deviceProfileId?: string; serialPort?: string; baudRate?: number; dataBits?: number; parity?: string; stopBits?: number; startupCommands?: string; tags?: string[]; command?: string; args?: string[]; cwd?: string; jumpHost?: string; jumpPort?: number; jumpUsername?: string }>; expanded: boolean }>>('list_folders')
      .then((folders) => {
        setFolders(
          folders.map((f) => ({
            id: f.id,
            name: f.name,
            expanded: f.expanded,
            items: f.items.map((s) => ({
              id: s.id,
              name: s.name,
              protocol: s.protocol as Protocol,
              host: s.host,
              port: s.port,
              username: s.username,
              authType: (s.authType ?? 'password') as 'password' | 'key' | 'agent',
              keyPath: s.keyPath,
              deviceType: (s.deviceType ?? 'generic') as DeviceType,
              deviceProfileId: s.deviceProfileId,
              serialPort: s.serialPort,
              baudRate: s.baudRate,
              dataBits: s.dataBits,
              parity: s.parity,
              stopBits: s.stopBits,
              startupCommands: s.startupCommands,
              tags: s.tags,
              // Local-shell launch details, so a saved shell reconnects with the
              // same command/args and start folder instead of a bare default shell.
              command: s.command,
              args: s.args,
              cwd: s.cwd,
              jumpHost: s.jumpHost,
              jumpPort: s.jumpPort,
              jumpUsername: s.jumpUsername,
            })),
          }))
        );
      })
      .catch(() => {}); // silently ignore — backend may not be available in browser mode
  }, [setFolders]);

  // Reflect whether the credential vault is already unlocked.
  useEffect(() => {
    invoke<boolean>('vault_is_unlocked')
      .then(setVaultUnlocked)
      .catch(() => setVaultUnlocked(false));
  }, [setVaultUnlocked]);

  // Push Aruba Central credentials to the backend whenever they change.
  const centralBaseUrl = useSettingsStore((s) => s.centralBaseUrl);
  const centralClientId = useSettingsStore((s) => s.centralClientId);
  const centralClientSecret = useSettingsStore((s) => s.centralClientSecret);
  const centralAuthMode = useSettingsStore((s) => s.centralAuthMode);
  const centralToken = useSettingsStore((s) => s.centralToken);
  useEffect(() => {
    // Debounce: settings inputs update per keystroke, and each push sends the
    // secret over IPC and can trigger a backend auth attempt. Wait for typing
    // to settle instead of pushing every intermediate value.
    const t = setTimeout(() => {
      if (!centralBaseUrl) {
        invoke('central_clear').catch(() => {});
        return;
      }
      if (centralAuthMode === 'token') {
        if (centralToken) {
          invoke('central_set_token', { baseUrl: centralBaseUrl, token: centralToken }).catch(() => {});
        } else {
          invoke('central_clear').catch(() => {});
        }
      } else if (centralClientId && centralClientSecret) {
        invoke('central_configure', {
          baseUrl: centralBaseUrl,
          clientId: centralClientId,
          clientSecret: centralClientSecret,
        }).catch(() => {});
      } else {
        invoke('central_clear').catch(() => {});
      }
    }, 500);
    return () => clearTimeout(t);
  }, [centralBaseUrl, centralClientId, centralClientSecret, centralAuthMode, centralToken]);

  // Push Juniper Mist cloud config to the backend whenever it changes.
  const mistBaseUrl = useSettingsStore((s) => s.mistBaseUrl);
  const mistToken = useSettingsStore((s) => s.mistToken);
  useEffect(() => {
    // Debounced for the same reason as the Central push above.
    const t = setTimeout(() => {
      if (mistToken) {
        invoke('mist_configure', {
          baseUrl: mistBaseUrl || 'https://api.mist.com',
          token: mistToken,
          acceptInvalidCerts: false,
        }).catch(() => {});
      } else {
        invoke('mist_clear').catch(() => {});
      }
    }, 500);
    return () => clearTimeout(t);
  }, [mistBaseUrl, mistToken]);

  // ── Vault-backed persistence of Central / Mist secrets ──
  // These secrets are kept out of localStorage; when the vault is unlocked we load
  // them from the encrypted vault into the in-memory settings (once), then persist
  // any changes back to the vault. While the vault is locked they live in memory
  // only for the session (same model as saved SSH passwords).
  const centralAccounts = useSettingsStore((s) => s.centralAccounts);
  const secretsLoadedRef = useRef(false);
  const suppressSecretPersistRef = useRef(false);
  // Handle on the pending debounced persist so it can be flushed on exit.
  const secretPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!vaultUnlocked || secretsLoadedRef.current) return;
    secretsLoadedRef.current = true;
    suppressSecretPersistRef.current = true;
    (async () => {
      const patch = await loadSecrets(useSettingsStore.getState());
      useSettingsStore.getState().updateSettings(patch);
      // Persist the merged result so a secret typed before unlock is saved too.
      await persistSecrets(useSettingsStore.getState());
      suppressSecretPersistRef.current = false;
    })();
  }, [vaultUnlocked]);

  useEffect(() => {
    if (!vaultUnlocked || suppressSecretPersistRef.current) return;
    secretPersistTimerRef.current = setTimeout(() => {
      secretPersistTimerRef.current = null;
      persistSecrets(useSettingsStore.getState());
    }, 400);
    return () => {
      if (secretPersistTimerRef.current) {
        clearTimeout(secretPersistTimerRef.current);
        secretPersistTimerRef.current = null;
      }
    };
    // The identity fields (base URL / client id / host / username) MUST be
    // deps too: each secret's vault record embeds them, and editing an
    // endpoint without retyping the secret left a stale identity behind —
    // which loadSecrets treats as a mismatch on next launch, silently
    // deleting the secret.
  }, [
    vaultUnlocked,
    centralClientSecret,
    centralToken,
    mistToken,
    centralAccounts,
    centralBaseUrl,
    centralClientId,
    mistBaseUrl,
  ]);

  // Flush a pending debounced persist on window close/reload — secrets typed
  // within the debounce window would otherwise never reach the vault.
  useEffect(() => {
    const flushPendingPersist = () => {
      if (!secretPersistTimerRef.current) return;
      clearTimeout(secretPersistTimerRef.current);
      secretPersistTimerRef.current = null;
      persistSecrets(useSettingsStore.getState());
    };
    window.addEventListener('beforeunload', flushPendingPersist);
    return () => window.removeEventListener('beforeunload', flushPendingPersist);
  }, []);

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

  // Split view panes: splitPanes lists every pane's session in column order,
  // and the FOCUSED pane is the active session (sessionStore). Popped-out
  // sessions never render here (they live in their own window).
  const paneSessions = splitView
    ? splitPanes
        .map((id) => sessions.find((s) => s.sessionId === id))
        .filter(
          (s): s is NonNullable<typeof s> => !!s && !poppedSessions.includes(s.sessionId),
        )
    : [];
  const canSplit = splitView && paneSessions.length >= 2;
  // Sessions that could be picked into a pane.
  const paneCandidates = sessions.filter((s) => !poppedSessions.includes(s.sessionId));
  const unusedPaneCandidates = paneCandidates.filter(
    (s) => !splitPanes.includes(s.sessionId),
  );

  // Clicking into a pane makes its session the active one — so Close, Find,
  // snippets, logging and file drop all act on the pane you are working in,
  // not always the first column. The columns themselves never move.
  const focusPane = (sessionId: string) => {
    const st = useSessionStore.getState();
    if (st.splitView && st.activeSessionId !== sessionId) st.setActiveSession(sessionId);
  };

  // Reset column widths to equal whenever the pane count changes.
  const paneCount = canSplit ? paneSessions.length : 1;
  useEffect(() => {
    setPaneRatios(Array(paneCount).fill(1 / paneCount));
    refitTerminals();
  }, [paneCount]);

  // Ratio helpers tolerate the one render where paneRatios hasn't synced to a
  // new pane count yet (the effect above lands a tick later).
  const ratioAt = (i: number) =>
    paneRatios.length === paneSessions.length ? paneRatios[i] : 1 / Math.max(1, paneSessions.length);
  const paneOffset = (i: number) => {
    let o = 0;
    for (let k = 0; k < i; k++) o += ratioAt(k);
    return o;
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Plain-Ctrl chords collide with readline/emacs shell keys (Ctrl+K =
      // kill-line, Ctrl+T = transpose, Ctrl+F = forward-char, Ctrl+B =
      // backward-char). xterm's capture-phase handler already forwarded the
      // control char to the PTY by the time this bubble-phase handler runs, so
      // acting here too made these chords BOTH edit the shell line AND pop an
      // overlay over it. While focus is in the terminal (or any input), plain
      // Ctrl belongs to the shell; the Cmd variants (macOS) never reach the
      // PTY and stay app shortcuts everywhere.
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const shellCtrl = e.ctrlKey && !e.metaKey && inEditable;
      const inTerminal = !!target && !!target.closest?.('.xterm');

      // F1: Help & documentation
      if (e.key === 'F1') {
        e.preventDefault();
        const s = useSessionStore.getState();
        s.setShowHelp(!s.showHelp);
      }
      // Command palette: Cmd+K (macOS) / Ctrl+K outside the terminal, and
      // Ctrl+Shift+P on Windows/Linux — which also works from inside a
      // session (Terminal.tsx hands it to us instead of the device).
      if (((e.ctrlKey || e.metaKey) && e.key === 'k' && !shellCtrl) || isPcPaletteChord(e)) {
        e.preventDefault();
        useSessionStore.getState().setShowCommandPalette(true);
      }
      // Quick Connect: Cmd+T / Ctrl+T outside the terminal; Ctrl+Shift+T on
      // Windows/Linux from anywhere.
      if (((e.ctrlKey || e.metaKey) && e.key === 't' && !shellCtrl) || isPcNewConnectionChord(e)) {
        e.preventDefault();
        useSessionStore.getState().setShowQuickConnect(true);
      }
      // Ctrl+W: Close Tab. Skip popped-out sessions — closing from here would
      // disconnect the backend while their pop-out window stays open. Also bail
      // out while any overlay/modal is open or focus is in an input/editor (incl.
      // Monaco's hidden textarea), so Cmd+W doesn't silently tear down the live
      // session behind the overlay.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'w' || e.key === 'W')) {
        const st = useSessionStore.getState();
        const activeId = st.activeSessionId;
        if (!activeId) return;
        const overlayOpen =
          st.showSettings || st.showQuickConnect || st.showAuthDialog ||
          st.showCommandPalette || st.showHelp || st.showVaultUnlock ||
          st.showSftp || st.showSearch || st.showConfigEditor ||
          st.showApiExplorer || st.showAiAssistant ||
          useDialogStore.getState().current != null;
        if (overlayOpen) return; // let the overlay keep focus; don't kill the live session
        // Plain Ctrl+W is the shell's delete-word when the terminal (or any
        // input) is focused. Cmd+W (macOS) and Ctrl+Shift+W (Windows Terminal
        // convention) close the tab even from inside the terminal — like
        // normal terminal apps — but never while typing in some other field.
        const closeChord = e.metaKey || (e.ctrlKey && e.shiftKey);
        if (!closeChord && inEditable) return;
        if (closeChord && inEditable && !inTerminal) return;
        e.preventDefault();
        // In split view the active session is the focused pane. A connected
        // session asks first (closeSessions / confirmCloseConnected).
        if (!st.poppedSessions.includes(activeId)) {
          void closeSessions([activeId]);
        }
      }
      // Tab switching: Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PgDn / Ctrl+PgUp,
      // ⌘⇧] / ⌘⇧[ (macOS), and tab N with ⌘1–9 (macOS) / Alt+1–9
      // (Windows/Linux — Ctrl+digit stays with the device). Popped-out
      // sessions live in their own window, so they are skipped.
      const tabIntent = tabSwitchIntent(e);
      if (tabIntent) {
        const st = useSessionStore.getState();
        const next = resolveTabSwitch(
          tabIntent,
          st.sessions.map((s) => s.sessionId),
          st.poppedSessions,
          st.activeSessionId,
        );
        if (next || (tabIntent.kind !== 'jump' && st.sessions.length > 1)) e.preventDefault();
        if (next) {
          st.setActiveSession(next);
          // Switched from inside a terminal: take the keyboard along, or
          // typing keeps going to the pane / hidden tab we just left.
          if (inTerminal) setTimeout(() => getTerminalActionAdapter(next)?.focus(), 0);
        }
      }
      // Find: Cmd+F (macOS) / Ctrl+F outside the terminal, and Ctrl+Shift+F on
      // Windows/Linux from anywhere. Pressed while Find is already open it
      // puts the cursor back in the Find box with the query selected.
      if (((e.ctrlKey || e.metaKey) && e.key === 'f' && !shellCtrl) || isFindChord(e)) {
        e.preventDefault();
        openTerminalSearch();
      }
      // Find next / previous while Find is open: F3 / Shift+F3, and Cmd+G /
      // Cmd+Shift+G on macOS — from the Find box or the terminal.
      const step = findStep(e);
      if (step && useSessionStore.getState().showSearch) {
        e.preventDefault();
        sendSearchCommand({ type: step });
      }
      // Ctrl+,: Settings
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        useSessionStore.getState().setShowSettings(true);
      }
      // Ctrl+B: Toggle Sidebar
      if ((e.ctrlKey || e.metaKey) && e.key === 'b' && !shellCtrl) {
        e.preventDefault();
        useSessionStore.getState().toggleSidebar();
      }
      // Ctrl+Shift+A: Toggle API Explorer
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        useSessionStore.getState().toggleApiExplorer();
      }
      // Ctrl+Shift+I: Toggle AI Assistant
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'I') {
        e.preventDefault();
        useSessionStore.getState().toggleAiAssistant();
      }
      // Ctrl+Shift+E: Toggle Config Editor
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        useSessionStore.getState().toggleConfigEditor();
      }
      // Ctrl/Cmd +/− /0: zoom terminal + config-editor font (pinch on the
      // trackpad works too). The config editors run Monaco pinned to this same
      // persisted fontSize (ConfigEditor/ConfigArchive), so the shortcut,
      // palette actions, and Settings slider all scale them alike and the size
      // survives restarts.
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        const s = useSettingsStore.getState();
        s.setFontSize(Math.min(24, s.fontSize + 1));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        const s = useSettingsStore.getState();
        s.setFontSize(Math.max(8, s.fontSize - 1));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        useSettingsStore.getState().setFontSize(14);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // Attached ONCE: the handler reads live sessions/UI state through
    // useSessionStore.getState() / useSettingsStore.getState(), so it never
    // needs to re-subscribe (and re-attach the window listener) on tab changes.
  }, []);

  // After a TUI (omp) WebView2 can leave focus on body/canvas. xterm only
  // hears keys on its helper textarea, so typing/Esc/Ctrl+C die while Ctrl+F/K
  // still open overlays (shellCtrl is false unless target is INPUT/TEXTAREA).
  // Capture-phase restore: do not preventDefault — overlays keep their chords.
  useEffect(() => {
    const restoreActiveTermFocus = (e: KeyboardEvent) => {
      const st = useSessionStore.getState();
      if (st.showSearch || st.showCommandPalette) return;
      // Never pull focus out from under a modal: with a dialog button (or a
      // non-input spot in Settings / Quick Connect / Help …) focused, the key
      // went to the device behind the modal — Enter on "Cancel" reached the
      // switch instead of cancelling.
      if (
        st.showSettings || st.showQuickConnect || st.showAuthDialog ||
        st.showVaultUnlock || st.showHelp || st.showSftp || st.showBulkRunner || st.showChangeJobs ||
        st.showTunnels || st.showIntent || st.showArchive ||
        useDialogStore.getState().current != null
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[aria-modal="true"], [role="dialog"], .modal-backdrop')) return;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      // Text selected in a panel (AI chat, API responses, Bulk Runner output,
      // help) lives in a non-focusable element, so focus is on body. Pulling
      // focus into xterm's textarea on the Ctrl/Cmd keydown dropped that
      // selection — the Ctrl+C that followed reached xterm with nothing
      // selected, copied nothing, and sent ^C to the device instead. Leave
      // modifier keys / chords alone while such a selection exists; plain
      // typing still returns focus to the terminal.
      const domSel = window.getSelection();
      const panelSelection =
        !!domSel &&
        !domSel.isCollapsed &&
        !domSel.anchorNode?.parentElement?.closest('.xterm');
      const modifierUse =
        e.ctrlKey || e.metaKey || e.altKey || ['Control', 'Meta', 'Shift', 'Alt'].includes(e.key);
      if (panelSelection && modifierUse) return;
      const id = st.activeSessionId;
      if (!id || st.poppedSessions.includes(id)) return;
      getTerminalActionAdapter(id)?.focus();
    };
    window.addEventListener('keydown', restoreActiveTermFocus, true);
    return () => window.removeEventListener('keydown', restoreActiveTermFocus, true);
  }, []);

  // Scheduled intent evaluation (NW-15): re-arm whenever the toggle or interval
  // changes; cleanup disarms on unmount. The sweep never overlaps itself, and
  // drift alerts fire only on new ok/unknown→violation transitions.
  const intentScheduling = useSettingsStore((s) => s.intentScheduling);
  const intentScheduleMinutes = useSettingsStore((s) => s.intentScheduleMinutes);
  useEffect(() => {
    return armIntentScheduler(intentScheduling, intentScheduleMinutes);
  }, [intentScheduling, intentScheduleMinutes]);

  // iTerm2-style file drop: while the SFTP browser is closed, dropping a file
  // on the window inserts its shell-quoted path into the active terminal at the
  // cursor (trailing space, no newline) — handy for AI CLIs and scp/sftp typing.
  // The SFTP browser keeps drop priority for uploads whenever it is open.
  const [fileDropHint, setFileDropHint] = useState(false);
  useEffect(() => {
    const unlisteners = [
      listen<string[]>('tauri://file-drop', (e) => {
        setFileDropHint(false);
        const st = useSessionStore.getState();
        if (st.showSftp) return; // SftpBrowser owns the drop while open
        const sid = st.activeSessionId;
        if (!sid || !e.payload?.length) return;
        const data = e.payload.map(shellQuote).join(' ') + ' ';
        invoke('send_data', { sessionId: sid, data }).catch(() => {});
      }),
      listen('tauri://file-drop-hover', () => {
        const st = useSessionStore.getState();
        if (!st.showSftp && st.activeSessionId) setFileDropHint(true);
      }),
      listen('tauri://file-drop-cancelled', () => setFileDropHint(false)),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, []);

  // Remember a connection in the recents list — called only on SUCCESSFUL
  // connects. Local shells collapse into a single generic "Local Shell" entry;
  // serial ports stand in for the host so the row stays informative.
  const recordRecent = useCallback((config: ConnectionConfig) => {
    if (config.protocol === 'local') {
      useRecentStore.getState().addRecent({
        name: 'Local Shell',
        protocol: 'local',
        deviceType: config.deviceType ?? 'generic',
      });
      return;
    }
    if (!config.host && !config.serialPort) return; // nothing meaningful to recall
    const saved = useSessionStore
      .getState()
      .folders.some((f) => f.items.some((i) => i.id === config.id));
    useRecentStore.getState().addRecent({
      name: config.name || config.host || config.serialPort || 'Session',
      protocol: config.protocol,
      host: config.host ?? config.serialPort,
      port: config.port,
      username: config.username,
      deviceType: config.deviceType,
      storedSessionId: saved ? config.id : undefined,
    });
  }, []);

  // `interactive: false` (Change Jobs): never open the password dialog or the
  // vault prompt — report 'needs-login' instead, so one device waiting on a
  // login can't hold up a job running across many.
  const handleConnect = useCallback(
    async (config: ConnectionConfig, opts: { interactive?: boolean } = {}): Promise<ConnectOutcome> => {
      const interactive = opts.interactive !== false;
      const sessionId = config.id || generateId();
      const fullConfig = { ...config, id: sessionId };

      // A saved host carries a stable id. If its tab is already connected or
      // in-flight (manual connect/auth retry/backend auto-reconnect), just focus
      // it — don't run a second backend connect against the same session id.
      const existing = useSessionStore.getState().sessions.find((s) => s.sessionId === sessionId);
      const existingStatus =
        existing?.connectionStatus ?? (existing?.connected ? 'connected' : 'disconnected');
      // A 'connecting' tab with nothing actually in flight (no connect running,
      // not parked on the vault prompt) is stale — let this click retry it
      // instead of leaving the user no way out but closing the tab.
      const inFlight =
        connectingIdsRef.current.has(sessionId) ||
        pendingVaultConnectsRef.current.some((c) => c.id === sessionId);
      if (
        existing?.connected ||
        (existingStatus === 'connecting' && inFlight) ||
        existingStatus === 'reconnecting'
      ) {
        useSessionStore.getState().setActiveSession(sessionId);
        return existing?.connected ? { status: 'connected', sessionId } : { status: 'in-progress', sessionId };
      }
      if (connectingIdsRef.current.has(sessionId)) {
        if (!existing) {
          addSession(fullConfig, sessionId);
          useSessionStore.getState().updateSessionConnection(sessionId, false, 'connecting');
        }
        useSessionStore.getState().setActiveSession(sessionId);
        return { status: 'in-progress', sessionId };
      }
      connectingIdsRef.current.add(sessionId);

      addSession(fullConfig, sessionId);
      // addSession is a no-op for an existing (disconnected) tab — refresh its
      // config with the saved host's current values and focus it explicitly.
      if (existing) {
        useSessionStore.getState().updateSessionConfig(sessionId, fullConfig);
        useSessionStore.getState().setActiveSession(sessionId);
      }
      useSessionStore.getState().updateSessionConnection(sessionId, false, 'connecting');

      // Resolve against the backend's live vault state. React's vaultUnlocked
      // value can still be stale immediately after startup or vault_unlock;
      // querying the cheap atomic status commands makes the resumed connect use
      // the saved password instead of reopening the SSH authentication dialog.
      const { password, requiresVaultUnlock } = await resolveSshPassword(fullConfig, {
        isUnlocked: () => invoke<boolean>('vault_is_unlocked').catch(() => false),
        isInitialized: () => invoke<boolean>('vault_is_initialized').catch(() => false),
        retrieve: (key) =>
          invoke<string | null>('vault_retrieve', { key }).catch(() => null),
      });

      if (requiresVaultUnlock) {
        connectingIdsRef.current.delete(sessionId);
        if (!interactive) {
          useSessionStore.getState().updateSessionConnection(sessionId, false, 'disconnected');
          return {
            status: 'needs-login',
            reason: 'The saved password is in the locked credential vault — unlock it, then run again.',
          };
        }
        if (!pendingVaultConnectsRef.current.some((c) => c.id === sessionId)) {
          pendingVaultConnectsRef.current.push(fullConfig);
        }
        syncVaultWaiting();
        setShowVaultUnlock(true);
        return { status: 'in-progress', sessionId };
      }

      // No password anywhere (not inline, not saved in the vault): ask for it
      // BEFORE touching the device. Connecting anyway just sent an empty
      // password (plus a keyboard-interactive round) that was certain to fail
      // — a failed login per tab opened, which counts toward TACACS/RADIUS
      // lockout. The dialog still accepts an empty password for gear that has
      // none.
      if (needsPasswordPrompt(fullConfig, password)) {
        connectingIdsRef.current.delete(sessionId);
        useSessionStore.getState().updateSessionConnection(sessionId, false, 'disconnected');
        if (!interactive) {
          return { status: 'needs-login', reason: 'No saved password — log in to it once (its tab), then run again.' };
        }
        promptForAuth(fullConfig);
        return { status: 'in-progress', sessionId };
      }

      // Shared failure path: ask for credentials again only when the device
      // actually rejected them. Unreachable hosts, host-key mismatches,
      // timeouts and telnet (whose login happens in the terminal itself —
      // the dialog's password was never even sent) get a real error instead
      // of a password prompt that hides what went wrong.
      const reportFailure = (error: string): ConnectOutcome => {
        const stillOpen = useSessionStore
          .getState()
          .sessions.some((s) => s.sessionId === sessionId);
        if (!stillOpen) return { status: 'failed', reason: 'The tab was closed.' };
        useSessionStore.getState().updateSessionConnection(sessionId, false, 'disconnected');
        const authFailed = fullConfig.protocol === 'ssh' && isAuthFailure(error);
        // Non-interactive: the job's results grid shows the reason instead.
        if (!interactive) {
          return authFailed
            ? { status: 'needs-login', reason: `The device rejected the saved login (${error}).` }
            : { status: 'failed', reason: error };
        }
        if (authFailed) {
          promptForAuth(fullConfig, error);
          return { status: 'needs-login', reason: error };
        }
        notify.error(`Could not connect to ${fullConfig.name || fullConfig.host || fullConfig.protocol}`, error);
        return { status: 'failed', reason: error };
      };

      try {
        const settingsState = useSettingsStore.getState();
        const result = await invoke<ConnectInvokeResult>('connect', {
          config: buildConnectPayload(
            fullConfig,
            { password },
            {
              keepAliveInterval: settingsState.keepAliveInterval,
              autoReconnect: settingsState.autoReconnect,
            }
          ),
        });

        if (!result.success) {
          return reportFailure(result.error || 'The connection failed to start.');
        } else {
          // The user may have closed the tab while connect was awaiting — if the
          // session is gone, tear the orphaned backend connection down.
          const stillOpen = useSessionStore
            .getState()
            .sessions.some((s) => s.sessionId === sessionId);
          if (!stillOpen) {
            invoke('disconnect', { sessionId }).catch(() => {});
            return { status: 'failed', reason: 'The tab was closed.' };
          }
          useSessionStore.getState().updateSessionConnection(sessionId, true);
          recordRecent(fullConfig);
          const where =
            fullConfig.protocol === 'local'
              ? fullConfig.command || 'local shell'
              : `${fullConfig.username ? fullConfig.username + '@' : ''}${fullConfig.host || fullConfig.serialPort || ''}`;
          // Background tabs only; several landing together share one card.
          if (!isSessionOnScreen(sessionId)) {
            notify.success('Connected', fullConfig.name || where, { group: 'connected' });
          }
          toastHostKeyWarning(result.warning);

          // Per-host startup commands: run them once the shell is ready.
          runStartupCommands(sessionId, fullConfig.startupCommands);
          return { status: 'connected', sessionId };
        }
      } catch (err) {
        console.error('Connection error:', err);
        return reportFailure(String(err));
      } finally {
        connectingIdsRef.current.delete(sessionId);
      }
    },
    [addSession, promptForAuth, setShowVaultUnlock, recordRecent, syncVaultWaiting]
  );

  // Change Jobs connects saved hosts itself and must never block on a dialog.
  const connectForJob = useCallback(
    (config: ConnectionConfig) => handleConnect(config, { interactive: false }),
    [handleConnect]
  );

  // Vault unlocked: flush any deferred credential SAVE, then resume the parked
  // connect. handleConnect rechecks the backend's live status before retrieving
  // the saved password, so this is safe before React renders vaultUnlocked=true.
  const resumeVaultConnect = useCallback(() => {
    flushPendingCredSave();
    const parked = pendingVaultConnectsRef.current;
    pendingVaultConnectsRef.current = [];
    syncVaultWaiting();
    for (const cfg of parked) {
      // handleConnect parked this AFTER registering the tab (status
      // 'connecting', id in connectingIdsRef, cleared when it parked) —
      // restore a clean disconnected tab so the retry starts fresh.
      useSessionStore.getState().updateSessionConnection(cfg.id, false, 'disconnected');
      void handleConnect(cfg);
    }
  }, [flushPendingCredSave, handleConnect, syncVaultWaiting]);

  // Vault prompt dismissed: drop the parked connects and un-stick their tabs.
  const cancelVaultConnect = useCallback(() => {
    const parked = pendingVaultConnectsRef.current;
    pendingVaultConnectsRef.current = [];
    syncVaultWaiting();
    for (const cfg of parked) {
      useSessionStore.getState().updateSessionConnection(cfg.id, false, 'disconnected');
    }
  }, [syncVaultWaiting]);

  // Vault prompt skipped: a locked vault can't say whether it even holds a
  // password for these hosts, so ask for the device password instead of
  // dropping the connects (the auth queue takes them one at a time).
  const skipVaultConnect = useCallback(() => {
    const parked = pendingVaultConnectsRef.current;
    pendingVaultConnectsRef.current = [];
    syncVaultWaiting();
    for (const cfg of parked) {
      useSessionStore.getState().updateSessionConnection(cfg.id, false, 'disconnected');
      promptForAuth(cfg);
    }
  }, [promptForAuth, syncVaultWaiting]);

  const handleDisconnect = useCallback(async (sessionId: string) => {
    const session = useSessionStore.getState().sessions.find((s) => s.sessionId === sessionId);
    try {
      await invoke('disconnect', { sessionId });
      useSessionStore.getState().updateSessionConnection(sessionId, false);
      if (!isSessionOnScreen(sessionId)) {
        notify.info('Disconnected', session?.config.name || session?.config.host || 'Session', {
          group: 'disconnected',
        });
      }
    } catch (err) {
      notify.warning('Disconnect failed', String(err));
    }
  }, []);

  const handleReconnect = useCallback(
    (sessionId: string) => {
      const session = useSessionStore.getState().sessions.find((s) => s.sessionId === sessionId);
      if (!session) return;
      useSessionStore.getState().setActiveSession(sessionId);
      handleConnect(session.config);
    },
    [handleConnect]
  );

  useEffect(() => {
    reconnectFromTerminal = handleReconnect;
    return () => {
      reconnectFromTerminal = null;
    };
  }, [handleReconnect]);

  // One-click local shell — a "normal terminal" running the user's default shell.
  const openLocalShell = useCallback(() => {
    handleConnect({
      id: generateId(),
      name: 'Local Shell',
      protocol: 'local',
      deviceType: 'generic',
    });
  }, [handleConnect]);

  // Reconnect from a recents entry (hero list + command palette). Prefer the
  // saved sidebar session (stable id, startup commands, serial settings); fall
  // back to rebuilding an ad-hoc config, or Quick Connect when neither works.
  const connectRecent = useCallback(
    (recent: RecentConnection) => {
      if (recent.storedSessionId) {
        const saved = useSessionStore
          .getState()
          .folders.flatMap((f) => f.items)
          .find((i) => i.id === recent.storedSessionId);
        if (saved) {
          handleConnect(saved);
          return;
        }
      }
      if (recent.protocol === 'local') {
        openLocalShell();
        return;
      }
      if (recent.host && recent.protocol !== 'serial') {
        // Ad-hoc host: rebuild the config; missing credentials fall through to
        // the vault / auth-dialog path inside handleConnect.
        handleConnect({
          id: generateId(),
          name: recent.name,
          protocol: recent.protocol,
          host: recent.host,
          port: recent.port,
          username: recent.username,
          deviceType: recent.deviceType,
        });
        return;
      }
      // Not enough to reconnect (e.g. a deleted saved serial host whose line
      // settings are gone) — open Quick Connect instead (it takes no prefill).
      useSessionStore.getState().setShowQuickConnect(true);
    },
    [handleConnect, openLocalShell]
  );

  // A pop-out window's Reconnect button (or Enter on its dropped session)
  // asks this window to reconnect — the connect flow (vault, password
  // prompt, startup commands) lives here. The session stays in its pop-out
  // (setActiveSession ignores popped-out sessions). If the reconnect then
  // needs the user — password dialog or vault unlock — bring this window
  // forward, or the prompt would sit unseen behind the pop-out.
  useEffect(() => {
    const un = listen<string>('popout_reconnect', (e) => {
      const sessionId = e.payload;
      if (!sessionId) return;
      handleReconnect(sessionId);
      const needsUser = (s: ReturnType<typeof useSessionStore.getState>) =>
        s.showAuthDialog || s.showVaultUnlock;
      if (needsUser(useSessionStore.getState())) {
        appWindow.setFocus().catch(() => {});
        return;
      }
      const stop = useSessionStore.subscribe((s) => {
        if (!needsUser(s)) return;
        clearTimeout(timer);
        stop();
        appWindow.setFocus().catch(() => {});
      });
      // Only the reconnect just requested — stop watching after a minute.
      const timer = setTimeout(stop, 60_000);
    });
    return () => {
      un.then((f) => f());
    };
  }, [handleReconnect]);

  const handleAuthenticate = useCallback(
    async (creds: AuthCredentials, saveCredential: boolean) => {
      const prompted = useSessionStore.getState().pendingConnection;
      if (!prompted) return;
      if (connectingIdsRef.current.has(prompted.id)) return;
      // The dialog's Username wins: a login sent with a blank or wrong user
      // fails whatever the password. Keep it on the tab so Reconnect and the
      // next prompt reuse it; the vault key below follows it too.
      const username = creds.username?.trim() || prompted.username;
      const pending = username === prompted.username ? prompted : { ...prompted, username };
      if (pending !== prompted) {
        useSessionStore.getState().updateSessionConfig(pending.id, { username });
      }
      connectingIdsRef.current.add(pending.id);

      try {
        useSessionStore.getState().updateSessionConnection(pending.id, false, 'connecting');
        const settingsState = useSettingsStore.getState();
        const result = await invoke<ConnectInvokeResult>('connect', {
          // Same builder as the direct-connect path, so the auth retry keeps the
          // serial line settings (data_bits/parity/stop_bits) and local-shell
          // launch details (command/args/cwd) it used to drop.
          config: buildConnectPayload(
            pending,
            {
              password: creds.password,
              privateKey: creds.privateKey,
              keyPassphrase: creds.keyPassphrase,
              // Honour the auth type the user picked in the dialog.
              authType:
                creds.authType === 'key' ? 'key' : creds.authType === 'agent' ? 'agent' : 'password',
            },
            {
              keepAliveInterval: settingsState.keepAliveInterval,
              autoReconnect: settingsState.autoReconnect,
            }
          ),
        });
        // Only a CLOSED tab abandons the attempt. This used to also bail when
        // the dialog had since moved on to another session — so another
        // tab's failed connect tore down this tab's successful login.
        const stillOpen = useSessionStore
          .getState()
          .sessions.some((s) => s.sessionId === pending.id);
        if (!stillOpen) {
          if (result.success) {
            invoke('disconnect', { sessionId: pending.id }).catch(() => {});
          }
          return;
        }

        if (result.success) {
          useSessionStore.getState().updateSessionConnection(pending.id, true);
          useSessionStore.getState().clearAuthError(pending.id);
          recordRecent(pending);
          // (The dialog already closed on submit; closing it here would dismiss
          // a prompt that has since opened for the NEXT queued session.)
          toastHostKeyWarning(result.warning);

          // Run per-host startup commands here too — this is the common SSH path
          // (no inline/vault password, so the first connect fails and the user
          // types the password into the dialog). Previously they were skipped.
          runStartupCommands(pending.id, pending.startupCommands);

          // Save the password to the vault if requested (passwords only).
          if (saveCredential && creds.authType === 'password' && creds.password) {
            const key = sshCredentialKey(pending);
            if (vaultUnlocked) {
              invoke('vault_store', { key, value: creds.password }).catch(() => {});
            } else {
              // Defer the store until the user unlocks the vault.
              pendingCredSave.current = { key, value: creds.password };
              setShowVaultUnlock(true);
            }
          }
        } else {
          useSessionStore.getState().updateSessionConnection(pending.id, false, 'disconnected');
          const error = result.error || 'The device rejected the supplied credentials.';
          notify.error('Authentication failed', error);
          promptForAuth(pending, error);
        }
      } catch (err) {
        console.error('Auth connection error:', err);
        const error = String(err);
        const stillOpen = useSessionStore
          .getState()
          .sessions.some((s) => s.sessionId === pending.id);
        if (!stillOpen) return;
        useSessionStore.getState().updateSessionConnection(pending.id, false, 'disconnected');
        if (isAuthFailure(error)) {
          notify.error('Authentication failed', error);
          promptForAuth(pending, error);
        } else {
          // Unreachable / timed out / host key: re-asking for the password
          // can't help — show why, and leave the tab's Reconnect button.
          notify.error(`Could not connect to ${pending.name || pending.host || 'session'}`, error);
        }
      } finally {
        connectingIdsRef.current.delete(pending.id);
      }
    },
    [promptForAuth, vaultUnlocked, setShowVaultUnlock, recordRecent]
  );

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden"
      data-theme={theme}
      style={{
        backgroundColor: theme === 'dark' ? 'var(--bg-primary)' : '#ffffff',
        backgroundImage: theme === 'dark' ? 'var(--app-bg-gradient)' : 'none',
      }}
    >
      {/* Title Bar — data-tauri-drag-region is what actually makes it draggable
          (Tauri ignores -webkit-app-region; that's an Electron-ism). The
          attribute only fires when the mousedown TARGET carries it, so it's
          repeated on the static children; buttons/selects stay interactive. */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between h-11 pr-2 bg-[var(--bg-secondary)] border-b border-[var(--border)] drag-region select-none"
        style={{ paddingLeft: isTauriMac ? 80 : 12 }}
      >
        {/* Left: brand + sidebar toggle */}
        <div data-tauri-drag-region className="flex items-center gap-2.5 min-w-0">
          <div data-tauri-drag-region className="flex items-center gap-2">
            <div
              data-tauri-drag-region
              className="flex items-center justify-center w-[26px] h-[26px] rounded-md flex-shrink-0"
              style={{
                background: 'linear-gradient(135deg, var(--accent-hover), var(--accent))',
                boxShadow: 'var(--elevation-1)',
              }}
            >
              <PromptGlyph size={16} style={{ color: 'var(--accent-fg)', pointerEvents: 'none' }} />
            </div>
            <span
              data-tauri-drag-region
              className="text-[13px] font-semibold text-[var(--text-primary)] tracking-tight whitespace-nowrap"
            >
              GreenCLI
            </span>
          </div>
          {!sidebarVisible && (
            <button
              onClick={() => useSessionStore.getState().toggleSidebar()}
              className="no-drag p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              title={withShortcut('Show sidebar', 'sidebar')}
            >
              <PanelLeft size={15} />
            </button>
          )}

          {/* Workspace utilities: Tools + Snippets, anchored under the brand like a file menu */}
          <div className="no-drag flex items-center gap-0.5">
            <WorkspaceMenu
              splitView={splitView}
              onToggleSplit={() => {
                toggleSplitView();
                refitTerminals();
              }}
              broadcastMode={broadcastMode}
              onToggleBroadcast={toggleBroadcast}
            />
            <SnippetsMenu />
          </div>
        </div>

        {/* Center: panel segmented control */}
        <div className="flex items-center gap-2 no-drag">
          <div className="segmented">
            <button data-active={showConfigEditor} onClick={toggleConfigEditor} title={withShortcut('Config Editor', 'editor')}>
              <FileCode size={13} style={showConfigEditor ? { color: 'var(--accent-2)' } : undefined} />
              <span>Editor</span>
            </button>
            <button data-active={showApiExplorer} onClick={toggleApiExplorer} title={withShortcut('API Explorer', 'api')}>
              <Globe size={13} style={showApiExplorer ? { color: 'var(--accent-info)' } : undefined} />
              <span>API</span>
            </button>
            <button data-active={showAiAssistant} onClick={toggleAiAssistant} title={withShortcut('AI Assistant', 'ai')}>
              <Sparkles size={13} style={showAiAssistant ? { color: 'var(--vendor-mist)' } : undefined} />
              <span>AI</span>
            </button>
          </div>
        </div>

        {/* Right: connect + utilities */}
        <div className="flex items-center gap-1 no-drag">
          <button
            onClick={() => useSessionStore.getState().setShowQuickConnect(true)}
            className="btn-accent flex items-center gap-1.5 h-8 px-3 text-[12px]"
            title={withShortcut('New connection', 'quickConnect')}
          >
            <Plug size={13} />
            <span>Connect</span>
          </button>
          <div className="w-px h-5 bg-[var(--border)] mx-1" />
          <button
            onClick={() => openTerminalSearch()}
            className="p-2 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title={withShortcut('Find in terminal', 'find')}
          >
            <Search size={16} />
          </button>
          <button
            onClick={() => useSessionStore.getState().setShowCommandPalette(true)}
            className="p-2 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title={withShortcut('Command palette', 'commandPalette')}
          >
            <Command size={16} />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title={withShortcut('Settings', 'settings')}
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {sidebarVisible && (
          <Sidebar onConnect={handleConnect} />
        )}

        {/* Terminal Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tabs */}
          <TerminalTabs
            onPopOut={popOutSession}
            onDisconnect={handleDisconnect}
            onReconnect={handleReconnect}
            onMapDevice={setMappingSessionId}
          />

          {/* Multi-send bar — type once into the chosen sessions (see MultiSendBar) */}
          {broadcastMode && <MultiSendBar />}

          {/* Terminal Container + Side Panels */}
          <div ref={panelRowRef} className="flex flex-1 overflow-hidden">
            {/* Terminal — hidden with no sessions + editor open, so the editor fills
                the area and works as a standalone text editor. */}
            <div className={`flex-1 flex flex-col min-w-0 ${!activeSession && showConfigEditor ? 'hidden' : ''}`}>
              <div className="flex-1 relative overflow-hidden">
                {fileDropHint && activeSession && (
                  <div className="absolute inset-2 z-20 pointer-events-none rounded-lg border-2 border-dashed border-[var(--accent)] bg-[var(--bg-primary)]/60 flex items-center justify-center">
                    <span className="text-sm text-[var(--text-primary)] bg-[var(--bg-secondary)] px-3 py-1.5 rounded-md border border-[var(--border)]">
                      Drop to insert file path
                    </span>
                  </div>
                )}
                {activeSession ? (
                  // Every session's terminal stays MOUNTED — we only show/hide it via
                  // CSS — so switching tabs preserves each terminal's screen + scrollback
                  // (and avoids disposing an xterm mid-render). Single view shows the
                  // active one; split view shows each pane's session in its column.
                  // The rest are display:none.
                  <div className="h-full w-full relative">
                    {canSplit && (
                      <>
                        {/* Pane headers — every pane carries a session picker
                            and a close button, the last one an add-pane button
                            (max 4 columns). The focused pane (the active
                            session) gets the accent bar. */}
                        {paneSessions.map((p, i) => {
                          const accent = vendorColor(p.config.deviceType);
                          const focused = p.sessionId === activeSessionId;
                          return (
                            <div
                              key={`pane-h-${p.sessionId}`}
                              onMouseDown={(e) => {
                                focusPane(p.sessionId);
                                // Clicks on the header's bare area also hand the
                                // keyboard to that pane's terminal.
                                if (!(e.target as HTMLElement).closest('select, button')) {
                                  e.preventDefault();
                                  getTerminalActionAdapter(p.sessionId)?.focus();
                                }
                              }}
                              className={`absolute top-0 z-10 flex items-center gap-2 h-7 px-2.5 border-b transition-colors ${
                                focused
                                  ? 'bg-[var(--bg-primary)] border-[var(--accent)]'
                                  : 'bg-[var(--bg-secondary)] border-[var(--border)]'
                              }`}
                              style={{
                                left: `${paneOffset(i) * 100}%`,
                                width: `${ratioAt(i) * 100}%`,
                                boxShadow: focused ? 'inset 0 2px 0 var(--accent)' : undefined,
                              }}
                            >
                              <span
                                className="vendor-dot flex-shrink-0"
                                style={{ background: accent, color: accent }}
                              />
                              <select
                                value={p.sessionId}
                                onChange={(e) => {
                                  setSplitPaneAt(splitPanes.indexOf(p.sessionId), e.target.value);
                                  refitTerminals();
                                }}
                                title={focused ? 'Focused pane — shortcuts and tools act on this session' : 'Session shown in this pane'}
                                className={`flex-1 min-w-0 text-[11px] bg-transparent border-0 focus:outline-none cursor-pointer ${
                                  focused
                                    ? 'font-medium text-[var(--text-primary)]'
                                    : 'text-[var(--text-secondary)]'
                                }`}
                              >
                                {paneCandidates
                                  .filter(
                                    (c) =>
                                      c.sessionId === p.sessionId ||
                                      !splitPanes.includes(c.sessionId),
                                  )
                                  .map((c) => (
                                    <option key={c.sessionId} value={c.sessionId}>
                                      {c.config.name || c.config.host || 'Session'}
                                    </option>
                                  ))}
                              </select>
                              {i === paneSessions.length - 1 &&
                                paneSessions.length < MAX_PANES &&
                                unusedPaneCandidates.length > 0 && (
                                  <button
                                    onClick={addSplitPane}
                                    className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0"
                                    title="Add pane"
                                  >
                                    <Plus size={12} />
                                  </button>
                                )}
                              <button
                                onClick={() => {
                                  removeSplitPane(p.sessionId);
                                  refitTerminals();
                                }}
                                className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0"
                                title="Close pane (the session stays open as a tab)"
                              >
                                <X size={12} />
                              </button>
                            </div>
                          );
                        })}
                        {/* Draggable dividers between adjacent panes */}
                        {paneSessions.slice(1).map((p, i) => (
                          <div
                            key={`pane-d-${p.sessionId}`}
                            onMouseDown={startSplitDrag(i)}
                            className={`absolute top-0 bottom-0 z-20 w-1.5 -ml-[3px] cursor-col-resize transition-colors ${
                              splitDragIdx === i
                                ? 'bg-[#58a6ff]'
                                : 'bg-transparent hover:bg-[#58a6ff60]'
                            }`}
                            style={{ left: `${paneOffset(i + 1) * 100}%` }}
                          />
                        ))}
                      </>
                    )}
                    {sessions.map((s) => {
                      const isPopped = poppedSessions.includes(s.sessionId);
                      const paneIdx = canSplit
                        ? paneSessions.findIndex((p) => p.sessionId === s.sessionId)
                        : -1;
                      const isActive = s.sessionId === activeSessionId && !isPopped;
                      const visible = canSplit ? paneIdx >= 0 : isActive;
                      const style: React.CSSProperties = !visible
                        ? { display: 'none' }
                        : canSplit
                        ? {
                            position: 'absolute',
                            top: 28,
                            bottom: 0,
                            left: `${paneOffset(paneIdx) * 100}%`,
                            width: `${ratioAt(paneIdx) * 100}%`,
                            borderRight:
                              paneIdx < paneSessions.length - 1
                                ? '1px solid var(--border)'
                                : undefined,
                          }
                        : { position: 'absolute', inset: 0 };
                      return (
                        // Focus landing in a pane's terminal (click, or the
                        // keyboard) makes that pane the focused one.
                        <div
                          key={s.sessionId}
                          style={style}
                          onFocus={paneIdx >= 0 ? () => focusPane(s.sessionId) : undefined}
                          // Outline every terminal the multi-send bar will type
                          // into, so a stray target is visible before Enter.
                          className={
                            broadcastMode && isMultiSendTarget(s, multiSendTargets)
                              ? 'outline outline-2 -outline-offset-2 outline-[var(--accent-2)]'
                              : undefined
                          }
                        >
                          <MemoTerminal
                            sessionId={s.sessionId}
                            deviceType={s.config.deviceType}
                            onSend={sendHandlerFor(s.sessionId)}
                          />
                          {/* A dropped session says so, with an obvious way back —
                              the only reconnect controls used to be a hover-only
                              tab icon and the status-bar text. */}
                          {!s.connected && s.connectionStatus === 'disconnected' && (
                            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2.5 pl-3 pr-1.5 py-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-xl text-xs text-[var(--text-secondary)]">
                              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-danger)]" />
                              <span>
                                <span className="font-medium text-[var(--text-primary)]">Disconnected</span>
                                {' '}— press Enter or
                              </span>
                              <button
                                onClick={() => handleReconnect(s.sessionId)}
                                className="btn-accent flex items-center gap-1.5 h-7 px-3 text-xs"
                              >
                                <RefreshCw size={12} />
                                Reconnect
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full px-6 text-center animate-fade-in">
                    <div
                      className="flex items-center justify-center w-16 h-16 rounded-2xl mb-5"
                      style={{
                        background: 'linear-gradient(135deg, var(--accent-hover), var(--accent))',
                        boxShadow: 'var(--glow-accent)',
                      }}
                    >
                      <PromptGlyph size={32} style={{ color: 'var(--accent-fg)' }} />
                    </div>
                    <h1 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight">
                      GreenCLI
                    </h1>
                    <p className="mt-1.5 text-[13px] text-[var(--text-secondary)]">
                      One cockpit for Aruba, Juniper &amp; Mist.
                    </p>

                    {/* Vendor chips */}
                    <div className="mt-4 flex items-center gap-2">
                      {([
                        ['Aruba', 'var(--vendor-aruba)'],
                        ['Juniper', 'var(--vendor-juniper)'],
                        ['Mist', 'var(--vendor-mist)'],
                      ] as [string, string][]).map(([label, color]) => (
                        <span
                          key={label}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
                        >
                          <span className="vendor-dot" style={{ background: color, color }} />
                          {label}
                        </span>
                      ))}
                    </div>

                    <div className="mt-7 flex items-center gap-2.5">
                      <button
                        onClick={() => useSessionStore.getState().setShowQuickConnect(true)}
                        className="btn-accent flex items-center gap-2 h-10 px-5 text-sm"
                      >
                        <Plug size={16} />
                        Quick Connect
                      </button>
                      <button
                        onClick={openLocalShell}
                        className="flex items-center gap-2 h-10 px-5 text-sm rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)] transition-colors"
                        title="Open a local shell terminal"
                      >
                        <TerminalSquare size={16} />
                        Local Shell
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        useSessionStore.getState().setSettingsFocus('mcp');
                        useSessionStore.getState().setShowSettings(true);
                      }}
                      className="mt-3 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                    >
                      AI / MCP: Settings → MCP Servers
                    </button>

                    {/* Recent connections — one click back into the last hosts */}
                    {recents.length > 0 && (
                      <div className="mt-7 w-full max-w-sm text-left animate-fade-in">
                        <div className="flex items-center justify-between px-1 mb-1.5">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                            Recent
                          </span>
                          <button
                            onClick={clearRecents}
                            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                            title="Clear recent connections"
                          >
                            Clear
                          </button>
                        </div>
                        <div className="surface overflow-hidden divide-y divide-[var(--border)]">
                          {recents.slice(0, 5).map((r) => {
                            const accent = vendorColor(r.deviceType);
                            const where = r.host
                              ? `${r.username ? r.username + '@' : ''}${r.host}`
                              : '';
                            return (
                              <button
                                key={r.id}
                                onClick={() => connectRecent(r)}
                                className="group flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
                                title={`Reconnect (${r.protocol.toUpperCase()})`}
                              >
                                <span
                                  className="vendor-dot flex-shrink-0"
                                  style={{ background: accent, color: accent }}
                                />
                                <span className="text-[12px] text-[var(--text-primary)] truncate">
                                  {r.name}
                                </span>
                                {where && where !== r.name && (
                                  <span className="text-[11px] text-[var(--text-muted)] truncate">
                                    {where}
                                  </span>
                                )}
                                <span className="ml-auto pl-2 text-[10px] text-[var(--text-muted)] tabular-nums flex-shrink-0">
                                  {timeAgo(r.lastConnectedAt)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Shortcut hints */}
                    <div className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 max-w-md text-[11px] text-[var(--text-muted)]">
                      {([
                        [shortcutLabel('quickConnect'), 'Connect'],
                        [shortcutLabel('commandPalette'), 'Commands'],
                        [shortcutLabel('find'), 'Find'],
                        [shortcutLabel('editor'), 'Editor'],
                        [shortcutLabel('api'), 'API'],
                        [shortcutLabel('ai'), 'AI'],
                        [shortcutLabel('help'), 'Help'],
                      ] as [string, string][]).map(([k, label]) => (
                        <span key={k} className="flex items-center gap-1.5">
                          <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-secondary)] font-mono text-[10px]">
                            {k}
                          </kbd>
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Search Overlay */}
                <SearchOverlay />
              </div>

              {/* Status Bar */}
              <StatusBar
                onDisconnect={handleDisconnect}
                onReconnect={handleReconnect}
                onMapDevice={setMappingSessionId}
              />
            </div>

            {/* Config Editor Panel — always MOUNTED (hidden via CSS when closed,
                like the per-session terminals) so editor buffers/undo history
                survive closing the panel. Monaco re-lays out on unhide. */}
            <ConfigEditor />

            {/* API Explorer Panel — always mounted too (it renders nothing
                while closed): a panel closed to make room for another must
                not throw away a half-built request. */}
            <ApiExplorer />

            {/* AI Assistant Panel — always mounted for the same reason: closing
                the panel must not destroy the chat history. */}
            <AiAssistant />
          </div>
        </div>
      </div>

      {/* Modals & Overlays */}
      <BulkRunner />
      <ChangeJobs onConnect={connectForJob} />
      {showSftp && activeSessionId && (
        // Keyed by session: switching tabs while it is open must not leave the
        // old session's listing/cwd on screen while actions hit the new one.
        <SftpBrowser key={activeSessionId} sessionId={activeSessionId} onClose={() => setShowSftp(false)} />
      )}
      <VaultUnlock
        onUnlocked={resumeVaultConnect}
        onCancel={cancelVaultConnect}
        onSkip={skipVaultConnect}
        waitingFor={vaultWaiting}
      />
      <CommandPalette onConnect={handleConnect} onLocalShell={openLocalShell} onConnectRecent={connectRecent} />
      <TunnelsManager />
      <IntentPanel />
      <HelpPanel />
      <QuickConnect onConnect={handleConnect} />
      <SshAuthDialog onAuthenticate={handleAuthenticate} />
      <DeviceMapper sessionId={mappingSessionId} onClose={() => setMappingSessionId(null)} />
      <SettingsPanel />
      <DialogHost />
      <Toaster />
    </div>
  );
}

export default App;
