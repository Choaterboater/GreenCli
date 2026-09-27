import { useEffect, useState } from 'react';
import { X, Plus, PictureInPicture2, RefreshCw, Unplug, Wand2, CopyPlus, Pencil, XCircle } from 'lucide-react';
import { WebviewWindow } from '@tauri-apps/api/window';
import { useSessionStore } from '../store/sessionStore';
import { askPrompt } from '../store/dialogStore';
import { getDeviceIcon, getDeviceLabel } from '../utils';
import { closeSessions } from '../utils/closeSessions';
import { formatChord, isMac, shortcutLabel, withShortcut } from '../utils/shortcuts';
import { tabLabel, tabTooltipName } from '../utils/tabs';
import { vendorColor, type Session } from '../types';

// "⌘3" / "Alt+3" — the jump-to-tab chord for the first nine tabs.
const jumpLabel = (index: number) =>
  index < 9 ? formatChord(`${isMac ? 'Mod' : 'Alt'}+${index + 1}`) : '';

const statusOf = (s: Session) => s.connectionStatus ?? (s.connected ? 'connected' : 'disconnected');

interface TerminalTabsProps {
  /** Open another session to the same host as this tab. */
  onDuplicate?: (sessionId: string) => void;
  /** Pop the session out into its own OS window. */
  onPopOut?: (sessionId: string) => void;
  /** Reconnect a disconnected session. */
  onReconnect?: (sessionId: string) => void;
  /** Disconnect a connected session. */
  onDisconnect?: (sessionId: string) => void;
  /** Open the device mapping wizard. */
  onMapDevice?: (sessionId: string) => void;
}

/** Rename one tab. The saved host keeps its name; an empty name (or the
 *  automatic one, unchanged) goes back to automatic naming, so the label keeps
 *  following the device prompt. */
async function renameTab(session: Session) {
  const automatic = tabLabel({ ...session, config: { ...session.config, tabName: undefined } });
  const entered = await askPrompt({
    title: 'Rename tab',
    message: 'Only this tab is renamed; the saved host keeps its name. Leave it empty to use the automatic name again.',
    defaultValue: session.config.tabName ?? automatic,
    placeholder: automatic,
    confirmLabel: 'Rename',
  });
  if (entered === null) return;
  const name = entered.trim();
  useSessionStore
    .getState()
    .updateSessionConfig(session.sessionId, { tabName: name && name !== automatic ? name : undefined });
}

export default function TerminalTabs({ onDuplicate, onPopOut, onReconnect, onDisconnect, onMapDevice }: TerminalTabsProps) {
  // Narrow per-field selectors — a whole-store subscription re-rendered the
  // whole tab strip on every unrelated store change.
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const setShowQuickConnect = useSessionStore((s) => s.setShowQuickConnect);
  const poppedSessions = useSessionStore((s) => s.poppedSessions);
  const unseenOutput = useSessionStore((s) => s.unseenOutput);
  // Right-click menu on a tab; null = closed.
  const [menu, setMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);

  // The tab went away while its menu was open (closed elsewhere, Cmd+W):
  // drop the menu, or its Escape handler would keep swallowing Escape.
  useEffect(() => {
    if (menu && !sessions.some((s) => s.sessionId === menu.sessionId)) setMenu(null);
  }, [menu, sessions]);

  // Escape closes the menu. Capture phase, so the key doesn't also reach the
  // terminal (and the device) that still has keyboard focus.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menu]);

  const handleClose = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    // Disconnects the backend, closes a pop-out window showing it, and asks
    // first while the session is still connected (confirmCloseConnected).
    void closeSessions([sessionId]);
  };

  const handlePopOut = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    onPopOut?.(sessionId);
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

  const menuSession = menu ? sessions.find((s) => s.sessionId === menu.sessionId) : undefined;

  return (
    <div className="flex items-stretch h-10 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-secondary)] scrollbar-none">
      <div className="flex items-stretch px-1.5 gap-1">
        {sessions.map((session, index) => {
          const isPopped = poppedSessions.includes(session.sessionId);
          const isActive = session.sessionId === activeSessionId && !isPopped;
          const hasActivity = !isActive && unseenOutput.includes(session.sessionId);
          const accent = vendorColor(session.config.deviceType);
          const connectionStatus = statusOf(session);
          const isBusy = connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
          // The device prompt says config mode: what's typed next changes the
          // running config. Amber tint + badge, calm enough to leave on.
          const inConfig = !!session.configMode;
          const ring = inConfig ? 'var(--config-mode-ring)' : isActive ? 'var(--border-strong)' : null;
          return (
            <div
              key={session.sessionId}
              onClick={() => {
                if (isPopped) {
                  // The session lives in its own window — bring that forward.
                  WebviewWindow.getByLabel(`popout-${session.sessionId}`)?.setFocus();
                  return;
                }
                setActiveSession(session.sessionId);
              }}
              onDoubleClick={(e) => {
                // Not from a quick double-click on one of the tab's buttons.
                if ((e.target as HTMLElement).closest('button')) return;
                void renameTab(session);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, sessionId: session.sessionId });
              }}
              title={
                isPopped
                  ? `${tabLabel(session)} — popped out, click to focus its window`
                  : [
                      tabTooltipName(session),
                      getDeviceLabel(session.config.deviceType),
                      inConfig ? 'In config mode' : '',
                      jumpLabel(index),
                    ]
                      .filter(Boolean)
                      .join(' · ')
              }
              className={`group relative flex items-center gap-2 min-w-[150px] max-w-[230px] my-1 px-2.5 rounded-md cursor-pointer select-none transition-all ${
                isActive
                  ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-elevation-1'
                  : isPopped
                  ? 'text-[var(--text-muted)] border border-dashed border-[var(--border)] hover:text-[var(--text-secondary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
              }`}
              style={{
                boxShadow: ring ? `inset 0 0 0 1px ${ring}` : undefined,
                // Layered over the tab's own background (and its hover), so
                // the tint reads the same on active and background tabs.
                backgroundImage: inConfig
                  ? 'linear-gradient(var(--config-mode-soft), var(--config-mode-soft))'
                  : undefined,
              }}
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
              <span className="flex-1 text-xs truncate">{tabLabel(session)}</span>
              {inConfig && (
                <span
                  className="flex-shrink-0 px-1 rounded-sm text-[9px] font-semibold tracking-wide leading-[14px]"
                  style={{ color: 'var(--config-mode)', boxShadow: 'inset 0 0 0 1px var(--config-mode-ring)' }}
                >
                  CONFIG
                </span>
              )}
              {isPopped && <PictureInPicture2 size={11} className="flex-shrink-0 opacity-60" />}
              {/* Activity dot — output arrived on a background tab */}
              {hasActivity && (
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0 animate-pulse"
                  style={{ background: accent }}
                  title="New output"
                />
              )}
              <span className="text-[9px] font-semibold tracking-wide text-[var(--text-muted)] flex-shrink-0">
                {getDeviceIcon(session.config.deviceType)}
              </span>
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  session.connected
                    ? 'bg-[var(--accent-success)]'
                    : isBusy
                      ? 'bg-[var(--accent-warning)]'
                      : 'bg-[var(--text-muted)]'
                }`}
                title={
                  connectionStatus === 'reconnecting'
                    ? 'Reconnecting'
                    : connectionStatus === 'connecting'
                      ? 'Connecting'
                      : session.connected
                        ? 'Connected'
                        : 'Disconnected'
                }
              />
              {!isPopped && session.connected && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDisconnect?.(session.sessionId);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--border-strong)] transition-all flex-shrink-0"
                  title="Disconnect"
                >
                  <Unplug size={12} />
                </button>
              )}
              {!isPopped && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onMapDevice?.(session.sessionId);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--border-strong)] transition-all flex-shrink-0"
                  title="Map device/profile"
                >
                  <Wand2 size={12} />
                </button>
              )}
              {!isPopped && isBusy && (
                <span
                  className="opacity-80 p-0.5 flex-shrink-0 text-[var(--accent-warning)]"
                  title={connectionStatus === 'reconnecting' ? 'Auto-reconnect in progress' : 'Connecting'}
                >
                  <RefreshCw size={12} className="animate-spin" />
                </span>
              )}
              {!isPopped && connectionStatus === 'disconnected' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onReconnect?.(session.sessionId);
                  }}
                  // Always visible (not hover-only like the other tab tools):
                  // a dropped session's way back must not be hidden.
                  className="p-0.5 rounded text-[var(--accent-warning)] hover:bg-[var(--border-strong)] transition-all flex-shrink-0"
                  title="Reconnect"
                >
                  <RefreshCw size={12} />
                </button>
              )}
              {!isPopped && (
                <button
                  onClick={(e) => handlePopOut(e, session.sessionId)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--border-strong)] transition-all flex-shrink-0"
                  title="Pop out into its own window"
                >
                  <PictureInPicture2 size={12} />
                </button>
              )}
              <button
                onClick={(e) => handleClose(e, session.sessionId)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--border-strong)] transition-all flex-shrink-0"
                title={
                  // The keyboard chord closes the ACTIVE tab only.
                  isActive ? withShortcut('Close tab', 'closeTab') : 'Close tab'
                }
              >
                <X size={12} />
              </button>
            </div>
          );
        })}

        <button
          onClick={() => setShowQuickConnect(true)}
          className="flex items-center justify-center w-7 my-1.5 ml-0.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0"
          title={withShortcut('New session', 'quickConnect')}
        >
          <Plus size={14} />
        </button>
      </div>

      {menu && menuSession && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          session={menuSession}
          sessions={sessions}
          isActive={menuSession.sessionId === activeSessionId}
          isPopped={poppedSessions.includes(menuSession.sessionId)}
          poppedSessions={poppedSessions}
          onClose={() => setMenu(null)}
          onDuplicate={onDuplicate}
          onPopOut={onPopOut}
          onReconnect={onReconnect}
          onDisconnect={onDisconnect}
        />
      )}
    </div>
  );
}

interface TabMenuProps
  extends Pick<TerminalTabsProps, 'onDuplicate' | 'onPopOut' | 'onReconnect' | 'onDisconnect'> {
  x: number;
  y: number;
  session: Session;
  sessions: Session[];
  isActive: boolean;
  isPopped: boolean;
  poppedSessions: string[];
  onClose: () => void;
}

function TabMenu({
  x,
  y,
  session,
  sessions,
  isActive,
  isPopped,
  poppedSessions,
  onClose,
  onDuplicate,
  onPopOut,
  onReconnect,
  onDisconnect,
}: TabMenuProps) {
  const id = session.sessionId;
  const status = statusOf(session);
  // "Close others" leaves popped-out sessions alone — they run in their own
  // windows (same rule as the palette's Close All). Dropped ones close
  // wherever they are: nothing is running there.
  const others = sessions
    .filter((s) => s.sessionId !== id && !poppedSessions.includes(s.sessionId))
    .map((s) => s.sessionId);
  const dropped = sessions.filter((s) => statusOf(s) === 'disconnected').map((s) => s.sessionId);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const items: Array<
    | { sep: true }
    | { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean; hint?: string; title?: string }
  > = [
    {
      label: 'Duplicate tab',
      icon: <CopyPlus size={14} />,
      title: 'Open another session to the same host',
      onClick: run(() => onDuplicate?.(id)),
    },
    {
      label: 'Reconnect',
      icon: <RefreshCw size={14} />,
      disabled: status !== 'disconnected',
      onClick: run(() => onReconnect?.(id)),
    },
    {
      label: 'Disconnect',
      icon: <Unplug size={14} />,
      disabled: !session.connected,
      onClick: run(() => onDisconnect?.(id)),
    },
    {
      label: 'Rename tab…',
      icon: <Pencil size={14} />,
      title: 'Rename just this tab (double-click the tab works too)',
      onClick: run(() => void renameTab(session)),
    },
    {
      label: 'Pop out',
      icon: <PictureInPicture2 size={14} />,
      title: 'Move this session into its own window',
      disabled: isPopped,
      onClick: run(() => onPopOut?.(id)),
    },
    { sep: true },
    {
      label: 'Close tab',
      icon: <X size={14} />,
      hint: isActive && !isPopped ? shortcutLabel('closeTab') : undefined,
      onClick: run(() => void closeSessions([id])),
    },
    {
      label: 'Close other tabs',
      icon: <XCircle size={14} />,
      disabled: others.length === 0,
      onClick: run(() => void closeSessions(others)),
    },
    {
      label: 'Close disconnected tabs',
      icon: <XCircle size={14} />,
      disabled: dropped.length === 0,
      onClick: run(() => void closeSessions(dropped)),
    },
  ];

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        role="menu"
        aria-label={`${tabLabel(session)} tab`}
        className="surface-elevated fixed z-50 min-w-[210px] py-1 animate-scale-in"
        // Clamp so a click near the right/bottom edge keeps the menu on screen.
        style={{
          top: Math.max(4, Math.min(y, window.innerHeight - 300)),
          left: Math.max(4, Math.min(x, window.innerWidth - 220)),
        }}
      >
        {items.map((item, i) =>
          'sep' in item ? (
            <div key={`sep-${i}`} className="my-1 h-px bg-[var(--border)]" />
          ) : (
            <button
              key={item.label}
              role="menuitem"
              onClick={item.onClick}
              disabled={item.disabled}
              title={item.title}
              className="flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-left text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <span className="flex-shrink-0 text-[var(--text-secondary)]">{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.hint && <span className="text-[11px] text-[var(--text-muted)]">{item.hint}</span>}
            </button>
          )
        )}
      </div>
    </>
  );
}
