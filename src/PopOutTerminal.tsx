import { useMemo } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { appWindow } from '@tauri-apps/api/window';
import Terminal from './components/Terminal';
import DialogHost from './components/DialogHost';
import Toaster from './components/Toaster';
import { DeviceType } from './types';

/**
 * Root view for pop-out session windows (window label `popout-<sessionId>`).
 * The backend emits terminal_data to all windows, so this view just mounts a
 * Terminal for its session: scrollback replays from the captured output tail
 * (seedFromBuffer — fetched after the data listener attaches so startup output
 * isn't lost), live data streams in via the normal listener, and input goes
 * back through send_data. Session metadata (device type, name) is handed over
 * from the main window via localStorage, which both windows share.
 */
export default function PopOutTerminal() {
  const sessionId = appWindow.label.replace(/^popout-/, '');
  const deviceType = useMemo<DeviceType>(() => {
    try {
      const meta = JSON.parse(localStorage.getItem(`popout-meta-${sessionId}`) || '{}');
      return (meta.deviceType as DeviceType) || 'generic';
    } catch {
      return 'generic';
    }
  }, [sessionId]);

  return (
    <div className="h-screen w-screen bg-[var(--bg-primary)] p-1">
      <Terminal
        sessionId={sessionId}
        deviceType={deviceType}
        seedFromBuffer
        onSend={(data) => {
          invoke('send_data', { sessionId, data }).catch(() => {});
        }}
      />
      {/* Paste-guard confirms + toasts need hosts in this window too. */}
      <DialogHost />
      <Toaster />
    </div>
  );
}
