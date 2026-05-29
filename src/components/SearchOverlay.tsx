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
  const inputRef = useRef<HTMLInputElement>(null);

  const adapter = activeSessionId ? getSearchAdapter(activeSessionId) : undefined;

  // Subscribe to result count updates
  useEffect(() => {
    if (!showSearch || !adapter) return;
    return adapter.onResultsChange(({ resultIndex: ri, resultCount: rc }) => {
      setResultIndex(ri);
      setResultCount(rc);
    });
  }, [showSearch, activeSessionId]);

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
      setUseRegex(false);
      setCaseSensitive(false);
    }
  }, [showSearch]);

  // Re-run search when regex/case toggles change
  useEffect(() => {
    if (!query || !adapter) return;
    adapter.findNext(query, { incremental: true, regex: useRegex, caseSensitive });
  }, [useRegex, caseSensitive]);

  // Global Ctrl+F to open
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setShowSearch]);

  const runSearch = (term: string, opts?: { regex?: boolean; caseSensitive?: boolean }) => {
    if (!adapter) return;
    if (!term) {
      adapter.clearDecorations();
      setResultIndex(-1);
      setResultCount(0);
      return;
    }
    adapter.findNext(term, {
      incremental: true,
      regex: opts?.regex ?? useRegex,
      caseSensitive: opts?.caseSensitive ?? caseSensitive,
    });
  };

  const handleChange = (val: string) => {
    setQuery(val);
    runSearch(val);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setShowSearch(false);
    } else if (e.key === 'Enter' && query) {
      e.preventDefault();
      if (e.shiftKey) {
        adapter?.findPrevious(query, { regex: useRegex, caseSensitive });
      } else {
        adapter?.findNext(query, { regex: useRegex, caseSensitive });
      }
    }
  };

  const handleChip = (pattern: string) => {
    setUseRegex(true);
    setQuery(pattern);
    runSearch(pattern, { regex: true });
    inputRef.current?.focus();
  };

  const notFound = query.length > 0 && resultCount === 0;

  const resultLabel = () => {
    if (!query) return '';
    if (notFound) return 'No results';
    if (resultIndex === -1) return `${resultCount}+`;
    return `${resultIndex + 1} / ${resultCount}`;
  };

  if (!showSearch) return null;

  return (
    <div className="absolute top-10 right-4 z-40 w-[440px] bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl">
      {/* Search row */}
      <div className="flex items-center gap-1.5 px-3 py-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in terminal..."
          className={`flex-1 h-7 bg-transparent text-sm placeholder-[#484f58] focus:outline-none ${
            notFound ? 'text-[#f85149]' : 'text-[#c9d1d9]'
          }`}
        />

        <span
          className={`text-xs whitespace-nowrap min-w-[60px] text-right tabular-nums ${
            notFound ? 'text-[#f85149]' : 'text-[#8b949e]'
          }`}
        >
          {resultLabel()}
        </span>

        <button
          onClick={() => adapter?.findPrevious(query, { regex: useRegex, caseSensitive })}
          disabled={!query}
          title="Previous match (Shift+Enter)"
          className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] disabled:opacity-40"
        >
          <ChevronUp size={14} />
        </button>
        <button
          onClick={() => adapter?.findNext(query, { regex: useRegex, caseSensitive })}
          disabled={!query}
          title="Next match (Enter)"
          className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] disabled:opacity-40"
        >
          <ChevronDown size={14} />
        </button>

        <button
          onClick={() => setCaseSensitive((v) => !v)}
          title="Case sensitive"
          className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border transition-colors ${
            caseSensitive
              ? 'bg-[#238636] border-[#238636] text-white'
              : 'bg-transparent border-[#30363d] text-[#8b949e] hover:border-[#484f58]'
          }`}
        >
          Aa
        </button>
        <button
          onClick={() => setUseRegex((v) => !v)}
          title="Use regular expression"
          className={`px-1.5 py-0.5 text-[10px] font-mono rounded border transition-colors ${
            useRegex
              ? 'bg-[#238636] border-[#238636] text-white'
              : 'bg-transparent border-[#30363d] text-[#8b949e] hover:border-[#484f58]'
          }`}
        >
          .*
        </button>

        <button
          onClick={() => setShowSearch(false)}
          className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]"
        >
          <X size={14} />
        </button>
      </div>

      {/* Section chips */}
      <div className="px-3 pb-2 pt-1.5 flex flex-wrap gap-1 border-t border-[#21262d]">
        <span className="text-[10px] text-[#484f58] self-center mr-0.5">Jump to:</span>
        {SECTION_CHIPS.map(({ label, pattern }) => (
          <button
            key={label}
            onClick={() => handleChip(pattern)}
            className={`px-2 py-0.5 text-[10px] rounded border transition-colors whitespace-nowrap ${
              query === pattern && useRegex
                ? 'bg-[#1f6feb] border-[#388bfd] text-[#c9d1d9]'
                : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:border-[#484f58] hover:text-[#c9d1d9]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
