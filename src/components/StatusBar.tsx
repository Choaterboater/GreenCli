import { useState, useEffect, useRef } from 'react';
import { Shield, ShieldOff, Usb, Zap, TerminalSquare, CircleDot, Circle, ClipboardList, Trash2, FolderOpen } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useSessionStore } from '../store/sessionStore';
import { deviceMeta, vendorColor, type Session } from '../types';
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

const fileName = (path: string) => path.replace(/\\/g, '/').split('/').pop() || path;
const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '');
const statusOf = (s: Session) => s.connectionStatus ?? (s.connected ? 'connected' : 'disconnected');

/** Start (or, if already running, look up) a session's log. Returns its path. */
function startSessionLog(session: Session, dir: string, timestamps: boolean): Promise<string> {
  return invoke<string>('start_session_log', {
    sessionId: session.sessionId,
    name: session.config.name || session.config.host || session.config.serialPort || 'session',
    dir: dir.trim() || null,
    timestamps,
    // The backend has no time-zone database; it stamps with our offset.
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
  });
}

export default function StatusBar({ onReconnect, onDisconnect, onMapDevice }: StatusBarProps) {
  const { sessions, activeSessionId } = useSessionStore();
  // Narrow selectors: subscribing to the whole settings store re-rendered the
  // status bar on every unrelated settings change (font zoom, AI model, …).
  const pasteGuardEnabled = useSettingsStore((s) => s.pasteGuardEnabled);
  const pasteGuardLineThreshold = useSettingsStore((s) => s.pasteGuardLineThreshold);
  const autoLogSessions = useSettingsStore((s) => s.autoLogSessions);
  const sessionLogDir = useSettingsStore((s) => s.sessionLogDir);
  const sessionLogTimestamps = useSettingsStore((s) => s.sessionLogTimestamps);
  const { pasteHistory, clearPasteHistory, removePaste } = useTerminalToolsStore();
  // The active session's log file, or null when it isn't logging.
  const [logPath, setLogPath] = useState<string | null>(null);
  // Last log stopped on this tab, so its folder can still be revealed.
  const [savedLogPath, setSavedLogPath] = useState<string | null>(null);
  // Bumped when auto-log starts a log, to re-read the active tab's REC state.
  const [logEpoch, setLogEpoch] = useState(0);
  const [logHint, setLogHint] = useState<string | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showPasteHistory, setShowPasteHistory] = useState(false);
  const logging = logPath != null;

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
  const activeStatus = activeSession ? statusOf(activeSession) : null;
  // For async handlers: is the tab they started on still the active one?
  const activeIdRef = useRef(activeSessionId);
  useEffect(() => {
    activeIdRef.current = activeSessionId;
  }, [activeSessionId]);
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

  const flashHint = (text: string, ms = 4000) => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    setLogHint(text);
    hintTimerRef.current = setTimeout(() => setLogHint(null), ms);
  };
  useEffect(() => () => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
  }, []);

  useEffect(() => {
    setLogHint(null);
    setSavedLogPath(null);
  }, [activeSessionId]);

  // Reflect the active tab's logging state — on tab switch, on (dis)connect
  // (a user disconnect closes the log), and after auto-log starts one.
  useEffect(() => {
    if (!activeSessionId) {
      setLogPath(null);
      return;
    }
    // Ignore a late reply for the tab we already switched away from — it
    // would show the wrong REC state (and the toggle would act on it).
    let cancelled = false;
    invoke<string | null>('session_log_path', { sessionId: activeSessionId })
      .then((path) => {
        if (!cancelled) setLogPath(typeof path === 'string' ? path : null);
      })
      .catch(() => {
        if (!cancelled) setLogPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, activeStatus, logEpoch]);

  // Auto-log: start a log for every session as it connects. `autoLogged`
  // remembers sessions already handled since they last connected, so a manual
  // stop isn't undone on the next render; a session that goes fully
  // disconnected is forgotten, so its next connect logs again (the backend
  // start is idempotent, so a log that survived the drop just continues).
  const autoLoggedRef = useRef(new Set<string>());
  useEffect(() => {
    const seen = autoLoggedRef.current;
    const live = new Set(sessions.map((s) => s.sessionId));
    for (const id of seen) if (!live.has(id)) seen.delete(id);
    for (const s of sessions) {
      const status = statusOf(s);
      if (status === 'disconnected') {
        seen.delete(s.sessionId);
        continue;
      }
      if (!autoLogSessions || status !== 'connected' || seen.has(s.sessionId)) continue;
      seen.add(s.sessionId);
      startSessionLog(s, sessionLogDir, sessionLogTimestamps)
        .then(() => setLogEpoch((n) => n + 1))
        .catch((e) =>
          notify.warning(
            'Automatic session log failed',
            `${s.config.name || s.config.host || 'Session'}: ${String(e)}`
          )
        );
    }
  }, [sessions, autoLogSessions, sessionLogDir, sessionLogTimestamps]);

  const toggleLog = async () => {
    if (!activeSession) return;
    const sid = activeSession.sessionId;
    try {
      if (logPath) {
        await invoke('stop_session_log', { sessionId: sid });
        if (activeIdRef.current !== sid) return;
        setLogPath(null);
        setSavedLogPath(logPath);
        flashHint(`saved ${fileName(logPath)}`);
      } else {
        const path = await startSessionLog(activeSession, sessionLogDir, sessionLogTimestamps);
        if (activeIdRef.current !== sid) return;
        setLogPath(path);
        flashHint(`→ ${fileName(path)}`);
      }
    } catch (e) {
      // The generic "requires the desktop app" message masked real causes
      // (permission denied, disk full, bad log directory) behind one that's
      // only true when there's no Tauri backend at all.
      notify.warning('Session logging unavailable', String(e));
    }
  };

  const revealLogFolder = (dir: string) => {
    invoke('reveal_log_folder', { dir }).catch((e) =>
      notify.warning('Could not open the log folder', String(e))
    );
  };
  const revealDir = logPath ? folderOf(logPath) : savedLogPath ? folderOf(savedLogPath) : null;

  const sendBreak = async () => {
    if (!activeSession) return;
    const sid = activeSession.sessionId;
    const ok = await askConfirm({
      title: `Send BREAK to ${activeSession.config.name || activeSession.config.serialPort || 'this port'}?`,
      message:
        'A BREAK interrupts the device. While it boots, that stops the boot and drops into the ' +
        'bootloader / ROM monitor. Some devices also halt when they get a BREAK while running.',
      confirmLabel: 'Send BREAK',
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke('serial_send_break', { sessionId: sid });
      flashHint('BREAK sent', 2500);
    } catch (e) {
      notify.warning('Could not send BREAK', String(e));
    }
  };

  const pasteFromHistory = async (text: string) => {
    if (!activeSession) return;
    const lineCount = countPasteLines(text);
    if (pasteGuardEnabled && lineCount >= pasteGuardLineThreshold) {
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
                  {/* The hostname the device's prompt reports, when the
                      address alone doesn't say which box this is. */}
                  {activeSession.promptHost &&
                    activeSession.promptHost !== activeSession.config.host &&
                    ` (${activeSession.promptHost})`}
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

          {/* Config mode, read from the device prompt — the same amber as the
              tab's CONFIG badge. */}
          {activeSession.configMode && (
            <div
              className="flex items-center gap-1.5 mr-4 px-1.5 py-0.5 rounded font-medium"
              style={{
                color: 'var(--config-mode)',
                background: 'var(--config-mode-soft)',
                boxShadow: 'inset 0 0 0 1px var(--config-mode-ring)',
              }}
              title={`${activeSession.promptHost || 'The device'} is in configuration mode — what you type changes its configuration.`}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--config-mode)' }} />
              Config mode
            </div>
          )}

          {/* Serial BREAK — the only way to interrupt a boot into the bootloader
              from a console, and there's no key for it in a terminal. */}
          {activeSession.config.protocol === 'serial' && activeSession.connected && (
            <button
              onClick={sendBreak}
              className="flex items-center gap-1 mr-4 px-1.5 py-0.5 rounded text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              title="Send a serial BREAK signal. Use it while the device boots to stop the boot and enter the bootloader / ROM monitor."
            >
              <Zap size={11} />
              Send BREAK
            </button>
          )}

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
                  ? 'text-[var(--accent-danger)] bg-[var(--accent-danger-soft)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
              }`}
              title={
                logPath
                  ? `Logging to ${fileName(logPath)} — click to stop`
                  : 'Log this session to a file'
              }
            >
              {logging ? <CircleDot size={11} className="animate-pulse" /> : <Circle size={11} />}
              {logging ? 'REC' : 'Log'}
            </button>
            {revealDir && (
              <button
                onClick={() => revealLogFolder(revealDir)}
                className="flex items-center px-1 py-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                title={`Reveal log folder (${revealDir})`}
                aria-label="Reveal log folder"
              >
                <FolderOpen size={11} />
              </button>
            )}
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
