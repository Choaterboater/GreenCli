// The Config Editor's Problems panel (Ctrl+Shift+M), like VS Code's: every
// problem in the tab with its line, filterable by kind; a click selects it in
// the editor. The panel stays open while you work through the list.

import { useState } from 'react';
import { AlertTriangle, Info, X, XCircle } from 'lucide-react';
import { MAX_PROBLEMS, type ConfigProblem, type ProblemSeverity } from '../utils/configProblems';

interface Props {
  problems: readonly ConfigProblem[];
  /** The checks stopped at MAX_PROBLEMS. */
  capped: boolean;
  /** Rows can't jump while the editor shows a diff. */
  disabled: boolean;
  onJump: (problem: ConfigProblem) => void;
  onClose: () => void;
}

const KINDS: Array<{ severity: ProblemSeverity; label: string; icon: typeof XCircle; color: string }> = [
  { severity: 'error', label: 'Errors', icon: XCircle, color: 'var(--accent-danger)' },
  { severity: 'warning', label: 'Warnings', icon: AlertTriangle, color: 'var(--accent-warning)' },
  { severity: 'info', label: 'Tips', icon: Info, color: 'var(--accent-info)' },
];

export default function ProblemsPanel({ problems, capped, disabled, onJump, onClose }: Props) {
  const [hidden, setHidden] = useState<Record<ProblemSeverity, boolean>>({ error: false, warning: false, info: false });
  const shown = problems.filter((p) => !hidden[p.severity]);

  return (
    <section
      aria-label="Problems"
      className="flex flex-col h-40 flex-shrink-0 border-t border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]"
    >
      <div className="flex items-center gap-1 h-7 px-2 border-b border-[var(--bg-tertiary)] flex-shrink-0">
        <span className="text-[10px] font-semibold tracking-wide uppercase text-[var(--text-secondary)] mr-1">Problems</span>
        {KINDS.map(({ severity, label, icon: Icon, color }) => {
          const count = problems.filter((p) => p.severity === severity).length;
          return (
            <button
              key={severity}
              onClick={() => setHidden((h) => ({ ...h, [severity]: !h[severity] }))}
              aria-pressed={!hidden[severity]}
              title={hidden[severity] ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors hover:bg-[var(--bg-tertiary)] ${
                hidden[severity] ? 'opacity-40' : ''
              }`}
            >
              <Icon size={11} style={{ color }} />
              <span className="text-[var(--text-secondary)]">
                {count} {count === 1 ? label.slice(0, -1).toLowerCase() : label.toLowerCase()}
              </span>
            </button>
          );
        })}
        <span className="flex-1" />
        <span className="text-[10px] text-[var(--text-muted)] mr-1">F8 next · Shift+F8 previous</span>
        <button
          onClick={onClose}
          className="p-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          title="Close (Ctrl+Shift+M)"
          aria-label="Close Problems"
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-0.5">
        {shown.length === 0 ? (
          <p className="px-3 py-2 text-xs text-[var(--text-muted)]">
            {problems.length === 0 ? 'No problems in this tab.' : 'All problems are hidden by the filter above.'}
          </p>
        ) : (
          shown.map((problem, index) => {
            const kind = KINDS.find((k) => k.severity === problem.severity) ?? KINDS[0];
            const Icon = kind.icon;
            return (
              <button
                key={`${problem.lineNumber}-${problem.startColumn}-${problem.code}-${index}`}
                onClick={() => onJump(problem)}
                disabled={disabled}
                title={disabled ? 'Exit the diff to jump to a line' : `Go to line ${problem.lineNumber}`}
                className="grid grid-cols-[1rem_5.5rem_1fr] items-start gap-1 w-full px-3 py-1 text-xs text-left hover:bg-[var(--bg-tertiary)] disabled:hover:bg-transparent"
              >
                <Icon size={12} className="mt-0.5" style={{ color: kind.color }} />
                <span className="text-[var(--text-muted)] tabular-nums">
                  Ln {problem.lineNumber}, Col {problem.startColumn}
                </span>
                <span className="text-[var(--text-primary)]">{problem.message}</span>
              </button>
            );
          })
        )}
        {capped && (
          <p className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
            Showing the first {MAX_PROBLEMS}. Fix some to see the rest.
          </p>
        )}
      </div>
    </section>
  );
}
