import { useEffect, useCallback, useState } from 'react';
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
import SshAuthDialog from './components/SshAuthDialog';
import SettingsPanel from './components/SettingsPanel';
import SearchOverlay from './components/SearchOverlay';
import ApiExplorer from './components/ApiExplorer';
import AiAssistant from './components/AiAssistant';
import ConfigEditor from './components/ConfigEditor';
import SnippetsMenu from './components/SnippetsMenu';
import CommandPalette from './components/CommandPalette';

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
    setFolders,
  } = useSessionStore();

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

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

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
            password: fullConfig.password,
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
    [addSession, setPendingConnection, setShowAuthDialog]
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
    async (password: string, _saveCredential: boolean) => {
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
            auth_type: pending.authType || 'password',
            password,
            private_key: pending.privateKey,
            key_passphrase: pending.keyPassphrase,
            serial_port: pending.serialPort,
            baud_rate: pending.baudRate,
            device_type: pending.deviceType,
            keep_alive_interval: useSettingsStore.getState().keepAliveInterval,
            auto_reconnect: useSettingsStore.getState().autoReconnect,
          },
        });

        if (result.success) {
          useSessionStore
            .getState()
            .updateSessionConnection(pending.id, true);
        }
      } catch (err) {
        console.error('Auth connection error:', err);
      }
    },
    []
  );

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden"
      data-theme={theme}
      style={{ background: theme === 'dark' ? '#0d1117' : '#ffffff' }}
    >
      {/* Title Bar */}
      <div className="flex items-center justify-between h-9 px-3 bg-[#161b22] border-b border-[#21262d] drag-region">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-[#c9d1d9]">
            Aruba Terminal Pro
          </span>
          {!sidebarVisible && (
            <button
              onClick={() =>
                useSessionStore.getState().toggleSidebar()
              }
              className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]"
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
                : 'text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]'
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
                : 'text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]'
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
                : 'text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]'
            }`}
            title="AI Assistant (Ctrl+Shift+I)"
          >
            <Sparkles size={12} />
            <span>AI</span>
          </button>
          {/* Snippets */}
          <SnippetsMenu />

          {/* Broadcast toggle */}
          <button
            onClick={toggleBroadcast}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
              broadcastMode
                ? 'text-[#ff7b72] bg-[#ff7b7220]'
                : 'text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]'
            }`}
            title="Broadcast a command to all connected sessions"
          >
            <Radio size={12} />
            <span>Broadcast</span>
          </button>
          <div className="w-px h-4 bg-[#30363d] mx-1" />
          <button
            onClick={() =>
              useSessionStore.getState().setShowQuickConnect(true)
            }
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] rounded transition-colors"
          >
            <Plug size={12} />
            <span>Connect</span>
          </button>
          <button
            onClick={() => setShowSearch(true)}
            className="p-1.5 text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] rounded transition-colors"
            title="Search (Ctrl+F)"
          >
            <Search size={14} />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] rounded transition-colors"
            title="Settings (Ctrl+,)"
          >
            <Settings size={14} />
          </button>
          <button
            onClick={() => useSessionStore.getState().setShowCommandPalette(true)}
            className="p-1.5 text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] rounded transition-colors"
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
                className="flex-1 h-7 px-2 bg-[#0d1117] border border-[#30363d] rounded text-xs text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#ff7b72]"
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
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-[#484f58]">
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
                        className="flex items-center gap-1.5 px-4 py-2 text-sm bg-[#21262d] hover:bg-[#30363d] text-[#c9d1d9] rounded-lg transition-colors"
                        title="Open a local shell terminal"
                      >
                        <FileCode size={14} />
                        Local Shell
                      </button>
                    </div>
                    <div className="mt-6 text-xs space-y-1 text-center">
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[#21262d] rounded text-[#8b949e]">
                          Ctrl+T
                        </kbd>{' '}
                        Quick Connect
                      </p>
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[#21262d] rounded text-[#8b949e]">
                          Ctrl+W
                        </kbd>{' '}
                        Close Tab
                      </p>
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[#21262d] rounded text-[#8b949e]">
                          Ctrl+F
                        </kbd>{' '}
                        Search
                      </p>
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[#21262d] rounded text-[#8b949e]">
                          Ctrl+Shift+E
                        </kbd>{' '}
                        Config Editor
                      </p>
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[#21262d] rounded text-[#8b949e]">
                          Ctrl+Shift+A
                        </kbd>{' '}
                        API Explorer
                      </p>
                      <p>
                        <kbd className="px-1.5 py-0.5 bg-[#21262d] rounded text-[#8b949e]">
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
      <CommandPalette onConnect={handleConnect} onLocalShell={openLocalShell} />
      <QuickConnect onConnect={handleConnect} />
      <SshAuthDialog onAuthenticate={handleAuthenticate} />
      <SettingsPanel />
    </div>
  );
}

export default App;
