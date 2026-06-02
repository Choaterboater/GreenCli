import { useState, useEffect } from 'react';
import { X, Play, Download, Loader2, CheckCircle2, AlertCircle, Square, CheckSquare } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { sendAndCapture } from '../utils/terminal';

interface RunResult {
  sessionId: string;
  name: string;
  output: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

// Run a single command across many connected sessions and collect each output.
export default function BulkRunner() {
  const { showBulkRunner, setShowBulkRunner, sessions } = useSessionStore();
  const connected = sessions.filter((s) => s.connected);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunResult[]>([]);

  // Default to all connected sessions each time the modal opens.
  useEffect(() => {
    if (showBulkRunner) {
      setSelected(new Set(sessions.filter((s) => s.connected).map((s) => s.sessionId)));
      setResults([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBulkRunner]);

  if (!showBulkRunner) return null;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async () => {
    if (!command.trim() || running) return;
    const targets = connected.filter((s) => selected.has(s.sessionId));
    if (targets.length === 0) return;
    setRunning(true);
    setResults(
      targets.map((s) => ({
        sessionId: s.sessionId,
        name: s.config.name || s.config.host || 'Session',
        output: '',
        status: 'pending' as const,
      }))
    );

    for (const s of targets) {
      setResults((prev) =>
        prev.map((r) => (r.sessionId === s.sessionId ? { ...r, status: 'running' } : r))
      );
      try {
        const out = await sendAndCapture(s.sessionId, command);
        setResults((prev) =>
          prev.map((r) =>
            r.sessionId === s.sessionId ? { ...r, output: out || '(no output)', status: 'done' } : r
          )
        );
      } catch (e) {
        setResults((prev) =>
          prev.map((r) =>
            r.sessionId === s.sessionId ? { ...r, output: String(e), status: 'error' } : r
          )
        );
      }
    }
    setRunning(false);
  };

  const exportCsv = () => {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = [['device', 'command', 'output'].map(esc).join(',')];
    for (const r of results) rows.push([r.name, command, r.output].map(esc).join(','));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bulk-run-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
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
              Target sessions ({selected.size}/{connected.length} connected)
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
                    >
                      {on ? <CheckSquare size={12} /> : <Square size={12} />}
                      {s.config.name || s.config.host || 'Session'}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Command */}
          <div className="flex items-center gap-2">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && run()}
              placeholder="Command to run on all selected (e.g. show version)"
              className="flex-1 h-9 px-3 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
            />
            <button
              onClick={run}
              disabled={running || !command.trim() || selected.size === 0}
              className="flex items-center gap-1.5 px-3 h-9 text-sm bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white rounded-lg transition-colors"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              Run
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
              </div>
              {r.output && (
                <pre className="px-3 py-2 text-[11px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-all max-h-48 overflow-y-auto bg-[var(--bg-secondary)]">
                  {r.output}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
