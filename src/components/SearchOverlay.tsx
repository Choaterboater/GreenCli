import { useState, useEffect, useRef } from 'react';
import { X, ChevronUp, ChevronDown } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { getSearchAdapter } from '../utils/terminalSearch';

const SECTION_CHIPS = [
  { label: 'vlan', pattern: '^vlan ' },
  { label: 'interface', pattern: '^interface ' },
  { label: 'router bgp', pattern: '^router bgp' },
  { label: 'ospf', pattern: 'router ospf|ip ospf' },
  { label: 'ip route', pattern: '^ip route' },
  { label: 'aaa', pattern: '^aaa ' },
  { label: 'ntp', pattern: '^ntp ' },
  { label: 'hostname', pattern: '^hostname ' },
];

export default function SearchOverlay() {
  const { showSearch, setShowSearch, activeSessionId } = useSessionStore();
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [resultIndex, setResultIndex] = useState(-1);
  const [resultCount, setResultCount] = useState(0);
  const [regexError, setRegexError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const adapter = activeSessionId ? getSearchAdapter(activeSessionId) : undefined;

  // A malformed pattern makes xterm-addon-search's `new RegExp(term)` throw
  // synchronously inside the handler, corrupting state. Guard every find call.
  const safeFind = (
    dir: 'next' | 'prev',
    term: string,
    opts?: { regex?: boolean; caseSensitive?: boolean }
  ): boolean => {
    if (!adapter) return false;
    if (!term) {
      adapter.clearDecorations();
      setResultIndex(-1);
      setResultCount(0);
      setRegexError(false);
      return false;
    }
    const regex = opts?.regex ?? useRegex;
    const cs = opts?.caseSensitive ?? caseSensitive;
    if (regex) {
      try {
        // eslint-disable-next-line no-new
        new RegExp(term);
      } catch {
        setRegexError(true);
        adapter.clearDecorations();
        setResultIndex(-1);
        setResultCount(0);
        return false;
      }
    }
    setRegexError(false);
    return dir === 'next'
      ? adapter.findNext(term, { incremental: true, regex, caseSensitive: cs })
      : adapter.findPrevious(term, { incremental: true, regex, caseSensitive: cs });
  };

  // Subscribe to result count updates
  useEffect(() => {
    if (!showSearch || !adapter) return;
    return adapter.onResultsChange(({ resultIndex: ri, resultCount: rc }) => {
      setResultIndex(ri);
      setResultCount(rc);
    });
  }, [showSearch, activeSessionId, adapter]);

  // Focus input on open; clear state and decorations on close
  useEffect(() => {
    if (showSearch) {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    } else {
      adapter?.clearDecorations();
      setQuery('');
      setResultIndex(-1);
      setResultCount(0);
      setRegexError(false);
      setUseRegex(false);
      setCaseSensitive(false);
    }
  }, [showSearch, adapter]);

  // Re-run search when regex/case toggles change
  useEffect(() => {
    if (!query || !adapter) return;
    safeFind('next', query, { regex: useRegex, caseSensitive });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useRegex, caseSensitive, adapter, query]);

  const handleChange = (val: string) => {
    setQuery(val);
    safeFind('next', val);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setShowSearch(false);
    } else if (e.key === 'Enter' && query) {
      e.preventDefault();
      safeFind(e.shiftKey ? 'prev' : 'next', query);
    }
  };

  const handleChip = (pattern: string) => {
    setUseRegex(true);
    setQuery(pattern);
    safeFind('next', pattern, { regex: true });
    inputRef.current?.focus();
  };

  const danger = regexError || (query.length > 0 && resultCount === 0);

  const resultLabel = () => {
    if (!query) return '';
    if (regexError) return 'Invalid regex';
    if (query.length > 0 && resultCount === 0) return 'No results';
    if (resultIndex === -1) return `${resultCount}+`;
    return `${resultIndex + 1} / ${resultCount}`;
  };

  if (!showSearch) return null;

  const toggleCls = (active: boolean, mono = false) =>
    `px-1.5 py-0.5 text-[10px] ${mono ? 'font-mono' : 'font-semibold'} rounded border transition-colors ${
      active
        ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
        : 'bg-transparent border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
    }`;

  return (
    <div className="glass absolute top-12 right-4 z-40 w-[440px] rounded-lg shadow-elevation-3 animate-scale-in">
      {/* Search row */}
      <div className="flex items-center gap-1.5 px-3 py-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in terminal…"
          className="flex-1 h-7 bg-transparent text-sm placeholder-[var(--text-muted)] focus:outline-none"
          style={{ color: danger ? 'var(--accent-danger)' : 'var(--text-primary)' }}
        />

        <span
          className="text-xs whitespace-nowrap min-w-[64px] text-right tabular-nums"
          style={{ color: danger ? 'var(--accent-danger)' : 'var(--text-secondary)' }}
        >
          {resultLabel()}
        </span>

        <button
          onClick={() => safeFind('prev', query)}
          disabled={!query}
          title="Previous match (Shift+Enter)"
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
        >
          <ChevronUp size={14} />
        </button>
        <button
          onClick={() => safeFind('next', query)}
          disabled={!query}
          title="Next match (Enter)"
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
        >
          <ChevronDown size={14} />
        </button>

        <button onClick={() => setCaseSensitive((v) => !v)} title="Case sensitive" className={toggleCls(caseSensitive)}>
          Aa
        </button>
        <button onClick={() => setUseRegex((v) => !v)} title="Use regular expression" className={toggleCls(useRegex, true)}>
          .*
        </button>

        <button
          onClick={() => setShowSearch(false)}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <X size={14} />
        </button>
      </div>

      {/* Section chips */}
      <div className="px-3 pb-2 pt-1.5 flex flex-wrap gap-1 border-t border-[var(--border)]">
        <span className="text-[10px] text-[var(--text-muted)] self-center mr-0.5">Jump to:</span>
        {SECTION_CHIPS.map(({ label, pattern }) => (
          <button
            key={label}
            onClick={() => handleChip(pattern)}
            className={`px-2 py-0.5 text-[10px] rounded border transition-colors whitespace-nowrap ${
              query === pattern && useRegex
                ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                : 'bg-[var(--bg-inset)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
