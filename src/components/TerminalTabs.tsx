import { X, Plus } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { getDeviceIcon, getDeviceLabel } from '../utils';
import { vendorColor } from '../types';

export default function TerminalTabs() {
  const { sessions, activeSessionId, setActiveSession, removeSession, setShowQuickConnect } =
    useSessionStore();

  const handleClose = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    // Tear down the backend connection before dropping the tab so SSH/serial
    // sessions aren't leaked.
    invoke('disconnect', { sessionId }).catch(() => {});
    removeSession(sessionId);
  };

  if (sessions.length === 0) {
    return (
      <div className="flex items-center h-10 px-2 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <button
          onClick={() => setShowQuickConnect(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-md transition-colors"
        >
          <Plus size={14} />
          <span>New Session</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-stretch h-10 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-secondary)] scrollbar-none">
      <div className="flex items-stretch px-1.5 gap-1">
        {sessions.map((session) => {
          const isActive = session.sessionId === activeSessionId;
          const accent = vendorColor(session.config.deviceType);
          return (
            <div
              key={session.sessionId}
              onClick={() => setActiveSession(session.sessionId)}
              title={getDeviceLabel(session.config.deviceType)}
              className={`group relative flex items-center gap-2 min-w-[150px] max-w-[230px] my-1 px-2.5 rounded-md cursor-pointer select-none transition-all ${
                isActive
                  ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-elevation-1'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
              }`}
              style={isActive ? { boxShadow: `inset 0 0 0 1px var(--border-strong)` } : undefined}
            >
              {/* Vendor accent stripe on the active tab */}
              {isActive && (
                <span
                  className="absolute left-2 right-2 top-0 h-[2px] rounded-full"
                  style={{ background: accent }}
                />
              )}
              <span
                className="vendor-dot flex-shrink-0"
                style={{ background: accent, color: accent }}
              />
              <span className="flex-1 text-xs truncate">
                {session.config.name || session.config.host || 'Session'}
              </span>
              <span className="text-[9px] font-semibold tracking-wide text-[var(--text-muted)] flex-shrink-0">
                {getDeviceIcon(session.config.deviceType)}
              </span>
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  session.connected ? 'bg-[var(--accent-success)]' : 'bg-[var(--text-muted)]'
                }`}
                title={session.connected ? 'Connected' : 'Disconnected'}
              />
              <button
                onClick={(e) => handleClose(e, session.sessionId)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--border-strong)] transition-all flex-shrink-0"
                title="Close tab"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}

        <button
          onClick={() => setShowQuickConnect(true)}
          className="flex items-center justify-center w-7 my-1.5 ml-0.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0"
          title="New session (Ctrl+T)"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}
