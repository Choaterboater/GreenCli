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
} from 'lucide-react';

import { useSessionStore } from './store/sessionStore';
import { useSettingsStore } from './store/settingsStore';
import { loadSecrets, persistSecrets } from './utils/secretVault';
import { useTheme } from './hooks/useTheme';
import { ConnectionConfig, Protocol, DeviceType } from './types';
import { generateId } from './utils';
import { notify } from './store/toastStore';
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

// Run a session's per-host startup commands once the shell is ready. Shared by the
// direct-connect path and the auth-dialog retry path so behaviour is consistent.
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
    secondarySessionId,
    toggleSplitView,
    setSecondarySession,
    vaultUnlocked,
    setVaultUnlocked,
    setShowVaultUnlock,
    setFolders,
    showSftp,
    setShowSftp,
  } = useSessionStore();

  // Credential save deferred until the vault is unlocked.
  const pendingCredSave = useRef<{ key: string; value: string } | null>(null);

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
  }, [activeSessionId, splitView, secondarySessionId]);

  const [broadcastInput, setBroadcastInput] = useState('');

  // Detect macOS desktop build so the title bar can clear the native traffic
  // lights (window uses an overlay title bar). In the browser dev preview there
  // is no Tauri IPC, so we keep the normal inset.
  const isTauriMac =
    typeof navigator !== 'undefined' &&
    /Mac/.test(navigator.userAgent) &&
    typeof window !== 'undefined' &&
    '__TAURI_IPC__' in window;

  // Send a command to every connected session at once.
  const sendBroadcast = useCallback(() => {
    const cmd = broadcastInput;
    if (!cmd.trim()) return;
    const targets = sessions.filter((s) => s.connected);
    if (targets.length === 0) {
      notify.warning('Nothing to broadcast', 'No sessions are currently connected.');
      return;
    }
    targets.forEach((s) =>
      invoke('send_data', { sessionId: s.sessionId, data: cmd + '\r' }).catch(() => {})
    );
    notify.success('Broadcast sent', `Sent to ${targets.length} session${targets.length > 1 ? 's' : ''}.`);
    setBroadcastInput('');
  }, [broadcastInput, sessions]);

  // Load saved sessions from backend on mount
  useEffect(() => {
    invoke<Array<{ id: string; name: string; items: Array<{ id: string; name: string; protocol: string; host?: string; port?: number; username?: string; authType?: string; deviceType: string; serialPort?: string; baudRate?: number; dataBits?: number; parity?: string; stopBits?: number; startupCommands?: string; tags?: string[]; jumpHost?: string; jumpPort?: number; jumpUsername?: string }>; expanded: boolean }>>('list_folders')
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
              serialPort: s.serialPort,
              baudRate: s.baudRate,
              dataBits: s.dataBits,
              parity: s.parity,
              stopBits: s.stopBits,
              startupCommands: s.startupCommands,
              tags: s.tags,
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
    if (!centralBaseUrl) return;
    if (centralAuthMode === 'token') {
      if (centralToken) {
        invoke('central_set_token', { baseUrl: centralBaseUrl, token: centralToken }).catch(() => {});
      }
    } else if (centralClientId && centralClientSecret) {
      invoke('central_configure', {
        baseUrl: centralBaseUrl,
        clientId: centralClientId,
        clientSecret: centralClientSecret,
      }).catch(() => {});
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
  }, [vaultUnlocked, centralClientSecret, centralToken, apstraPassword, mistToken, centralAccounts]);

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

  // Second pane for split view: the chosen secondary session, or any other open
  // session, but never the same one shown on the left.
  const secondarySession =
    sessions.find((s) => s.sessionId === secondarySessionId && s.sessionId !== activeSessionId) ||
    sessions.find((s) => s.sessionId !== activeSessionId);
  const canSplit = splitView && !!activeSession && !!secondarySession;

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // F1: Help & documentation
      if (e.key === 'F1') {
        e.preventDefault();
        const s = useSessionStore.getState();
        s.setShowHelp(!s.showHelp);
      }
      // Ctrl+K: Command Palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        useSessionStore.getState().setShowCommandPalette(true);
      }
      // Ctrl+T: Quick Connect
      if ((e.ctrlKey || e.metaKey) && e.key === 't') {
        e.preventDefault();
        useSessionStore.getState().setShowQuickConnect(true);
      }
      // Ctrl+W: Close Tab
      if ((e.ctrlKey || e.metaKey) && e.key === 'w' && activeSessionId) {
        e.preventDefault();
        invoke('disconnect', { sessionId: activeSessionId }).catch(() => {});
        removeSession(activeSessionId);
      }
      // Ctrl+1..9: jump to tab N
      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (sessions[idx]) {
          e.preventDefault();
          useSessionStore.getState().setActiveSession(sessions[idx].sessionId);
        }
      }
      // Ctrl+Tab: cycle to next tab
      if (e.ctrlKey && e.key === 'Tab' && sessions.length > 1) {
        e.preventDefault();
        const cur = sessions.findIndex((s) => s.sessionId === activeSessionId);
        const next = sessions[(cur + 1) % sessions.length];
        useSessionStore.getState().setActiveSession(next.sessionId);
      }
      // Ctrl+F: Search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
      }
      // Ctrl+,: Settings
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setShowSettings(true);
      }
      // Ctrl+B: Toggle Sidebar
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
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
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSessionId, sessions, removeSession, setShowSearch, setShowSettings, toggleApiExplorer, toggleAiAssistant, toggleConfigEditor]);

  const handleConnect = useCallback(
    async (config: ConnectionConfig) => {
      const sessionId = config.id || generateId();
      const fullConfig = { ...config, id: sessionId };

      // A saved host carries a stable id. If its tab is already open AND connected,
      // just focus it — don't run a second backend connect against the live session
      // id (which orphans the first connection and duplicates terminal output).
      const existing = useSessionStore.getState().sessions.find((s) => s.sessionId === sessionId);
      if (existing?.connected) {
        useSessionStore.getState().setActiveSession(sessionId);
        return;
      }

      addSession(fullConfig, sessionId);

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
          if (authBased) {
            setPendingConnection(fullConfig);
            setShowAuthDialog(true);
          } else {
            // local/serial: no auth to retry — surface the failure.
            useSessionStore.getState().updateSessionConnection(sessionId, false);
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
        if (fullConfig.protocol === 'ssh' || fullConfig.protocol === 'telnet') {
          setPendingConnection(fullConfig);
          setShowAuthDialog(true);
        } else {
          useSessionStore.getState().updateSessionConnection(sessionId, false);
          notify.error(
            `Could not start ${fullConfig.name || fullConfig.protocol}`,
            String(err)
          );
        }
      }
    },
    [addSession, setPendingConnection, setShowAuthDialog, vaultUnlocked]
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

  const handleAuthenticate = useCallback(
    async (creds: AuthCredentials, saveCredential: boolean) => {
      const pending = useSessionStore.getState().pendingConnection;
      if (!pending) return;

      try {
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
            keep_alive_interval: useSettingsStore.getState().keepAliveInterval,
            auto_reconnect: useSettingsStore.getState().autoReconnect,
            jump_host: pending.jumpHost,
            jump_port: pending.jumpPort,
            jump_username: pending.jumpUsername,
            jump_password: pending.jumpPassword,
          },
        });

        if (result.success) {
          useSessionStore.getState().updateSessionConnection(pending.id, true);
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
        }
      } catch (err) {
        console.error('Auth connection error:', err);
      }
    },
    [setShowAuthDialog, vaultUnlocked, setShowVaultUnlock]
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
      {/* Title Bar */}
      <div
        className="flex items-center justify-between h-11 pr-2 bg-[var(--bg-secondary)] border-b border-[var(--border)] drag-region select-none"
        style={{ paddingLeft: isTauriMac ? 80 : 12 }}
      >
        {/* Left: brand + sidebar toggle */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center gap-2">
            <div
              className="flex items-center justify-center w-[26px] h-[26px] rounded-md flex-shrink-0"
              style={{
                background: 'linear-gradient(135deg, var(--accent-hover), var(--accent))',
                boxShadow: 'var(--elevation-1)',
              }}
            >
              <TerminalSquare size={15} style={{ color: 'var(--accent-fg)' }} />
            </div>
            <span className="text-[13px] font-semibold text-[var(--text-primary)] tracking-tight whitespace-nowrap">
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
              title="Broadcast a command to all connected sessions"
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
          <TerminalTabs />

          {/* Broadcast bar */}
          {broadcastMode && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#3d1518]/40 border-b border-[#ff7b7240]">
              <Radio size={12} className="text-[#ff7b72] flex-shrink-0" />
              <span className="text-[10px] text-[#ff7b72] uppercase font-medium flex-shrink-0">
                Broadcast
              </span>
              <input
                value={broadcastInput}
                onChange={(e) => setBroadcastInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    sendBroadcast();
                  }
                }}
                placeholder={`Send a command to all ${
                  sessions.filter((s) => s.connected).length
                } connected session(s)…`}
                className="flex-1 h-7 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#ff7b72]"
              />
              <button
                onClick={sendBroadcast}
                className="px-2.5 py-1 text-xs bg-[#da3633] hover:bg-[#f85149] text-white rounded transition-colors flex-shrink-0"
              >
                Send to all
              </button>
            </div>
          )}

          {/* Terminal Container + Side Panels */}
          <div className="flex flex-1 overflow-hidden">
            {/* Terminal — hidden with no sessions + editor open, so the editor fills
                the area and works as a standalone text editor. */}
            <div className={`flex-1 flex flex-col min-w-0 ${!activeSession && showConfigEditor ? 'hidden' : ''}`}>
              <div className="flex-1 relative overflow-hidden">
                {activeSession ? (
                  // Every session's terminal stays MOUNTED — we only show/hide it via
                  // CSS — so switching tabs preserves each terminal's screen + scrollback
                  // (and avoids disposing an xterm mid-render). Active = left/full,
                  // secondary = right half in split, the rest are display:none.
                  <div className="h-full w-full relative">
                    {canSplit && secondarySession && (
                      <div className="absolute top-0 right-0 w-1/2 z-10 flex items-center gap-2 h-7 px-2 bg-[var(--bg-secondary)] border-b border-l border-[var(--bg-tertiary)]">
                        <span className="text-[10px] text-[var(--text-secondary)]">Pane 2</span>
                        <select
                          value={secondarySession.sessionId}
                          onChange={(e) => {
                            setSecondarySession(e.target.value);
                            refitTerminals();
                          }}
                          className="flex-1 text-[11px] bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1 py-0.5 text-[var(--text-primary)] focus:outline-none focus:border-[#58a6ff]"
                        >
                          {sessions
                            .filter((s) => s.sessionId !== activeSessionId)
                            .map((s) => (
                              <option key={s.sessionId} value={s.sessionId}>
                                {s.config.name || s.config.host || 'Session'}
                              </option>
                            ))}
                        </select>
                      </div>
                    )}
                    {sessions.map((s) => {
                      const isActive = s.sessionId === activeSessionId;
                      const isSecondary =
                        canSplit && !isActive && secondarySession?.sessionId === s.sessionId;
                      const visible = isActive || isSecondary;
                      const style: React.CSSProperties = !visible
                        ? { display: 'none' }
                        : canSplit
                        ? {
                            position: 'absolute',
                            top: isSecondary ? 28 : 0,
                            bottom: 0,
                            left: isActive ? 0 : 'auto',
                            right: isSecondary ? 0 : 'auto',
                            width: '50%',
                            borderRight: isActive ? '1px solid var(--bg-tertiary)' : undefined,
                          }
                        : { position: 'absolute', inset: 0 };
                      return (
                        <div key={s.sessionId} style={style}>
                          <Terminal
                            sessionId={s.sessionId}
                            deviceType={s.config.deviceType}
                            onSend={(data) => {
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
                      <TerminalSquare size={30} style={{ color: 'var(--accent-fg)' }} />
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
              <StatusBar />
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
      <CommandPalette onConnect={handleConnect} onLocalShell={openLocalShell} />
      <TunnelsManager />
      <IntentPanel />
      <HelpPanel />
      <ApstraBrowser />
      <QuickConnect onConnect={handleConnect} />
      <SshAuthDialog onAuthenticate={handleAuthenticate} />
      <SettingsPanel />
      <DialogHost />
      <Toaster />
    </div>
  );
}

export default App;
