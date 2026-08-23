import { useState, useEffect, useCallback } from 'react';
import { X, Crown, History, GitCompare, RefreshCw, FileText } from 'lucide-react';
import { BeforeMount, DiffEditor } from '@monaco-editor/react';
import { useSessionStore } from '../store/sessionStore';
import { useTheme } from '../hooks/useTheme';
import { notify } from '../store/toastStore';
import {
  ArchiveEntry,
  archiveDevices,
  archiveHistory,
  archiveSnapshot,
  archiveSetGolden,
  captureNow,
  getDeviceId,
} from '../utils/configArchive';

// Same editor themes as ConfigEditor so the diff follows the app's dark/light
// setting (the prop-driven theme must resolve before Mount, per that pattern).
const defineEditorThemes: BeforeMount = (monaco) => {
  monaco.editor.defineTheme('aruba-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#0d1117', 'editor.lineHighlightBackground': '#161b22' },
  });
  monaco.editor.defineTheme('aruba-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#ffffff', 'editor.lineHighlightBackground': '#f4f7f980' },
  });
};

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

type DiffTarget = 'golden' | 'previous' | 'none';

interface ConfigArchiveProps {
  /** Open a snapshot in the parent editor tab strip. */
  onOpenSnapshot: (name: string, content: string, language: string) => void;
  onClose: () => void;
}

export default function ConfigArchive({ onOpenSnapshot, onClose }: ConfigArchiveProps) {
  const { activeSessionId, sessions } = useSessionStore();
  const { isDark } = useTheme();
  const editorTheme = isDark ? 'aruba-dark' : 'aruba-light';

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
  const defaultDevice = activeSession ? getDeviceId(activeSession) : '';
  const [devices, setDevices] = useState<string[]>([]);
  const [device, setDevice] = useState(defaultDevice);
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [diffTarget, setDiffTarget] = useState<DiffTarget>('none');
  const [diffOriginal, setDiffOriginal] = useState('');
  const [diffModified, setDiffModified] = useState('');
  const [diffLabel, setDiffLabel] = useState('');

  // Follow the active session's device (the panel is opened from the editor).
  useEffect(() => {
    if (defaultDevice) setDevice(defaultDevice);
  }, [defaultDevice]);

  const loadDevices = useCallback(async () => {
    const d = await archiveDevices().catch(() => [] as string[]);
    setDevices(d);
    // Re-select the active session's device when it just gained history.
    if (d.length && defaultDevice && !d.includes(device)) setDevice(defaultDevice);
  }, [defaultDevice, device]);

  const loadHistory = useCallback(async (dev: string) => {
    if (!dev) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      setEntries(await archiveHistory(dev));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadHistory(device);
    setDiffTarget('none');
  }, [device, loadHistory]);

  // Diff "current" = the newest snapshot for the device; "original" = the
  // chosen baseline (golden or second-newest).
  const diffAgainst = useCallback(
    async (baselineTs: number | null, target: DiffTarget) => {
      if (!device) return;
      const entriesList = entries.length ? entries : await archiveHistory(device);
      const current = entriesList[0];
      if (!current) return;
      if (!baselineTs) {
        notify.warning('No baseline', target === 'golden' ? 'No snapshot is marked golden yet — set one from the history list.' : 'Only one snapshot exists.');
        return;
      }
      setBusy(true);
      try {
        const [currentText, baselineText] = await Promise.all([
          archiveSnapshot(device, current.ts),
          archiveSnapshot(device, baselineTs),
        ]);
        setDiffOriginal(baselineText);
        setDiffModified(currentText);
        setDiffLabel(target === 'golden' ? `Golden → current (${fmtTime(current.ts)})` : `Previous (${fmtTime(baselineTs)}) → current`);
        setDiffTarget(target);
      } finally {
        setBusy(false);
      }
    },
    [device, entries]
  );

  const golden = entries.find((e) => e.golden);

  const onCaptureNow = async () => {
    if (!activeSession) return;
    setBusy(true);
    try {
      const ts = await captureNow(activeSession, 'manual');
      if (ts == null) {
        notify.info('No change captured', 'Config identical to the latest snapshot (or no output).');
      } else {
        notify.success('Snapshot captured', `config_archive/${getDeviceId(activeSession)}/${ts}.json`);
      }
      await loadHistory(getDeviceId(activeSession));
      await loadDevices();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="surface-elevated w-[880px] max-w-[95vw] h-[78vh] flex flex-col animate-scale-in">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-center w-7 h-7 rounded-md" style={{ background: 'var(--accent-soft)' }}>
            <History size={15} style={{ color: 'var(--accent)' }} />
          </div>
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Config Archive</h2>
          <span className="flex-1" />
          {activeSession && (
            <button
              onClick={onCaptureNow}
              disabled={busy}
              className="btn-accent flex items-center gap-1.5 h-8 px-3 text-[12px] disabled:opacity-50"
            >
              <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
              Capture now
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left: device picker + history */}
          <div className="w-[300px] border-r border-[var(--border)] flex flex-col">
            <div className="p-3 border-b border-[var(--border)]">
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1.5">Device</label>
              <select
                value={device || ''}
                onChange={(e) => setDevice(e.target.value)}
                className="input-field w-full h-8 px-2 text-sm"
              >
                {devices.length === 0 && <option value="">No history yet</option>}
                {devices.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)]">
              {loading && <p className="px-3 py-2 text-xs text-[var(--text-muted)]">Loading…</p>}
              {!loading && entries.length === 0 && (
                <p className="px-3 py-2 text-xs text-[var(--text-muted)]">
                  No snapshots. They land automatically on SSH/Telnet connect — or click Capture now.
                </p>
              )}
              {entries.map((e, i) => (
                <div key={e.ts} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-[var(--text-primary)] font-mono flex-1 truncate">
                      {fmtTime(e.ts)}
                    </span>
                    <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">{e.source}</span>
                    {e.golden && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-[#58a6ff20] text-[var(--accent)]">golden</span>
                    )}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1">
                    {!e.golden && (
                      <button
                        onClick={() => archiveSetGolden(device, e.ts).then(() => loadHistory(device)).catch((err) => notify.error('Could not set golden', String(err)))}
                        className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-secondary)]"
                        title="Mark as golden baseline"
                      >
                        <Crown size={10} /> golden
                      </button>
                    )}
                    <button
                      onClick={() => void (async () => {
                        try {
                          const text = await archiveSnapshot(device, e.ts);
                          onOpenSnapshot(
                            `${device} @ ${fmtTime(e.ts)}`,
                            text,
                            activeSession?.config.deviceType ?? 'plaintext'
                          );
                        } catch (err) {
                          notify.error('Could not open snapshot', String(err));
                        }
                      })()}
                      className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-secondary)]"
                      title={i === 0 ? 'Open current snapshot in editor' : 'Open snapshot in editor'}
                    >
                      <FileText size={10} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: diff */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
              <GitCompare size={13} className="text-[var(--text-secondary)]" />
              <button
                onClick={() => (golden ? diffAgainst(golden.ts, 'golden') : notify.warning('No golden baseline', 'Mark a snapshot golden from the list first.'))}
                className={`px-2 py-1 text-[11px] rounded transition-colors ${diffTarget === 'golden' ? 'text-[var(--accent)] bg-[#58a6ff20]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
              >
                Current vs Golden
              </button>
              <button
                onClick={() => diffAgainst(entries[1]?.ts ?? null, 'previous')}
                className={`px-2 py-1 text-[11px] rounded transition-colors ${diffTarget === 'previous' ? 'text-[var(--accent)] bg-[#58a6ff20]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
              >
                Current vs Previous
              </button>
              {diffLabel && (
                <span className="flex-1 text-right text-[10px] text-[var(--text-muted)] truncate" title={diffLabel}>
                  {diffLabel}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-hidden">
              {diffTarget !== 'none' ? (
                <DiffEditor
                  original={diffOriginal}
                  modified={diffModified}
                  language="plaintext"
                  theme={editorTheme}
                  beforeMount={defineEditorThemes}
                  options={{
                    readOnly: true,
                    fontSize: 13,
                    fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    renderSideBySide: true,
                  }}
                />
              ) : (
                <div className="h-full flex items-center justify-center">
                  <p className="text-xs text-[var(--text-muted)]">
                    Pick a diff above — Current vs Golden or Current vs Previous.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}