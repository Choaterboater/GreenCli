import { useState, useEffect } from 'react';
import { X, Play, Download, Loader2, CheckCircle2, AlertCircle, Square, CheckSquare } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { askConfirm, useDialogStore } from '../store/dialogStore';
import { sendAndCapture, sleep } from '../utils/terminal';
import { profileForSession } from '../utils/deviceProfiles';
import { endsAtPager, pagedCommand, pagerQuitKey, withPagingDisabled } from '../utils/paging';
import { listNames, riskyLines } from '../utils/commandRisk';
import { Session } from '../types';

const isMac = navigator.platform.toUpperCase().includes('MAC');

/** Output of one command line on one device. */
interface StepResult {
  command: string;
  output: string;
  /** Why the output may be incomplete (settle cap, trimmed buffer, pager). */
  note?: string;
  error?: boolean;
}

interface RunResult {
  sessionId: string;
  name: string;
  steps: StepResult[];
  status: 'pending' | 'running' | 'done' | 'error';
  /** Some step's output may be incomplete — see each step's note. */
  truncated?: boolean;
}

// Network devices only: a local shell or a serial console (often mid-config on
// a box being staged) shouldn't be swept into a run just by being open.
const isDeviceSession = (s: Session) => s.config.protocol === 'ssh' || s.config.protocol === 'telnet';

const sessionName = (s: Session) => s.config.name || s.config.host || 'Session';

/** Output as shown in the modal / written to the CSV, with any caveat on top. */
const stepText = (st: StepResult) => (st.note ? `[${st.note}]\n${st.output}` : st.output);

// Run one or more commands across many connected sessions and collect each output.
export default function BulkRunner() {
  const { showBulkRunner, setShowBulkRunner, sessions } = useSessionStore();
  const connected = sessions.filter((s) => s.connected);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunResult[]>([]);

  // Preselect the connected ssh/telnet devices each time the modal opens —
  // unless a run is still executing (the component stays mounted while hidden,
  // so a reopen mid-run would wipe the results the loop is writing into).
  useEffect(() => {
    if (showBulkRunner && !running) {
      setSelected(new Set(sessions.filter((s) => s.connected && isDeviceSession(s)).map((s) => s.sessionId)));
      setResults([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBulkRunner]);

  // Close on Escape — unless a confirm/prompt dialog is stacked above us.
  useEffect(() => {
    if (!showBulkRunner) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (useDialogStore.getState().current) return;
      setShowBulkRunner(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showBulkRunner, setShowBulkRunner]);

  if (!showBulkRunner) return null;

  // Count only selections that are still connected — ids of sessions that
  // dropped after the modal opened would otherwise inflate the count.
  const targets = connected.filter((s) => selected.has(s.sessionId));
  const lines = command
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async () => {
    if (lines.length === 0 || targets.length === 0 || running) return;
    // Snapshot what we're about to run so a later edit can't mislabel results.
    const runLines = lines;
    const runTargets = targets;
    const n = runTargets.length;
    const devices = `${n} device${n === 1 ? '' : 's'}`;
    const risky = riskyLines(runLines.join('\n'));

    // Always confirm: this types into every listed device at once. Risky lines
    // get the red dialog and are named, so a stray `reload` can't hide in a paste.
    const ok = await askConfirm({
      title: risky.length ? `Run changes on ${devices}?` : `Run on ${devices}?`,
      message: [
        `Devices: ${listNames(runTargets.map(sessionName))}.`,
        risky.length ? `These lines change device state: ${listNames(risky, 4)}.` : '',
        runLines.length > 1 ? `Each device gets all ${runLines.length} lines, in order.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: `Run on ${devices}`,
      danger: risky.length > 0,
    });
    if (!ok) return;

    setRunning(true);
    setResults(
      runTargets.map((s) => ({ sessionId: s.sessionId, name: sessionName(s), steps: [], status: 'pending' as const }))
    );
    const patch = (sid: string, fn: (r: RunResult) => RunResult) =>
      setResults((prev) => prev.map((r) => (r.sessionId === sid ? fn(r) : r)));
    const addStep = (sid: string, st: StepResult) =>
      patch(sid, (r) => ({ ...r, steps: [...r.steps, st], truncated: r.truncated || !!st.note }));

    const customProfiles = useSettingsStore.getState().customDeviceProfiles ?? [];

    const runOne = async (s: Session) => {
      const sid = s.sessionId;
      patch(sid, (r) => ({ ...r, status: 'running' }));
      const profile = profileForSession(s.config, customProfiles);
      let failed = false;
      try {
        // Paging off for the whole sequence so `show run` returns everything,
        // not page 1 with the device left sitting at --More--.
        await withPagingDisabled(sid, profile, async () => {
          for (let i = 0; i < runLines.length; i++) {
            const line = runLines[i];
            const { output, truncated } = await sendAndCapture(sid, pagedCommand(profile, line));
            if (!output.trim()) {
              // No answer at all: stop here rather than keep typing into a hung
              // or disconnected prompt (the next line might depend on this one).
              const left = runLines.length - i - 1;
              addStep(sid, {
                command: line,
                output: `No response (timed out or no output returned)${left ? ` — skipped the remaining ${left} line${left === 1 ? '' : 's'}` : ''}`,
                error: true,
              });
              failed = true;
              return;
            }
            let note = truncated ? 'capture may be truncated' : undefined;
            if (endsAtPager(output)) {
              // Paging is still on (unknown device type, or the toggle failed):
              // quit the pager so the next line doesn't land on --More--.
              note = 'stopped at a --More-- prompt; the rest was not captured';
              await invoke('send_data', { sessionId: sid, data: pagerQuitKey(output) });
              await sleep(400);
            }
            addStep(sid, { command: line, output, note });
          }
        });
      } catch (e) {
        addStep(sid, { command: '', output: String(e), error: true });
        failed = true;
      }
      patch(sid, (r) => ({ ...r, status: failed ? 'error' : 'done' }));
    };

    // Bounded concurrency: a fixed pool of workers pulls from a shared queue so
    // network waits overlap without dispatching to every device at once. Each
    // target is a distinct sessionId and the per-row setResults updaters are
    // independent, so overlapping captures are safe; the shared idx++ is fine
    // because JS is single-threaded (the only yield is the awaited runOne).
    // Lines on ONE device always run in order, inside its runOne.
    const POOL = 6;
    let idx = 0;
    const worker = async () => {
      while (idx < runTargets.length) {
        const s = runTargets[idx++];
        await runOne(s);
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, runTargets.length) }, () => worker()));

    setRunning(false);
  };

  const exportCsv = () => {
    // Neutralize leading formula characters so device output (interface
    // descriptions, banners, LLDP neighbor names…) can't execute as a formula
    // when the CSV is opened in Excel/Sheets — mirrors ApiExplorer's toCsv.
    const neutralizeFormula = (s: string) => (/^\s*[=+\-@]/.test(s) || /^[\t\r]/.test(s) ? `'${s}` : s);
    const esc = (v: string) => `"${neutralizeFormula(v).replace(/"/g, '""')}"`;
    // One row per device per command line.
    const rows = [['device', 'command', 'output'].map(esc).join(',')];
    for (const r of results)
      for (const st of r.steps) rows.push([r.name, st.command, stepText(st)].map(esc).join(','));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bulk-run-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runLabel = `Run on ${targets.length} device${targets.length === 1 ? '' : 's'}`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setShowBulkRunner(false);
      }}
    >
      <div className="w-[720px] max-w-[92vw] max-h-[85vh] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--bg-tertiary)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Bulk Command Runner</h2>
          <button
            onClick={() => setShowBulkRunner(false)}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-3 space-y-3 overflow-y-auto">
          {/* Targets */}
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
              Target sessions ({targets.length}/{connected.length} connected)
            </label>
            {connected.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">No connected sessions.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {connected.map((s) => {
                  const on = selected.has(s.sessionId);
                  return (
                    <button
                      key={s.sessionId}
                      onClick={() => toggle(s.sessionId)}
                      className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded border transition-colors ${
                        on
                          ? 'bg-[#1f6feb22] border-[var(--accent)] text-[var(--text-primary)]'
                          : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)]'
                      }`}
                      title={isDeviceSession(s) ? undefined : 'Not selected by default — click to include'}
                    >
                      {on ? <CheckSquare size={12} /> : <Square size={12} />}
                      {sessionName(s)}
                      {!isDeviceSession(s) && (
                        <span className="text-[10px] text-[var(--text-muted)]">({s.config.protocol})</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Commands — one per line; each line is its own command on every device */}
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <textarea
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  // Plain Enter adds a line; Ctrl/Cmd+Enter runs.
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void run();
                  }
                }}
                rows={3}
                spellCheck={false}
                placeholder={'One command per line, e.g.\nshow version\nshow interface brief'}
                className="w-full min-h-[72px] px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono resize-y"
              />
              <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                {isMac ? '⌘' : 'Ctrl'}+Enter to run · each line runs in order on every selected device
              </p>
            </div>
            <button
              onClick={() => void run()}
              disabled={running || lines.length === 0 || targets.length === 0}
              className="flex items-center gap-1.5 px-3 h-9 text-sm bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white rounded-lg transition-colors whitespace-nowrap"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {runLabel}
            </button>
            {results.length > 0 && (
              <button
                onClick={exportCsv}
                className="flex items-center gap-1.5 px-3 h-9 text-sm bg-[var(--bg-tertiary)] hover:bg-[var(--border)] text-[var(--text-primary)] rounded-lg transition-colors"
                title="Export results as CSV"
              >
                <Download size={14} />
                CSV
              </button>
            )}
          </div>

          {/* Results */}
          {results.map((r) => (
            <div key={r.sessionId} className="border border-[var(--border)] rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-primary)]">
                {r.status === 'running' ? (
                  <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
                ) : r.status === 'error' ? (
                  <AlertCircle size={12} className="text-[var(--accent-danger)]" />
                ) : r.status === 'done' ? (
                  <CheckCircle2 size={12} className="text-[var(--accent-success)]" />
                ) : (
                  <Square size={12} className="text-[var(--text-muted)]" />
                )}
                <span className="text-xs font-medium text-[var(--text-primary)]">{r.name}</span>
                {r.truncated && (
                  <span className="text-[10px] uppercase tracking-wide text-[var(--accent-warning)]">
                    truncated
                  </span>
                )}
              </div>
              {r.steps.length > 0 && (
                <div className="max-h-48 overflow-y-auto bg-[var(--bg-secondary)]">
                  {r.steps.map((st, i) => (
                    <div key={i}>
                      {/* Label each block when several lines ran, so outputs aren't one wall of text. */}
                      {r.steps.length > 1 && st.command && (
                        <div className="px-3 pt-2 text-[10px] font-mono text-[var(--accent)]">› {st.command}</div>
                      )}
                      <pre
                        className={`px-3 py-2 text-[11px] font-mono whitespace-pre-wrap break-all ${
                          st.error ? 'text-[var(--accent-danger)]' : 'text-[var(--text-secondary)]'
                        }`}
                      >
                        {stepText(st)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
