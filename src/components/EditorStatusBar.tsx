// The Config Editor's status line: where Send goes, that device's CLI, config
// mode, and how old the pulled running-config is. A tab written for another
// vendor than the device gets a red line of its own above it. Its own component
// so the clock that ages "pulled 12 min ago" re-renders only this line, not
// the whole editor.

import { useEffect, useState } from 'react';
import { AlertTriangle, Send } from 'lucide-react';
import { sendTargetStatus, type SendTargetInput } from '../utils/editorStatus';

interface Props extends Omit<SendTargetInput, 'now'> {
  lineCount: number;
}

export default function EditorStatusBar({ session, pulled, editorLanguage, lineCount }: Props) {
  const [now, setNow] = useState(() => Date.now());
  // Keyed on the pull time, not the object: the parent builds a new one each render.
  const pulledAt = pulled?.at;
  useEffect(() => {
    if (pulledAt === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [pulledAt]);

  const status = sendTargetStatus({ session, pulled, editorLanguage, now });

  return (
    <>
      {status.mismatch && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium border-t border-[var(--accent-danger)] bg-[var(--accent-danger-soft)] text-[var(--accent-danger)] flex-shrink-0">
          <AlertTriangle size={12} className="flex-shrink-0" />
          <span>{status.mismatch}</span>
        </div>
      )}
      <div
        role="status"
        aria-label="Editor status"
        className="flex items-center gap-1.5 h-6 px-2.5 text-[10px] border-t border-[var(--bg-tertiary)] bg-[var(--bg-secondary)] flex-shrink-0 overflow-hidden"
      >
        <span
          className={`flex items-center gap-1 max-w-[55%] flex-shrink-0 ${
            status.tone === 'muted' ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'
          }`}
          title={status.target}
        >
          <Send size={10} className="flex-shrink-0" />
          <span className="truncate">{status.target}</span>
        </span>
        {status.device && <span className="text-[var(--text-secondary)] flex-shrink-0">· {status.device}</span>}
        {status.configMode && (
          <span
            className="px-1 rounded font-semibold flex-shrink-0"
            style={{
              color: 'var(--config-mode)',
              background: 'var(--config-mode-soft)',
              boxShadow: 'inset 0 0 0 1px var(--config-mode-ring)',
            }}
            title="The device is in configuration mode: lines you send change its configuration."
          >
            CONFIG MODE
          </span>
        )}
        {status.pulled && (
          <span className="text-[var(--text-muted)] min-w-0 truncate" title={status.pulled}>
            · {status.pulled}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[var(--text-muted)] flex-shrink-0">
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
      </div>
    </>
  );
}
