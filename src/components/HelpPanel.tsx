import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X, Search, HelpCircle, Bot, ChevronRight } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { HELP_TOPICS, type HelpActionId, type HelpBlock, type HelpTopic } from '../data/helpContent';

/** Render inline `code` and **bold** in a help string. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(
        <code key={`${keyBase}-${i}`} className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--accent)] text-[12px] font-mono">
          {tok.slice(1, -1)}
        </code>
      );
    } else {
      out.push(
        <strong key={`${keyBase}-${i}`} className="text-[var(--text-primary)] font-semibold">
          {tok.slice(2, -2)}
        </strong>
      );
    }
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Block({ block, idx }: { block: HelpBlock; idx: number }) {
  const k = `b${idx}`;
  switch (block.kind) {
    case 'p':
      return <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">{renderInline(block.text || '', k)}</p>;
    case 'note':
      return (
        <div className="text-[12px] leading-relaxed text-[var(--text-secondary)] border-l-2 border-[var(--accent)] pl-3 py-1 bg-[var(--accent-soft)] rounded-r">
          {renderInline(block.text || '', k)}
        </div>
      );
    case 'code':
      return (
        <pre className="text-[12px] font-mono bg-[var(--bg-inset)] border border-[var(--border)] rounded-md p-2.5 overflow-x-auto text-[var(--text-primary)]">
          {block.text}
        </pre>
      );
    case 'steps':
      return (
        <ol className="space-y-1.5">
          {(block.items || []).map((it, i) => (
            <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] text-[11px] font-semibold flex items-center justify-center mt-0.5">
                {i + 1}
              </span>
              <span>{renderInline(it, `${k}-${i}`)}</span>
            </li>
          ))}
        </ol>
      );
    case 'bullets':
      return (
        <ul className="space-y-1.5">
          {(block.items || []).map((it, i) => (
            <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
              <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-[var(--accent)] mt-1.5" />
              <span>{renderInline(it, `${k}-${i}`)}</span>
            </li>
          ))}
        </ul>
      );
  }
}

/** Flatten a topic's searchable text. */
function topicText(t: HelpTopic): string {
  const blockText = t.blocks
    .map((b) => (b.text ? b.text : (b.items || []).join(' ')))
    .join(' ');
  return `${t.title} ${t.summary} ${t.keywords.join(' ')} ${blockText}`.toLowerCase();
}

export default function HelpPanel() {
  const store = useSessionStore();
  const { showHelp, setShowHelp } = store;
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState(HELP_TOPICS[0].id);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return HELP_TOPICS;
    const terms = q.split(/\s+/);
    return HELP_TOPICS.filter((t) => {
      const hay = topicText(t);
      return terms.every((term) => hay.includes(term));
    });
  }, [query]);

  // Keep the active topic valid as the filter changes.
  useEffect(() => {
    if (filtered.length && !filtered.some((t) => t.id === activeId)) {
      setActiveId(filtered[0].id);
    }
  }, [filtered, activeId]);

  // Focus search when the panel opens.
  useEffect(() => {
    if (showHelp) {
      setQuery('');
      const id = setTimeout(() => searchRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [showHelp]);

  // Close on Escape.
  useEffect(() => {
    if (!showHelp) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowHelp(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showHelp, setShowHelp]);

  if (!showHelp) return null;

  const active = filtered.find((t) => t.id === activeId) || filtered[0] || HELP_TOPICS[0];

  const runAction = (id: HelpActionId) => {
    setShowHelp(false);
    switch (id) {
      case 'open-settings': store.setShowSettings(true); break;
      case 'open-quick-connect': store.setShowQuickConnect(true); break;
      case 'open-ai': store.setShowAiAssistant(true); break;
      case 'open-api': store.setShowApiExplorer(true); break;
      case 'open-intent': store.setShowIntent(true); break;
      case 'open-tunnels': store.setShowTunnels(true); break;
    }
  };

  const askAi = () => {
    setShowHelp(false);
    store.setShowAiAssistant(true);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setShowHelp(false);
      }}
    >
      <div className="surface-elevated w-[840px] max-w-[95vw] h-[82vh] flex flex-col animate-scale-in">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-center w-7 h-7 rounded-md" style={{ background: 'var(--accent-soft)' }}>
            <HelpCircle size={15} style={{ color: 'var(--accent)' }} />
          </div>
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Help &amp; Documentation</h2>
          <span className="flex-1" />
          <button
            onClick={askAi}
            className="flex items-center gap-1.5 h-8 px-3 text-[12px] rounded-md bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-[var(--text-primary)]"
            title="Open the AI assistant"
          >
            <Bot size={13} /> Ask the AI
          </button>
          <button onClick={() => setShowHelp(false)} className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Topic rail */}
          <div className="w-[260px] flex-shrink-0 border-r border-[var(--border)] flex flex-col">
            <div className="p-2.5">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search help…"
                  className="input-field w-full h-8 pl-8 pr-2.5 text-sm"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-1.5 pb-2">
              {filtered.length === 0 ? (
                <p className="text-[12px] text-[var(--text-muted)] px-2.5 py-2">No topics match “{query}”.</p>
              ) : (
                filtered.map((t) => {
                  const Icon = t.icon;
                  const on = t.id === active.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setActiveId(t.id)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors ${
                        on ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-tertiary)]'
                      }`}
                    >
                      <Icon size={15} style={{ color: on ? 'var(--accent)' : 'var(--text-muted)' }} className="flex-shrink-0" />
                      <span className="min-w-0">
                        <span className={`block text-[13px] truncate ${on ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]'}`}>
                          {t.title}
                        </span>
                      </span>
                      {on && <ChevronRight size={13} className="ml-auto text-[var(--accent)]" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="flex items-center gap-2.5 mb-1">
              <active.icon size={18} style={{ color: 'var(--accent)' }} />
              <h3 className="text-[17px] font-semibold text-[var(--text-primary)]">{active.title}</h3>
            </div>
            <p className="text-[12px] text-[var(--text-muted)] mb-4">{active.summary}</p>
            <div className="space-y-3.5">
              {active.blocks.map((b, i) => (
                <Block key={i} block={b} idx={i} />
              ))}
            </div>
            {active.action && (
              <button
                onClick={() => runAction(active.action!.id)}
                className="btn-accent mt-5 flex items-center gap-1.5 h-8 px-3.5 text-[12px]"
              >
                {active.action.label}
                <ChevronRight size={14} />
              </button>
            )}
            <p className="mt-6 pt-4 border-t border-[var(--border)] text-[11px] text-[var(--text-muted)]">
              Full guide: <code className="text-[var(--accent)]">docs/SETUP.md</code> in the repo. Press
              <code className="mx-1 px-1 rounded bg-[var(--bg-tertiary)]">F1</code> any time to reopen Help.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
