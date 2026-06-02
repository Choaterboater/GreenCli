import { useState } from 'react';
import { Plus, Trash2, Bell, BellOff, Regex } from 'lucide-react';
import { useTriggersStore } from '../store/triggersStore';
import { notify } from '../store/toastStore';

export default function TriggersSettings() {
  const { triggers, addTrigger, removeTrigger } = useTriggersStore();
  const [pattern, setPattern] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [bell, setBell] = useState(true);

  const add = () => {
    const p = pattern.trim();
    if (!p) return;
    // Validate a regex at add-time — otherwise a bad pattern (e.g. "[") is saved,
    // silently swallowed on every chunk, and just never fires with no explanation.
    if (isRegex) {
      try {
        new RegExp(p, 'im');
      } catch (e) {
        notify.error('Invalid regular expression', e instanceof Error ? e.message : String(e));
        return;
      }
    }
    addTrigger({ pattern: p, isRegex, bell });
    setPattern('');
  };

  return (
    <section>
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1.5">Output triggers</h3>
      <p className="text-[11px] text-[var(--text-secondary)] mb-3">
        Toast (and optionally beep) when a keyword/regex appears in any terminal's output — e.g.
        <code className="text-[var(--accent)] mx-1">%ERROR</code>, <code className="text-[var(--accent)] mr-1">link.*down</code>.
      </p>

      <div className="flex items-center gap-1.5 mb-2">
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="keyword or regex…"
          className="input-field flex-1 h-8 px-2.5 text-sm font-mono"
        />
        <button
          onClick={() => setIsRegex((v) => !v)}
          title="Treat as regular expression"
          className={`flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${
            isRegex
              ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
          }`}
        >
          <Regex size={14} />
        </button>
        <button
          onClick={() => setBell((v) => !v)}
          title="Beep on match"
          className={`flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${
            bell
              ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
          }`}
        >
          {bell ? <Bell size={14} /> : <BellOff size={14} />}
        </button>
        <button onClick={add} className="btn-accent flex items-center justify-center w-8 h-8">
          <Plus size={15} />
        </button>
      </div>

      {triggers.length > 0 && (
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-inset)] divide-y divide-[var(--border)]">
          {triggers.map((t) => (
            <div key={t.id} className="flex items-center gap-2 px-3 py-1.5">
              <code className="flex-1 text-[12px] text-[var(--text-primary)] font-mono truncate">{t.pattern}</code>
              {t.isRegex && <span className="text-[9px] px-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">regex</span>}
              {t.bell && <Bell size={11} className="text-[var(--text-muted)]" />}
              <button
                onClick={() => removeTrigger(t.id)}
                className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)]"
                title="Remove"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
