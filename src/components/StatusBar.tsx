import { Wifi, WifiOff, Shield, ShieldOff, Usb, Zap, TerminalSquare } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';

const protocolIcons: Record<string, React.ReactNode> = {
  ssh: <Shield size={12} className="text-[#58a6ff]" />,
  telnet: <ShieldOff size={12} className="text-[#d29922]" />,
  serial: <Usb size={12} className="text-[#8b949e]" />,
  local: <TerminalSquare size={12} className="text-[#3fb950]" />,
};

export default function StatusBar() {
  const { sessions, activeSessionId } = useSessionStore();

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

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

          {/* Device Type */}
          <div className="flex items-center gap-1.5 ml-auto">
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
