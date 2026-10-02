import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { currentWindow, currentWindowLabel } from './utils/tauri';
import { emit, listen } from '@tauri-apps/api/event';
import { Minimize2, RefreshCw, Search } from 'lucide-react';
import Terminal from './components/Terminal';
import SearchOverlay from './components/SearchOverlay';
import DialogHost from './components/DialogHost';
import Toaster from './components/Toaster';
import { useSessionStore } from './store/sessionStore';
import { openTerminalSearch, sendSearchCommand } from './utils/terminalSearch';
import { findStep, isFindChord, withShortcut } from './utils/shortcuts';
import { DeviceType, vendorColor } from './types';

type PopOutStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

interface PopOutMeta {
  deviceType?: DeviceType;
  name?: string;
  status?: PopOutStatus;
}

// How long "Connecting…" waits for a status event before offering Reconnect
// again (e.g. the main window is waiting on a password the user dismissed).
const RECONNECT_WAIT_MS = 30_000;

/**
 * Root view for pop-out session windows (window label `popout-<sessionId>`).
 * The backend emits terminal_data to all windows, so this view just mounts a
 * Terminal for its session: scrollback replays from the captured output tail
 * (seedFromBuffer — fetched after the data listener attaches so startup output
 * isn't lost), live data streams in via the normal listener, and input goes
 * back through send_data. Session metadata (device type, name, status) is
 * handed over from the main window via localStorage, which both windows share.
 *
 * The header shows live connection status; Reconnect asks the MAIN window to
 * reconnect (`popout_reconnect`) since the connect flow — vault, password
 * prompt, startup commands — lives there. Dock closes this window, which
 * returns the session to its tab in the main window.
 */
export default function PopOutTerminal() {
  const sessionId = currentWindowLabel().replace(/^popout-/, '');
  const meta = useMemo<PopOutMeta>(() => {
    try {
      return JSON.parse(localStorage.getItem(`popout-meta-${sessionId}`) || '{}');
    } catch {
      return {};
    }
  }, [sessionId]);
  const deviceType: DeviceType = meta.deviceType || 'generic';
  const name = meta.name || 'Session';

  const [status, setStatus] = useState<PopOutStatus>(meta.status ?? 'connected');
  // Read by the stable onSend below without re-creating it (a new onSend
  // would re-render the terminal on every status change).
  const statusRef = useRef(status);
  statusRef.current = status;
  const waitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live status for this session — the same event the main window's tabs use.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ sessionId: string; status: string }>('connection_status', (e) => {
      if (e.payload.sessionId !== sessionId) return;
      if (waitTimerRef.current) {
        clearTimeout(waitTimerRef.current);
        waitTimerRef.current = null;
      }
      const s = e.payload.status;
      setStatus(s === 'connected' ? 'connected' : s === 'reconnecting' ? 'reconnecting' : 'disconnected');
    })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
      if (waitTimerRef.current) clearTimeout(waitTimerRef.current);
    };
  }, [sessionId]);

  // No backend event marks "connecting", so if nothing arrives in time, offer
  // Reconnect again rather than showing "Connecting…" forever.
  const armConnectWait = () => {
    if (waitTimerRef.current) clearTimeout(waitTimerRef.current);
    waitTimerRef.current = setTimeout(() => {
      waitTimerRef.current = null;
      setStatus((s) => (s === 'connecting' ? 'disconnected' : s));
    }, RECONNECT_WAIT_MS);
  };
  // Popped out while still connecting.
  useEffect(() => {
    if (meta.status === 'connecting') armConnectWait();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reconnect = () => {
    if (statusRef.current !== 'disconnected') return;
    // Update the ref now too, so a second Enter before the re-render can't
    // send a second request.
    statusRef.current = 'connecting';
    setStatus('connecting');
    emit('popout_reconnect', sessionId).catch(() => setStatus('disconnected'));
    armConnectWait();
  };
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;

  // Stable per window. Enter on a dropped session reconnects, like the main
  // window; anything else typed while disconnected goes nowhere.
  const onSend = useMemo(
    () => (data: string) => {
      if (statusRef.current === 'disconnected') {
        if (data === '\r') reconnectRef.current();
        return;
      }
      invoke('send_data', { sessionId, data }).catch(() => {});
    },
    [sessionId],
  );

  // This window has no App shell, so handle its own Find shortcuts (the
  // terminal passes them through instead of sending them to the device).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isFindChord(e)) {
        e.preventDefault();
        openTerminalSearch();
        return;
      }
      const step = findStep(e);
      if (step && useSessionStore.getState().showSearch) {
        e.preventDefault();
        sendSearchCommand({ type: step });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const accent = vendorColor(deviceType);
  const statusLabel =
    status === 'connected'
      ? 'Connected'
      : status === 'reconnecting'
        ? 'Reconnecting…'
        : status === 'connecting'
          ? 'Connecting… (check the main window if it asks for a password)'
          : 'Disconnected — press Enter or Reconnect';
  const statusDot =
    status === 'connected'
      ? 'bg-[var(--accent-success)]'
      : status === 'disconnected'
        ? 'bg-[var(--accent-danger)]'
        : 'bg-[var(--accent-warning)] animate-pulse';
  const btn =
    'flex items-center gap-1.5 h-6 px-2 rounded text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors';

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--bg-primary)]">
      <div className="flex items-center gap-2 h-8 px-2.5 flex-shrink-0 border-b border-[var(--border)] bg-[var(--bg-secondary)] select-none">
        <span className="vendor-dot flex-shrink-0" style={{ background: accent, color: accent }} />
        <span className="text-[12px] font-medium text-[var(--text-primary)] truncate">{name}</span>
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot}`} />
        <span className="text-[11px] text-[var(--text-muted)] truncate">{statusLabel}</span>
        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
          {status === 'disconnected' && (
            <button onClick={reconnect} className="btn-accent flex items-center gap-1.5 h-6 px-2.5 text-[11px]">
              <RefreshCw size={12} />
              Reconnect
            </button>
          )}
          <button onClick={() => openTerminalSearch()} className={btn} title={withShortcut('Find in terminal', 'find')}>
            <Search size={12} />
            Find
          </button>
          <button
            onClick={() => currentWindow()?.close().catch(() => {})}
            className={btn}
            title="Close this window and put the session back in its tab"
          >
            <Minimize2 size={12} />
            Dock
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 relative p-1">
        <Terminal sessionId={sessionId} deviceType={deviceType} seedFromBuffer onSend={onSend} />
        <SearchOverlay sessionId={sessionId} deviceType={deviceType} className="top-2 right-4" />
      </div>
      {/* Paste-guard confirms + toasts need hosts in this window too. */}
      <DialogHost />
      <Toaster />
    </div>
  );
}
