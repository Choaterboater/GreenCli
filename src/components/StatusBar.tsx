import { useState, useEffect } from 'react';
import { Shield, ShieldOff, Usb, Zap, TerminalSquare, CircleDot, Circle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { deviceMeta, vendorColor } from '../types';
import { notify } from '../store/toastStore';

const protocolIcons: Record<string, React.ReactNode> = {
  ssh: <Shield size={12} className="text-[var(--accent-info)]" />,
  telnet: <ShieldOff size={12} className="text-[var(--accent-warning)]" />,
  serial: <Usb size={12} className="text-[var(--text-secondary)]" />,
  local: <TerminalSquare size={12} className="text-[var(--accent-success)]" />,
};

export default function StatusBar() {
  const { sessions, activeSessionId } = useSessionStore();
  const [logging, setLogging] = useState(false);
  const [logHint, setLogHint] = useState<string | null>(null);

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

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
    } catch {
      notify.warning('Session logging unavailable', 'Logging requires the desktop app.');
    }
  };

  const meta = activeSession ? deviceMeta(activeSession.config.deviceType) : null;

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
          <div className="flex items-center gap-1.5 mr-4 text-[var(--text-muted)]">
            <span>
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
          <div className="flex items-center gap-1.5 mr-4">
            <span
              className={`w-1.5 h-1.5 rounded-full ${activeSession.connected ? 'animate-pulse' : ''}`}
              style={{
                background: activeSession.connected ? 'var(--accent-success)' : 'var(--accent-danger)',
              }}
            />
            <span style={{ color: activeSession.connected ? 'var(--accent-success)' : 'var(--accent-danger)' }}>
              {activeSession.connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          {/* Session log toggle */}
          <div className="flex items-center gap-2 ml-auto mr-3">
            {logHint && <span className="text-[10px] text-[var(--text-muted)]">{logHint}</span>}
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
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold"
              style={{
                color: vendorColor(activeSession.config.deviceType),
                background: 'var(--bg-tertiary)',
              }}
              title={meta.label}
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
