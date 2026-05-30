import { useEffect, useCallback, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import {
  Settings,
  Search,
  PanelLeft,
  Plug,
  HelpCircle,
  Globe,
  Sparkles,
  FileCode,
  Radio,
  Columns2,
} from 'lucide-react';

import { useSessionStore } from './store/sessionStore';
import { useSettingsStore } from './store/settingsStore';
import { useTheme } from './hooks/useTheme';
import { ConnectionConfig, Protocol } from './types';
import { generateId } from './utils';

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
import VaultUnlock from './components/VaultUnlock';
import BulkRunner from './components/BulkRunner';
import SftpBrowser from './components/SftpBrowser';

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

  const [broadcastInput, setBroadcastInput] = useState('');

  // Send a command to every connected session at once.
  const sendBroadcast = useCallback(() => {
    const cmd = broadcastInput;
    if (!cmd.trim()) return;
    sessions
      .filter((s) => s.connected)
      .forEach((s) =>
        invoke('send_data', { sessionId: s.sessionId, data: cmd + '\r' }).catch(() => {})
      );
    setBroadcastInput('');
  }, [broadcastInput, sessions]);

  // Load saved sessions from backend on mount
  useEffect(() => {
    invoke<Array<{ id: string; name: string; items: Array<{ id: string; name: string; protocol: string; host?: string; port?: number; username?: string; authType?: string; deviceType: string; serialPort?: string; baudRate?: number }>; expanded: boolean }>>('list_folders')
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
              deviceType: (s.deviceType ?? 'generic') as 'aruba-cx' | 'aruba-ap' | 'aruba-controller' | 'generic',
              serialPort: s.serialPort,
              baudRate: s.baudRate,
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
  useEffect(() => {
    if (centralBaseUrl && centralClientId && centralClientSecret) {
      invoke('central_configure', {
        baseUrl: centralBaseUrl,
        clientId: centralClientId,
        clientSecret: centralClientSecret,
      }).catch(() => {});
    }
  }, [centralBaseUrl, centralClientId, centralClientSecret]);

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
          }
        } else {
          useSessionStore.getState().updateSessionConnection(sessionId, true);
        }
      } catch (err) {
        console.error('Connection error:', err);
        // For local/serial there's no auth to retry — surface the failure on the tab.
        if (fullConfig.protocol === 'ssh' || fullConfig.protocol === 'telnet') {
          setPendingConnection(fullConfig);
          setShowAuthDialog(true);
        } else {
          useSessionStore.getState().updateSessionConnection(sessionId, false);
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
            auth_type: creds.authType === 'key' ? 'key' : 'password',
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
      style={{ background: theme === 'dark' ? 'var(--bg-primary)' : '#ffffff' }}
    >
      {/* Title Bar */}
      <div className="flex items-center justify-between h-9 px-3 bg-[var(--bg-secondary)] border-b border-[var(--bg-tertiary)] drag-region">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            Aruba Terminal Pro
          </span>
          {!sidebarVisible && (
            <button
              onClick={() =>
                useSessionStore.getState().toggleSidebar()
              }
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <PanelLeft size={14} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Config Editor Toggle */}
          <button
            onClick={toggleConfigEditor}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
              showConfigEditor
                ? 'text-[#e5c07b] bg-[#e5c07b20]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title="Config Editor (Ctrl+Shift+E)"
          >
            <FileCode size={12} />
            <span>Editor</span>
          </button>
          {/* API Explorer Toggle */}
          <button
            onClick={toggleApiExplorer}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
              showApiExplorer
                ? 'text-[#58a6ff] bg-[#58a6ff20]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title="API Explorer (Ctrl+Shift+A)"
          >
            <Globe size={12} />
            <span>API</span>
          </button>
          {/* AI Assistant Toggle */}
          <button
            onClick={toggleAiAssistant}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
              showAiAssistant
                ? 'text-[#d2a8ff] bg-[#d2a8ff20]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title="AI Assistant (Ctrl+Shift+I)"
          >
            <Sparkles size={12} />
            <span>AI</span>
          </button>
          {/* Split view toggle */}
          <button
            onClick={() => {
              toggleSplitView();
              refitTerminals();
            }}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
              splitView
                ? 'text-[#58a6ff] bg-[#58a6ff20]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title="Split the terminal into two panes"
          >
            <Columns2 size={12} />
            <span>Split</span>
          </button>

          {/* Snippets */}
          <SnippetsMenu />

          {/* Broadcast toggle */}
          <button
            onClick={toggleBroadcast}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
              broadcastMode
                ? 'text-[#ff7b72] bg-[#ff7b7220]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title="Broadcast a command to all connected sessions"
          >
            <Radio size={12} />
            <span>Broadcast</span>
          </button>
          <div className="w-px h-4 bg-[var(--border)] mx-1" />
          <button
            onClick={() =>
              useSessionStore.getState().setShowQuickConnect(true)
            }
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
          >
            <Plug size={12} />
            <span>Connect</span>
          </button>
          <button
            onClick={() => setShowSearch(true)}
            className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
            title="Search (Ctrl+F)"
          >
            <Search size={14} />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
            title="Settings (Ctrl+,)"
          >
            <Settings size={14} />
          </button>
          <button
            onClick={() => useSessionStore.getState().setShowCommandPalette(true)}
            className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
            title="Command palette (Ctrl+K)"
          >
            <HelpCircle size={14} />
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
            {/* Terminal */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex-1 relative overflow-hidden">
                {activeSession ? (
                  canSplit && secondarySession ? (
                    <div className="flex h-full w-full">
                      {/* Left pane: active session */}
                      <div className="flex-1 min-w-0 border-r border-[var(--bg-tertiary)]">
                        <Terminal
                          key={activeSession.sessionId}
                          sessionId={activeSession.sessionId}
                          deviceType={activeSession.config.deviceType}
                          onSend={(data) => {
                            invoke('send_data', { sessionId: activeSession.sessionId, data }).catch(console.error);
                          }}
                        />
                      </div>
                      {/* Right pane: selectable secondary session */}
                      <div className="flex-1 min-w-0 flex flex-col">
                        <div className="flex items-center gap-2 h-7 px-2 bg-[var(--bg-secondary)] border-b border-[var(--bg-tertiary)] flex-shrink-0">
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
                        <div className="flex-1 min-h-0">
                          <Terminal
                            key={secondarySession.sessionId}
                            sessionId={secondarySession.sessionId}
                            deviceType={secondarySession.config.deviceType}
                            onSend={(data) => {
                              invoke('send_data', { sessionId: secondarySession.sessionId, data }).catch(console.error);
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <Terminal
                      key={activeSession.sessionId}
                      sessionId={activeSession.sessionId}
                      deviceType={activeSession.config.deviceType}
                      onSend={(data) => {
                        invoke('send_data', {
                          sessionId: activeSession.sessionId,
                          data,
                        }).catch(console.error);
                      }}
                    />
                  )
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)]">
                    <Plug size={48} className="mb-4 opacity-30" />
                    <p className="text-lg font-medium mb-2">
                      No Active Session
                    </p>
                    <p className="text-sm mb-4">
                      Connect to a device to start your session
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          useSessionStore
                            .getState()
                            .setShowQuickConnect(true)
                        }
                        className="px-4 py-2 text-sm bg-[#238636] hover:bg-[#2ea043] text-white rounded-lg transition-colors"
                      >
                        Quick Connect
                      </button>
                      <button
                        onClick={openLocalShell}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm bg-[var(--bg-tertiary)] hover:bg-[var(--border)] text-[var(--text-primary)] rounded-lg transition-colors"
                        title="Open a local shell terminal"
                      >
                        <FileCode size={14} />
                        Local Shell
                      </button>
                    </div>
                    <div className="mt-6 text-xs space-y-1 text-center">
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-secondary)]">
                          Ctrl+T
                        </kbd>{' '}
                        Quick Connect
                      </p>
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-secondary)]">
                          Ctrl+W
                        </kbd>{' '}
                        Close Tab
                      </p>
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-secondary)]">
                          Ctrl+F
                        </kbd>{' '}
                        Search
                      </p>
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-secondary)]">
                          Ctrl+Shift+E
                        </kbd>{' '}
                        Config Editor
                      </p>
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-secondary)]">
                          Ctrl+Shift+A
                        </kbd>{' '}
                        API Explorer
                      </p>
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] rounded text-[var(--text-secondary)]">
                          Ctrl+Shift+I
                        </kbd>{' '}
                        AI Assistant
                      </p>
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
      <QuickConnect onConnect={handleConnect} />
      <SshAuthDialog onAuthenticate={handleAuthenticate} />
      <SettingsPanel />
    </div>
  );
}

export default App;
