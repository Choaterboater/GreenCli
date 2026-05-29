import { useState, useEffect } from 'react';
import { Wifi, WifiOff, Shield, ShieldOff, Usb, Zap, TerminalSquare, CircleDot, Circle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';

const protocolIcons: Record<string, React.ReactNode> = {
  ssh: <Shield size={12} className="text-[#58a6ff]" />,
  telnet: <ShieldOff size={12} className="text-[#d29922]" />,
  serial: <Usb size={12} className="text-[#8b949e]" />,
  local: <TerminalSquare size={12} className="text-[#3fb950]" />,
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
      setLogHint('logging needs the desktop app');
      setTimeout(() => setLogHint(null), 3000);
    }
  };

  return (
    <div className="flex items-center h-7 px-3 bg-[#161b22] border-t border-[#21262d] text-[11px] text-[#8b949e]">
      {activeSession ? (
        <>
          {/* Protocol */}
          <div className="flex items-center gap-1.5 mr-4">
            {protocolIcons[activeSession.config.protocol] || (
              <Zap size={12} />
            )}
            <span className="uppercase font-medium">
              {activeSession.config.protocol}
            </span>
          </div>

          {/* Connection Info */}
          <div className="flex items-center gap-1.5 mr-4">
            <span>
              {activeSession.config.protocol === 'local' ? (
                activeSession.config.command || 'shell'
              ) : (
                <>
                  {activeSession.config.username
                    ? `${activeSession.config.username}@`
                    : ''}
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
            {activeSession.connected ? (
              <>
                <Wifi size={12} className="text-[#3fb950]" />
                <span className="text-[#3fb950]">Connected</span>
              </>
            ) : (
              <>
                <WifiOff size={12} className="text-[#ff7b72]" />
                <span className="text-[#ff7b72]">Disconnected</span>
              </>
            )}
          </div>

          {/* Session log toggle */}
          <div className="flex items-center gap-2 ml-auto mr-3">
            {logHint && <span className="text-[10px] text-[#484f58]">{logHint}</span>}
            <button
              onClick={toggleLog}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                logging
                  ? 'text-[#ff7b72] bg-[#ff7b7215]'
                  : 'text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]'
              }`}
              title={logging ? 'Stop logging this session to file' : 'Log this session to a file'}
            >
              {logging ? <CircleDot size={11} className="animate-pulse" /> : <Circle size={11} />}
              {logging ? 'REC' : 'Log'}
            </button>
          </div>

          {/* Device Type */}
          <div className="flex items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded bg-[#21262d] text-[10px] uppercase">
              {activeSession.config.deviceType === 'aruba-cx'
                ? 'CX'
                : activeSession.config.deviceType === 'aruba-ap'
                  ? 'AP'
                  : activeSession.config.deviceType === 'aruba-controller'
                    ? 'MC'
                    : 'GEN'}
            </span>
          </div>
        </>
      ) : (
        <span className="text-[#484f58]">No active connection</span>
      )}
    </div>
  );
}
