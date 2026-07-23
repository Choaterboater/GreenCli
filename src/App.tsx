import { useEffect, useCallback, useState, useRef } from 'react';
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
  Radio,
  Columns2,
  TerminalSquare,
  Waypoints,
  Target,
  HelpCircle,
  Network,
  X,
  Plus,
} from 'lucide-react';

import { useSessionStore } from './store/sessionStore';
import { useSettingsStore } from './store/settingsStore';
import { useDialogStore } from './store/dialogStore';
import { loadSecrets, persistSecrets } from './utils/secretVault';
import { useTheme } from './hooks/useTheme';
import { ConnectionConfig, Protocol, DeviceType, vendorColor } from './types';
import { generateId, shellQuote } from './utils';
import { listen } from '@tauri-apps/api/event';
import { notify } from './store/toastStore';
import { useRecentStore, timeAgo, RecentConnection } from './store/recentStore';
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
import CommandPalette from './components/CommandPalette';
import TunnelsManager from './components/TunnelsManager';
import IntentPanel from './components/IntentPanel';
import HelpPanel from './components/HelpPanel';
import ApstraBrowser from './components/ApstraBrowser';
import VaultUnlock from './components/VaultUnlock';
import BulkRunner from './components/BulkRunner';
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
  const {
    sessions,
    activeSessionId,
    sidebarVisible,
    showApiExplorer,
    showAiAssistant,
    showConfigEditor,
    setShowSettings,
    setShowSearch,
    addSession,
    removeSession,
    setPendingConnection,
    setShowAuthDialog,
    toggleApiExplorer,
    toggleAiAssistant,
    toggleConfigEditor,
    broadcastMode,
    toggleBroadcast,
    splitView,
    splitPanes,
    toggleSplitView,
    addSplitPane,
    removeSplitPane,
    setSplitPaneAt,
    poppedSessions,
    markPoppedOut,
    restorePoppedOut,
    vaultUnlocked,
    setVaultUnlocked,
    setShowVaultUnlock,
    setFolders,
    showSftp,
    setShowSftp,
  } = useSessionStore();

  const recents = useRecentStore((s) => s.recents);
  const clearRecents = useRecentStore((s) => s.clearRecents);

  // Credential save deferred until the vault is unlocked.
  const pendingCredSave = useRef<{ key: string; value: string } | null>(null);
  const connectingIdsRef = useRef<Set<string>>(new Set());
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [mappingSessionId, setMappingSessionId] = useState<string | null>(null);

  const credKey = (c: { host?: string; port?: number; username?: string }) =>
    `cred:${c.host ?? ''}:${c.port ?? 22}:${c.username ?? ''}`;

  const flushPendingCredSave = useCallback(() => {
    const pending = pendingCredSave.current;
    if (!pending) return;
    pendingCredSave.current = null;
    invoke('vault_store', { key: pending.key, value: pending.value }).catch(() => {});
  }, []);

  // xterm only refits on window resize, so nudge a resize when the pane layout
  // changes so both terminals size correctly.
  const refitTerminals = () =>
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);

  // When the visible terminal changes (tab switch / split toggle), refit it — the
  // one that was hidden had its fit skipped while it had zero size.
  useEffect(() => {
    refitTerminals();
  }, [activeSessionId, splitView, splitPanes, poppedSessions]);

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
        JSON.stringify({ deviceType: s.config.deviceType, name: s.config.name }),
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

  useEffect(() => {
    if (!workspaceLoaded) return;
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

  const [broadcastInput, setBroadcastInput] = useState('');

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
  // Multi-send targeting: send to 'all' connected sessions, or a chosen 'selected' subset.
  const [targetMode, setTargetMode] = useState<'all' | 'selected'>('all');
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());

  // Detect macOS desktop build so the title bar can clear the native traffic
  // lights (window uses an overlay title bar). In the browser dev preview there
  // is no Tauri IPC, so we keep the normal inset.
  const isTauriMac =
    typeof navigator !== 'undefined' &&
    /Mac/.test(navigator.userAgent) &&
    typeof window !== 'undefined' &&
    '__TAURI_IPC__' in window;

  // Multi-send: run a command on several sessions at once — all connected, or a
  // selected subset.
  const sendBroadcast = useCallback(() => {
    const cmd = broadcastInput;
    if (!cmd.trim()) return;
    const connected = sessions.filter((s) => s.connected);
    const targets =
      targetMode === 'all' ? connected : connected.filter((s) => selectedTargets.has(s.sessionId));
    if (targets.length === 0) {
      notify.warning(
        'Nothing to send',
        targetMode === 'selected'
          ? 'No target sessions are selected (or none are connected).'
          : 'No sessions are currently connected.'
      );
      return;
    }
    targets.forEach((s) =>
      invoke('send_data', { sessionId: s.sessionId, data: cmd + '\r' }).catch(() => {})
    );
    notify.success('Multi-send', `Sent to ${targets.length} session${targets.length > 1 ? 's' : ''}.`);
    setBroadcastInput('');
  }, [broadcastInput, sessions, targetMode, selectedTargets]);

  // Load saved sessions from backend on mount
  useEffect(() => {
    invoke<Array<{ id: string; name: string; items: Array<{ id: string; name: string; protocol: string; host?: string; port?: number; username?: string; authType?: string; deviceType: string; deviceProfileId?: string; serialPort?: string; baudRate?: number; dataBits?: number; parity?: string; stopBits?: number; startupCommands?: string; tags?: string[]; command?: string; args?: string[]; cwd?: string; jumpHost?: string; jumpPort?: number; jumpUsername?: string }>; expanded: boolean }>>('list_folders')
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
  }, [centralBaseUrl, centralClientId, centralClientSecret, centralAuthMode, centralToken]);

  // Push Juniper Apstra credentials to the backend whenever they change.
  const apstraHost = useSettingsStore((s) => s.apstraHost);
  const apstraUsername = useSettingsStore((s) => s.apstraUsername);
  const apstraPassword = useSettingsStore((s) => s.apstraPassword);
  const verifyDeviceTls = useSettingsStore((s) => s.verifyDeviceTls);
  useEffect(() => {
    if (apstraHost && apstraUsername && apstraPassword) {
      invoke('apstra_configure', {
        host: apstraHost,
        username: apstraUsername,
        password: apstraPassword,
        // Top-level command args use camelCase (Tauri maps to the snake_case Rust
        // param). Honour the user's TLS-verification setting.
        acceptInvalidCerts: !verifyDeviceTls,
      }).catch((e) => notify.error('Apstra configuration failed', String(e)));
    } else {
      invoke('apstra_clear').catch(() => {});
    }
  }, [apstraHost, apstraUsername, apstraPassword, verifyDeviceTls]);

  // Push Juniper Mist cloud config to the backend whenever it changes.
  const mistBaseUrl = useSettingsStore((s) => s.mistBaseUrl);
  const mistToken = useSettingsStore((s) => s.mistToken);
  useEffect(() => {
    if (mistToken) {
      invoke('mist_configure', {
        baseUrl: mistBaseUrl || 'https://api.mist.com',
        token: mistToken,
        acceptInvalidCerts: false,
      }).catch(() => {});
    } else {
      invoke('mist_clear').catch(() => {});
    }
  }, [mistBaseUrl, mistToken]);

  // ── Vault-backed persistence of Central / Apstra secrets ──
  // These secrets are kept out of localStorage; when the vault is unlocked we load
  // them from the encrypted vault into the in-memory settings (once), then persist
  // any changes back to the vault. While the vault is locked they live in memory
  // only for the session (same model as saved SSH passwords).
  const centralAccounts = useSettingsStore((s) => s.centralAccounts);
  const secretsLoadedRef = useRef(false);
  const suppressSecretPersistRef = useRef(false);

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
    const t = setTimeout(() => {
      persistSecrets(useSettingsStore.getState());
    }, 400);
    return () => clearTimeout(t);
    // The identity fields (base URL / client id / host / username) MUST be
    // deps too: each secret's vault record embeds them, and editing an
    // endpoint without retyping the secret left a stale identity behind —
    // which loadSecrets treats as a mismatch on next launch, silently
    // deleting the secret.
  }, [
    vaultUnlocked,
    centralClientSecret,
    centralToken,
    apstraPassword,
    mistToken,
    centralAccounts,
    centralBaseUrl,
    centralClientId,
    apstraHost,
    apstraUsername,
    mistBaseUrl,
  ]);

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

  // Split view panes: the active session is always pane 1; splitPanes holds
  // panes 2..N. Popped-out sessions never render here (they live in their own
  // window) and the active session can't double up in a side pane.
  const paneSessions = [
    ...(activeSession && !poppedSessions.includes(activeSession.sessionId)
      ? [activeSession]
      : []),
    ...splitPanes
      .map((id) => sessions.find((s) => s.sessionId === id))
      .filter(
        (s): s is NonNullable<typeof s> =>
          !!s &&
          s.sessionId !== activeSessionId &&
          !poppedSessions.includes(s.sessionId),
      ),
  ];
  const canSplit = splitView && paneSessions.length >= 2;
  // Sessions that could still be added/selected into a pane.
  const paneCandidates = sessions.filter(
    (s) => !poppedSessions.includes(s.sessionId) && s.sessionId !== activeSessionId,
  );
  const unusedPaneCandidates = paneCandidates.filter(
    (s) => !splitPanes.includes(s.sessionId),
  );

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

      // F1: Help & documentation
      if (e.key === 'F1') {
        e.preventDefault();
        const s = useSessionStore.getState();
        s.setShowHelp(!s.showHelp);
      }
      // Ctrl+K: Command Palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'k' && !shellCtrl) {
        e.preventDefault();
        useSessionStore.getState().setShowCommandPalette(true);
      }
      // Ctrl+T: Quick Connect
      if ((e.ctrlKey || e.metaKey) && e.key === 't' && !shellCtrl) {
        e.preventDefault();
        useSessionStore.getState().setShowQuickConnect(true);
      }
      // Ctrl+W: Close Tab. Skip popped-out sessions — closing from here would
      // disconnect the backend while their pop-out window stays open. Also bail
      // out while any overlay/modal is open or focus is in an input/editor (incl.
      // Monaco's hidden textarea), so Cmd+W doesn't silently tear down the live
      // session behind the overlay.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'w' || e.key === 'W') && activeSessionId) {
        const st = useSessionStore.getState();
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
        const inTerminal = !!target && !!target.closest?.('.xterm');
        if (!closeChord && inEditable) return;
        if (closeChord && inEditable && !inTerminal) return;
        e.preventDefault();
        if (!st.poppedSessions.includes(activeSessionId)) {
          invoke('disconnect', { sessionId: activeSessionId }).catch(() => {});
          removeSession(activeSessionId);
        }
      }
      // Ctrl+1..9: jump to tab N. Popped-out sessions live in their own window —
      // activating one here blanks the whole terminal area, so skip them.
      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (sessions[idx] && !useSessionStore.getState().poppedSessions.includes(sessions[idx].sessionId)) {
          e.preventDefault();
          useSessionStore.getState().setActiveSession(sessions[idx].sessionId);
        }
      }
      // Ctrl+Tab: cycle to the next tab still living in this window (popped-out
      // sessions render in their own window, so cycle past them).
      if (e.ctrlKey && e.key === 'Tab' && sessions.length > 1) {
        e.preventDefault();
        const popped = useSessionStore.getState().poppedSessions;
        const cur = sessions.findIndex((s) => s.sessionId === activeSessionId);
        for (let step = 1; step <= sessions.length; step++) {
          const next = sessions[(cur + step) % sessions.length];
          if (popped.includes(next.sessionId)) continue;
          if (next.sessionId !== activeSessionId) {
            useSessionStore.getState().setActiveSession(next.sessionId);
          }
          break;
        }
      }
      // Ctrl+F: Search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !shellCtrl) {
        e.preventDefault();
        setShowSearch(true);
      }
      // Ctrl+,: Settings
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setShowSettings(true);
      }
      // Ctrl+B: Toggle Sidebar
      if ((e.ctrlKey || e.metaKey) && e.key === 'b' && !shellCtrl) {
        e.preventDefault();
        useSessionStore.getState().toggleSidebar();
      }
      // Ctrl+Shift+A: Toggle API Explorer
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        toggleApiExplorer();
      }
      // Ctrl+Shift+I: Toggle AI Assistant
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'I') {
        e.preventDefault();
        toggleAiAssistant();
      }
      // Ctrl+Shift+E: Toggle Config Editor
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        toggleConfigEditor();
      }
      // Ctrl/Cmd +/− /0: zoom terminal font (pinch on the trackpad works too)
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
  }, [activeSessionId, sessions, removeSession, setShowSearch, setShowSettings, toggleApiExplorer, toggleAiAssistant, toggleConfigEditor]);

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

  const handleConnect = useCallback(
    async (config: ConnectionConfig) => {
      const sessionId = config.id || generateId();
      const fullConfig = { ...config, id: sessionId };

      // A saved host carries a stable id. If its tab is already connected or
      // in-flight (manual connect/auth retry/backend auto-reconnect), just focus
      // it — don't run a second backend connect against the same session id.
      const existing = useSessionStore.getState().sessions.find((s) => s.sessionId === sessionId);
      const existingStatus =
        existing?.connectionStatus ?? (existing?.connected ? 'connected' : 'disconnected');
      if (
        existing?.connected ||
        existingStatus === 'connecting' ||
        existingStatus === 'reconnecting'
      ) {
        useSessionStore.getState().setActiveSession(sessionId);
        return;
      }
      if (connectingIdsRef.current.has(sessionId)) {
        if (!existing) {
          addSession(fullConfig, sessionId);
          useSessionStore.getState().updateSessionConnection(sessionId, false, 'connecting');
        }
        useSessionStore.getState().setActiveSession(sessionId);
        return;
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

      // For SSH with no inline password, try a saved vault credential.
      let password = fullConfig.password;
      if (!password && fullConfig.protocol === 'ssh' && vaultUnlocked) {
        password =
          (await invoke<string | null>('vault_retrieve', { key: credKey(fullConfig) }).catch(
            () => null
          )) ?? undefined;
      }

      try {
        const result = await invoke<{
          success: boolean;
          error?: string;
        }>('connect', {
          config: {
            id: sessionId,
            name: fullConfig.name,
            protocol: fullConfig.protocol,
            host: fullConfig.host,
            port: fullConfig.port,
            username: fullConfig.username,
            auth_type: fullConfig.authType || 'password',
            password,
            private_key: fullConfig.privateKey,
            key_passphrase: fullConfig.keyPassphrase,
            serial_port: fullConfig.serialPort,
            baud_rate: fullConfig.baudRate,
            data_bits: fullConfig.dataBits,
            parity: fullConfig.parity,
            stop_bits: fullConfig.stopBits,
            device_type: fullConfig.deviceType,
            device_profile_id: fullConfig.deviceProfileId,
            keep_alive_interval: useSettingsStore.getState().keepAliveInterval,
            auto_reconnect: useSettingsStore.getState().autoReconnect,
            command: fullConfig.command,
            args: fullConfig.args,
            cwd: fullConfig.cwd,
            jump_host: fullConfig.jumpHost,
            jump_port: fullConfig.jumpPort,
            jump_username: fullConfig.jumpUsername,
            jump_password: fullConfig.jumpPassword,
          },
        });

        // The SSH auth dialog only makes sense for credential-based protocols.
        const authBased = fullConfig.protocol === 'ssh' || fullConfig.protocol === 'telnet';
        if (!result.success) {
          const stillOpen = useSessionStore
            .getState()
            .sessions.some((s) => s.sessionId === sessionId);
          if (!stillOpen) return;
          useSessionStore.getState().updateSessionConnection(sessionId, false);
          if (authBased) {
            setPendingConnection(fullConfig);
            setShowAuthDialog(true);
          } else {
            // local/serial: no auth to retry — surface the failure.
            notify.error(
              `Could not start ${fullConfig.name || fullConfig.protocol}`,
              result.error || 'The connection failed to start.'
            );
          }
        } else {
          // The user may have closed the tab while connect was awaiting — if the
          // session is gone, tear the orphaned backend connection down.
          const stillOpen = useSessionStore
            .getState()
            .sessions.some((s) => s.sessionId === sessionId);
          if (!stillOpen) {
            invoke('disconnect', { sessionId }).catch(() => {});
            return;
          }
          useSessionStore.getState().updateSessionConnection(sessionId, true);
          recordRecent(fullConfig);
          const where =
            fullConfig.protocol === 'local'
              ? fullConfig.command || 'local shell'
              : `${fullConfig.username ? fullConfig.username + '@' : ''}${fullConfig.host || fullConfig.serialPort || ''}`;
          notify.success('Connected', `${fullConfig.name || where} is online.`);

          // Per-host startup commands: run them once the shell is ready.
          runStartupCommands(sessionId, fullConfig.startupCommands);
        }
      } catch (err) {
        console.error('Connection error:', err);
        // For local/serial there's no auth to retry — surface the failure.
        const stillOpen = useSessionStore
          .getState()
          .sessions.some((s) => s.sessionId === sessionId);
        if (!stillOpen) return;
        useSessionStore.getState().updateSessionConnection(sessionId, false);
        if (fullConfig.protocol === 'ssh' || fullConfig.protocol === 'telnet') {
          setPendingConnection(fullConfig);
          setShowAuthDialog(true);
        } else {
          notify.error(
            `Could not start ${fullConfig.name || fullConfig.protocol}`,
            String(err)
          );
        }
      } finally {
        connectingIdsRef.current.delete(sessionId);
      }
    },
    [addSession, setPendingConnection, setShowAuthDialog, vaultUnlocked, recordRecent]
  );

  const handleDisconnect = useCallback(async (sessionId: string) => {
    const session = useSessionStore.getState().sessions.find((s) => s.sessionId === sessionId);
    try {
      await invoke('disconnect', { sessionId });
      useSessionStore.getState().updateSessionConnection(sessionId, false);
      notify.info('Disconnected', `${session?.config.name || session?.config.host || 'Session'} is offline.`);
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

  const handleAuthenticate = useCallback(
    async (creds: AuthCredentials, saveCredential: boolean) => {
      const pending = useSessionStore.getState().pendingConnection;
      if (!pending) return;
      if (connectingIdsRef.current.has(pending.id)) return;
      connectingIdsRef.current.add(pending.id);

      try {
        useSessionStore.getState().updateSessionConnection(pending.id, false, 'connecting');
        const result = await invoke<{
          success: boolean;
          error?: string;
        }>('connect', {
          config: {
            id: pending.id,
            name: pending.name,
            protocol: pending.protocol,
            host: pending.host,
            port: pending.port,
            username: pending.username,
            // Honour the auth type the user picked in the dialog.
            auth_type:
              creds.authType === 'key' ? 'key' : creds.authType === 'agent' ? 'agent' : 'password',
            password: creds.password,
            private_key: creds.privateKey,
            key_passphrase: creds.keyPassphrase,
            serial_port: pending.serialPort,
            baud_rate: pending.baudRate,
            device_type: pending.deviceType,
            device_profile_id: pending.deviceProfileId,
            keep_alive_interval: useSettingsStore.getState().keepAliveInterval,
            auto_reconnect: useSettingsStore.getState().autoReconnect,
            jump_host: pending.jumpHost,
            jump_port: pending.jumpPort,
            jump_username: pending.jumpUsername,
            jump_password: pending.jumpPassword,
          },
        });
        const currentState = useSessionStore.getState();
        const stillOpen = currentState.sessions.some((s) => s.sessionId === pending.id);
        const stillCurrentAuth = currentState.pendingConnection?.id === pending.id;
        if (!stillOpen || !stillCurrentAuth) {
          if (result.success) {
            invoke('disconnect', { sessionId: pending.id }).catch(() => {});
          }
          // A still-open tab must not stay stuck on 'connecting' after we
          // abandoned (and disconnected) this superseded attempt.
          if (stillOpen) {
            useSessionStore.getState().updateSessionConnection(pending.id, false, 'disconnected');
          }
          return;
        }

        if (result.success) {
          useSessionStore.getState().updateSessionConnection(pending.id, true);
          recordRecent(pending);
          setShowAuthDialog(false);

          // Run per-host startup commands here too — this is the common SSH path
          // (no inline/vault password, so the first connect fails and the user
          // types the password into the dialog). Previously they were skipped.
          runStartupCommands(pending.id, pending.startupCommands);

          // Save the password to the vault if requested (passwords only).
          if (saveCredential && creds.authType === 'password' && creds.password) {
            const key = credKey(pending);
            if (vaultUnlocked) {
              invoke('vault_store', { key, value: creds.password }).catch(() => {});
            } else {
              // Defer the store until the user unlocks the vault.
              pendingCredSave.current = { key, value: creds.password };
              setShowVaultUnlock(true);
            }
          }
        } else {
          useSessionStore.getState().updateSessionConnection(pending.id, false);
          setPendingConnection(pending);
          setShowAuthDialog(true);
          notify.error(
            'Authentication failed',
            result.error || 'The device rejected the supplied credentials.'
          );
        }
      } catch (err) {
        console.error('Auth connection error:', err);
        useSessionStore.getState().updateSessionConnection(pending.id, false);
        const currentState = useSessionStore.getState();
        const stillOpen = currentState.sessions.some((s) => s.sessionId === pending.id);
        const stillCurrentAuth = currentState.pendingConnection?.id === pending.id;
        if (!stillOpen || !stillCurrentAuth) return;
        setPendingConnection(pending);
        setShowAuthDialog(true);
        notify.error('Authentication failed', String(err));
      } finally {
        connectingIdsRef.current.delete(pending.id);
      }
    },
    [setPendingConnection, setShowAuthDialog, vaultUnlocked, setShowVaultUnlock, recordRecent]
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
              title="Show sidebar (Ctrl+B)"
            >
              <PanelLeft size={15} />
            </button>
          )}
        </div>

        {/* Center: panel segmented control + workspace utilities */}
        <div className="flex items-center gap-2 no-drag">
          <div className="segmented">
            <button data-active={showConfigEditor} onClick={toggleConfigEditor} title="Config Editor (Ctrl+Shift+E)">
              <FileCode size={13} style={showConfigEditor ? { color: 'var(--accent-2)' } : undefined} />
              <span>Editor</span>
            </button>
            <button data-active={showApiExplorer} onClick={toggleApiExplorer} title="API Explorer (Ctrl+Shift+A)">
              <Globe size={13} style={showApiExplorer ? { color: 'var(--accent-info)' } : undefined} />
              <span>API</span>
            </button>
            <button data-active={showAiAssistant} onClick={toggleAiAssistant} title="AI Assistant (Ctrl+Shift+I)">
              <Sparkles size={13} style={showAiAssistant ? { color: 'var(--vendor-mist)' } : undefined} />
              <span>AI</span>
            </button>
          </div>

          <div className="flex items-center gap-0.5">
            <button
              onClick={() => {
                toggleSplitView();
                refitTerminals();
              }}
              className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
                splitView
                  ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
              }`}
              title="Split into two panes"
            >
              <Columns2 size={15} />
            </button>
            <SnippetsMenu />
            <button
              onClick={() => useSessionStore.getState().setShowTunnels(true)}
              className="flex items-center justify-center w-8 h-8 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              title="SSH tunnels / port forwarding"
            >
              <Waypoints size={15} />
            </button>
            <button
              onClick={() => useSessionStore.getState().setShowIntent(true)}
              className="flex items-center justify-center w-8 h-8 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              title="Network intent / desired-state assurance"
            >
              <Target size={15} />
            </button>
            <button
              onClick={() => useSessionStore.getState().setShowApstra(true)}
              className="flex items-center justify-center w-8 h-8 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              title="Apstra blueprints (rendered configs)"
            >
              <Network size={15} />
            </button>
            <button
              onClick={() => useSessionStore.getState().setShowHelp(true)}
              className="flex items-center justify-center w-8 h-8 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              title="Help & documentation (F1)"
            >
              <HelpCircle size={15} />
            </button>
            <button
              onClick={toggleBroadcast}
              className={`flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
                broadcastMode
                  ? 'text-[var(--accent-2)] bg-[var(--accent-2-soft)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
              }`}
              title="Multi-send: run a command on multiple sessions"
            >
              <Radio size={15} />
            </button>
          </div>
        </div>

        {/* Right: connect + utilities */}
        <div className="flex items-center gap-1 no-drag">
          <button
            onClick={() => useSessionStore.getState().setShowQuickConnect(true)}
            className="btn-accent flex items-center gap-1.5 h-8 px-3 text-[12px]"
            title="New connection (Ctrl+T)"
          >
            <Plug size={13} />
            <span>Connect</span>
          </button>
          <div className="w-px h-5 bg-[var(--border)] mx-1" />
          <button
            onClick={() => setShowSearch(true)}
            className="p-2 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Search (Ctrl+F)"
          >
            <Search size={16} />
          </button>
          <button
            onClick={() => useSessionStore.getState().setShowCommandPalette(true)}
            className="p-2 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Command palette (Ctrl+K)"
          >
            <Command size={16} />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Settings (Ctrl+,)"
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

          {/* Multi-send bar — run one command on all connected sessions or a subset */}
          {broadcastMode && (() => {
            const connected = sessions.filter((s) => s.connected);
            const isTarget = (id: string) => targetMode === 'all' || selectedTargets.has(id);
            const targetCount =
              targetMode === 'all' ? connected.length : connected.filter((s) => selectedTargets.has(s.sessionId)).length;
            const toggleTarget = (id: string) =>
              setSelectedTargets((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            // First switch to "Selected" starts from all-checked, so you deselect rather
            // than build the list from nothing.
            const switchMode = (m: 'all' | 'selected') => {
              if (m === 'selected' && selectedTargets.size === 0) {
                setSelectedTargets(new Set(connected.map((s) => s.sessionId)));
              }
              setTargetMode(m);
            };
            return (
              <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 bg-[var(--accent-2-soft)] border-b border-[var(--accent-2)]/40">
                <Radio size={12} className="text-[var(--accent-2)] flex-shrink-0" />
                <span className="text-[10px] text-[var(--accent-2)] uppercase font-semibold tracking-wide flex-shrink-0">
                  Multi-send
                </span>
                {/* All / Selected toggle */}
                <div className="flex items-center rounded-md overflow-hidden border border-[var(--border)] flex-shrink-0">
                  {(['all', 'selected'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => switchMode(m)}
                      className={`px-2 py-0.5 text-[10px] capitalize transition-colors ${
                        targetMode === m
                          ? 'bg-[var(--accent-2)] text-white'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                {/* Target chips */}
                {connected.length === 0 ? (
                  <span className="text-[10px] text-[var(--text-muted)]">No connected sessions</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-1">
                    {connected.map((s) => {
                      const on = isTarget(s.sessionId);
                      const label = s.config.name || s.config.host || 'session';
                      return (
                        <button
                          key={s.sessionId}
                          onClick={() => targetMode === 'selected' && toggleTarget(s.sessionId)}
                          disabled={targetMode === 'all'}
                          title={
                            targetMode === 'selected'
                              ? on
                                ? 'Click to exclude'
                                : 'Click to include'
                              : 'All connected sessions'
                          }
                          className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                            on
                              ? 'bg-[var(--accent-2-soft)] border-[var(--accent-2)] text-[var(--accent-2)]'
                              : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                          } ${targetMode === 'all' ? 'cursor-default' : 'cursor-pointer'}`}
                        >
                          {on ? '✓ ' : ''}
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
                <input
                  value={broadcastInput}
                  onChange={(e) => setBroadcastInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      sendBroadcast();
                    }
                  }}
                  placeholder={`Command to send to ${targetCount} session${targetCount === 1 ? '' : 's'}…`}
                  className="flex-1 min-w-[140px] h-7 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-2)]"
                />
                <button
                  onClick={sendBroadcast}
                  disabled={targetCount === 0}
                  className="px-2.5 py-1 text-xs bg-[var(--accent-2)] hover:brightness-110 disabled:opacity-40 text-white rounded transition-colors flex-shrink-0"
                >
                  Send to {targetCount}
                </button>
              </div>
            );
          })()}

          {/* Terminal Container + Side Panels */}
          <div className="flex flex-1 overflow-hidden">
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
                  // (and avoids disposing an xterm mid-render). Active = left/full,
                  // secondary = right half in split, the rest are display:none.
                  <div className="h-full w-full relative">
                    {canSplit && (
                      <>
                        {/* Pane headers — pane 1 is the active session; panes
                            2..N carry a session picker, a close button, and the
                            last pane an add-pane button (max 4 columns). */}
                        {paneSessions.map((p, i) => {
                          const accent = vendorColor(p.config.deviceType);
                          return (
                            <div
                              key={`pane-h-${p.sessionId}`}
                              className="absolute top-0 z-10 flex items-center gap-2 h-7 px-2.5 bg-[var(--bg-secondary)] border-b border-[var(--border)]"
                              style={{
                                left: `${paneOffset(i) * 100}%`,
                                width: `${ratioAt(i) * 100}%`,
                              }}
                            >
                              <span
                                className="vendor-dot flex-shrink-0"
                                style={{ background: accent, color: accent }}
                              />
                              {i === 0 ? (
                                <span className="flex-1 min-w-0 text-[11px] font-medium text-[var(--text-primary)] truncate">
                                  {p.config.name || p.config.host || 'Session'}
                                </span>
                              ) : (
                                <select
                                  value={p.sessionId}
                                  onChange={(e) => {
                                    setSplitPaneAt(i - 1, e.target.value);
                                    refitTerminals();
                                  }}
                                  className="flex-1 min-w-0 text-[11px] bg-transparent border-0 text-[var(--text-primary)] focus:outline-none cursor-pointer"
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
                              )}
                              {i === paneSessions.length - 1 &&
                                paneSessions.length < 4 &&
                                unusedPaneCandidates.length > 0 && (
                                  <button
                                    onClick={addSplitPane}
                                    className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0"
                                    title="Add pane"
                                  >
                                    <Plus size={12} />
                                  </button>
                                )}
                              {i > 0 && (
                                <button
                                  onClick={() => {
                                    removeSplitPane(p.sessionId);
                                    refitTerminals();
                                  }}
                                  className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0"
                                  title="Close pane"
                                >
                                  <X size={12} />
                                </button>
                              )}
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
                        <div key={s.sessionId} style={style}>
                          <Terminal
                            sessionId={s.sessionId}
                            deviceType={s.config.deviceType}
                            onSend={(data) => {
                              const current = useSessionStore
                                .getState()
                                .sessions.find((session) => session.sessionId === s.sessionId);
                              if (!current?.connected) return;
                              invoke('send_data', { sessionId: s.sessionId, data }).catch(console.error);
                            }}
                          />
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
                        ['Ctrl+T', 'Connect'],
                        ['Ctrl+K', 'Commands'],
                        ['Ctrl+F', 'Search'],
                        ['Ctrl+Shift+E', 'Editor'],
                        ['Ctrl+Shift+A', 'API'],
                        ['Ctrl+Shift+I', 'AI'],
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

            {/* Config Editor Panel */}
            {showConfigEditor && <ConfigEditor />}

            {/* API Explorer Panel */}
            {showApiExplorer && <ApiExplorer />}

            {/* AI Assistant Panel */}
            {showAiAssistant && <AiAssistant />}
          </div>
        </div>
      </div>

      {/* Modals & Overlays */}
      <BulkRunner />
      {showSftp && activeSessionId && (
        <SftpBrowser sessionId={activeSessionId} onClose={() => setShowSftp(false)} />
      )}
      <VaultUnlock onUnlocked={flushPendingCredSave} />
      <CommandPalette onConnect={handleConnect} onLocalShell={openLocalShell} onConnectRecent={connectRecent} />
      <TunnelsManager />
      <IntentPanel />
      <HelpPanel />
      <ApstraBrowser />
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
