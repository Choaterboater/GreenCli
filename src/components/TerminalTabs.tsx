import { X, Plus, GripVertical } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { getDeviceIcon } from '../utils';

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
      <div className="flex items-center h-10 px-2 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        <button
          onClick={() => setShowQuickConnect(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
        >
          <Plus size={14} />
          <span>New Session</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center h-10 overflow-x-auto border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)] scrollbar-none">
      <div className="flex items-center gap-0.5 px-1">
        {sessions.map((session) => {
          const isActive = session.sessionId === activeSessionId;
          return (
            <div
              key={session.sessionId}
              onClick={() => setActiveSession(session.sessionId)}
              className={`
                group flex items-center gap-1.5 min-w-[140px] max-w-[220px] h-8 px-2.5 
                rounded-t cursor-pointer select-none transition-colors
                ${
                  isActive
                    ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] border-t-2 border-[#58a6ff]'
                    : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                }
              `}
            >
              <GripVertical size={12} className="opacity-0 group-hover:opacity-50 cursor-grab" />
              <span className="text-xs capitalize">
                {getDeviceIcon(session.config.deviceType)}
              </span>
              <span className="flex-1 text-xs truncate">
                {session.config.name || session.config.host || 'Session'}
              </span>
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  session.connected ? 'bg-[#3fb950]' : 'bg-[var(--text-muted)]'
                }`}
              />
              <button
                onClick={(e) => handleClose(e, session.sessionId)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--border)] transition-all"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}

        <button
          onClick={() => setShowQuickConnect(true)}
          className="flex items-center justify-center w-7 h-7 ml-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}
