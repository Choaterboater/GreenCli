import { useState, useEffect } from 'react';
import { Shield, ShieldOff, Usb, Zap, TerminalSquare, CircleDot, Circle, ClipboardList, Trash2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { deviceMeta, vendorColor } from '../types';
import { notify } from '../store/toastStore';
import { useSettingsStore } from '../store/settingsStore';
import { askConfirm } from '../store/dialogStore';
import { countPasteLines, useTerminalToolsStore } from '../store/terminalToolsStore';
import { getTerminalActionAdapter } from '../utils/terminalActions';

const protocolIcons: Record<string, React.ReactNode> = {
  ssh: <Shield size={12} className="text-[var(--accent-info)]" />,
  telnet: <ShieldOff size={12} className="text-[var(--accent-warning)]" />,
  serial: <Usb size={12} className="text-[var(--text-secondary)]" />,
  local: <TerminalSquare size={12} className="text-[var(--accent-success)]" />,
};

interface StatusBarProps {
  onReconnect?: (sessionId: string) => void;
  onDisconnect?: (sessionId: string) => void;
  onMapDevice?: (sessionId: string) => void;
}

export default function StatusBar({ onReconnect, onDisconnect, onMapDevice }: StatusBarProps) {
  const { sessions, activeSessionId } = useSessionStore();
  const settings = useSettingsStore();
  const { pasteHistory, clearPasteHistory, removePaste } = useTerminalToolsStore();
  const [logging, setLogging] = useState(false);
  const [logHint, setLogHint] = useState<string | null>(null);
  const [showPasteHistory, setShowPasteHistory] = useState(false);

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
  const activePasteHistory = activeSession
    ? pasteHistory.filter((entry) => entry.sessionId === activeSession.sessionId).slice(0, 8)
    : [];

  // Auto-close the paste-history popover when the history empties (e.g. after
  // removing every entry) — otherwise the disabled toggle leaves it stuck open.
  useEffect(() => {
    if (showPasteHistory && activePasteHistory.length === 0) {
      setShowPasteHistory(false);
    }
  }, [showPasteHistory, activePasteHistory.length]);

  // Reflect logging state when the active session changes.
  useEffect(() => {
    setLogHint(null);
    if (!activeSessionId) {
      setLogging(false);
      return;
    }
    invoke<boolean>('is_session_logging', { sessionId: activeSessionId })
      .then(setLogging)
      .catch(() => setLogging(false));
  }, [activeSessionId]);

  const toggleLog = async () => {
    if (!activeSession) return;
    try {
      if (logging) {
        await invoke('stop_session_log', { sessionId: activeSession.sessionId });
        setLogging(false);
        setLogHint('log saved');
        setTimeout(() => setLogHint(null), 3000);
      } else {
        const path = await invoke<string>('start_session_log', {
          sessionId: activeSession.sessionId,
          name: activeSession.config.name || activeSession.config.host || 'session',
        });
        setLogging(true);
        const file = path.replace(/\\/g, '/').split('/').pop();
        setLogHint(`→ ${file}`);
        setTimeout(() => setLogHint(null), 4000);
      }
    } catch (e) {
      // The generic "requires the desktop app" message masked real causes
      // (permission denied, disk full, bad log directory) behind one that's
      // only true when there's no Tauri backend at all.
      notify.warning('Session logging unavailable', String(e));
    }
  };

  const pasteFromHistory = async (text: string) => {
    if (!activeSession) return;
    const lineCount = countPasteLines(text);
    if (settings.pasteGuardEnabled && lineCount >= settings.pasteGuardLineThreshold) {
      const ok = await askConfirm({
        title: `Paste ${lineCount} lines into ${activeSession.config.name || activeSession.config.host || 'terminal'}?`,
        message: 'This will send the saved paste directly to the active terminal.',
        confirmLabel: 'Paste',
      });
      if (!ok) return;
    }
    const adapter = getTerminalActionAdapter(activeSession.sessionId);
    if (!adapter) {
      notify.warning('Terminal unavailable', 'Activate the terminal tab and try again.');
      return;
    }
    adapter.paste(text);
    setShowPasteHistory(false);
  };

  const meta = activeSession ? deviceMeta(activeSession.config.deviceType) : null;
  const connectionStatus = activeSession?.connectionStatus ?? (activeSession?.connected ? 'connected' : 'disconnected');
  const isBusy = connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
  const statusLabel =
    connectionStatus === 'reconnecting'
      ? 'Reconnecting'
      : connectionStatus === 'connecting'
        ? 'Connecting'
        : activeSession?.connected
          ? 'Connected'
          : 'Disconnected';

  return (
    <div className="flex items-center h-7 px-3 bg-[var(--bg-secondary)] border-t border-[var(--border)] text-[11px] text-[var(--text-secondary)]">
      {activeSession ? (
        <>
          {/* Protocol */}
          <div className="flex items-center gap-1.5 mr-4">
            {protocolIcons[activeSession.config.protocol] || <Zap size={12} />}
            <span className="uppercase font-medium tracking-wide">
              {activeSession.config.protocol}
            </span>
          </div>

          {/* Connection info */}
          <div className="flex items-center gap-1.5 mr-4 min-w-0 text-[var(--text-muted)]">
            <span className="truncate max-w-[40ch]">
              {activeSession.config.protocol === 'local' ? (
                activeSession.config.command || 'shell'
              ) : (
                <>
                  {activeSession.config.username ? `${activeSession.config.username}@` : ''}
                  {activeSession.config.host || activeSession.config.serialPort}
                  {activeSession.config.port && activeSession.config.port !== 22
                    ? `:${activeSession.config.port}`
                    : ''}
                </>
              )}
            </span>
          </div>

          {/* Status */}
          <div 
            className={`flex items-center gap-1.5 mr-4 px-1.5 py-0.5 rounded transition-colors ${
              isBusy ? 'cursor-default' : 'cursor-pointer hover:bg-[var(--bg-tertiary)]'
            }`}
            onClick={() => {
              if (isBusy) return;
              if (activeSession.connected) {
                onDisconnect?.(activeSession.sessionId);
              } else {
                onReconnect?.(activeSession.sessionId);
              }
            }}
            title={
              isBusy
                ? statusLabel
                : activeSession.connected
                  ? 'Click to disconnect'
                  : 'Click to reconnect'
            }
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${activeSession.connected || isBusy ? 'animate-pulse' : ''}`}
              style={{
                background: activeSession.connected
                  ? 'var(--accent-success)'
                  : isBusy
                    ? 'var(--accent-warning)'
                    : 'var(--accent-danger)',
              }}
            />
            <span
              style={{
                color: activeSession.connected
                  ? 'var(--accent-success)'
                  : isBusy
                    ? 'var(--accent-warning)'
                    : 'var(--accent-danger)',
              }}
            >
              {statusLabel}
            </span>
          </div>

          {/* Session log toggle */}
          <div className="flex items-center gap-2 ml-auto mr-3">
            {logHint && <span className="text-[10px] text-[var(--text-muted)]">{logHint}</span>}
            <div className="relative">
              <button
                onClick={() => setShowPasteHistory((v) => !v)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                  activePasteHistory.length
                    ? 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                    : 'text-[var(--text-muted)] opacity-60'
                }`}
                title="Paste history for this session"
                disabled={!activeSession || activePasteHistory.length === 0}
              >
                <ClipboardList size={11} />
                Paste
              </button>

              {showPasteHistory && activeSession && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowPasteHistory(false)} />
                  <div className="absolute bottom-7 right-0 z-50 w-80 max-h-80 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
                      <span className="text-xs font-semibold text-[var(--text-primary)]">Paste history</span>
                      <button
                        onClick={() => {
                          clearPasteHistory(activeSession.sessionId);
                          setShowPasteHistory(false);
                        }}
                        className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent-danger)]"
                        title="Clear this session's paste history"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div className="max-h-64 overflow-y-auto py-1">
                      {activePasteHistory.map((entry) => (
                        <div
                          key={entry.id}
                          className="group flex items-start gap-2 px-2 py-1.5 hover:bg-[var(--bg-tertiary)]"
                        >
                          <button
                            onClick={() => pasteFromHistory(entry.text)}
                            className="min-w-0 flex-1 text-left"
                            title="Paste this entry"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[10px] text-[var(--text-muted)]">
                                {entry.lineCount} line{entry.lineCount === 1 ? '' : 's'}
                              </span>
                              <span className="text-[10px] text-[var(--text-muted)]">
                                {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                            <pre className="mt-0.5 max-h-12 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-[var(--text-secondary)]">
                              {entry.text.slice(0, 260)}
                            </pre>
                          </button>
                          <button
                            onClick={() => removePaste(entry.id)}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--bg-primary)] text-[var(--text-muted)] hover:text-[var(--accent-danger)]"
                            title="Remove entry"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            <button
              onClick={toggleLog}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                logging
                  ? 'text-[var(--accent-danger)] bg-[rgba(240,83,63,0.12)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
              }`}
              title={logging ? 'Stop logging this session to file' : 'Log this session to a file'}
            >
              {logging ? <CircleDot size={11} className="animate-pulse" /> : <Circle size={11} />}
              {logging ? 'REC' : 'Log'}
            </button>
          </div>

          {/* Vendor device chip */}
          {meta && (
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold cursor-pointer hover:bg-[var(--border-strong)] transition-colors"
              style={{
                color: vendorColor(activeSession.config.deviceType),
                background: 'var(--bg-tertiary)',
              }}
              title={`${meta.label} — click to map device`}
              onClick={() => onMapDevice?.(activeSession.sessionId)}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: vendorColor(activeSession.config.deviceType) }}
              />
              {meta.short}
            </div>
          )}
        </>
      ) : (
        <span className="text-[var(--text-muted)]">No active connection</span>
      )}
    </div>
  );
}
