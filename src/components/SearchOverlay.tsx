import { useState, useEffect, useRef } from 'react';
import { X, ChevronUp, ChevronDown } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { getSearchAdapter, onSearchCommand } from '../utils/terminalSearch';
import { shortcutLabel } from '../utils/shortcuts';
import { DeviceType, deviceMeta } from '../types';

type Chip = { label: string; pattern: string };

// Chips are regexes and always search case-insensitively (whatever the Aa
// toggle says) — so no inline flags: JS RegExp has no `(?i)`, and a pattern
// using it is a syntax error that matches nothing.
const LOG_CHIPS: Chip[] = [
  { label: 'error', pattern: 'error|fail|invalid' },
  { label: 'warning', pattern: 'warn' },
];

// Aruba (AOS-CX / AOS-S / controllers / APs) and other IOS-style CLIs:
// section starts in `show running-config`.
const ARUBA_CHIPS: Chip[] = [
  { label: 'vlan', pattern: '^vlan ' },
  { label: 'interface', pattern: '^interface ' },
  { label: 'router bgp', pattern: '^router bgp' },
  { label: 'ospf', pattern: 'router ospf|ip ospf' },
  { label: 'ip route', pattern: '^ip route' },
  { label: 'aaa', pattern: '^aaa ' },
  { label: 'ntp', pattern: '^ntp ' },
  { label: 'hostname', pattern: '^hostname ' },
];

// Junos (and Mist-managed switches, which run Junos): `show configuration |
// display set` lines, physical interface names, commits and link-state logs.
// The interface pattern needs the word boundary + digit: a bare `et-` also
// hits every "ethernet-switching" line.
const JUNOS_CHIPS: Chip[] = [
  { label: 'set interfaces', pattern: '^set interfaces' },
  { label: 'set vlans', pattern: '^set vlans' },
  { label: 'set protocols', pattern: '^set protocols' },
  { label: 'routing-options', pattern: '^set routing-options' },
  { label: 'ge-/xe-/et-', pattern: '\\b(ge|xe|et)-\\d' },
  { label: 'commit', pattern: 'commit' },
  { label: 'link down', pattern: 'Physical link is Down' },
];

function chipsFor(deviceType: DeviceType): Chip[] {
  const vendor = deviceMeta(deviceType).vendor;
  const vendorChips = vendor === 'juniper' || vendor === 'mist' ? JUNOS_CHIPS : ARUBA_CHIPS;
  return [...vendorChips, ...LOG_CHIPS];
}

interface SearchOverlayProps {
  /** Session to search. Defaults to the active tab (the focused pane in
   *  split view); pop-out windows pass their own session. */
  sessionId?: string;
  /** Picks the "Jump to" chips. Defaults to the searched session's type. */
  deviceType?: DeviceType;
  /** Position classes for the floating bar. */
  className?: string;
}

export default function SearchOverlay({
  sessionId: sessionOverride,
  deviceType: deviceOverride,
  className = 'top-12 right-4',
}: SearchOverlayProps) {
  // Narrow selectors — a whole-store subscription re-rendered the bar on
  // every session/UI change.
  const showSearch = useSessionStore((s) => s.showSearch);
  const setShowSearch = useSessionStore((s) => s.setShowSearch);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionId = sessionOverride ?? activeSessionId;
  const storeDeviceType = useSessionStore(
    (s) => s.sessions.find((x) => x.sessionId === sessionId)?.config.deviceType,
  );
  const chips = chipsFor(deviceOverride ?? storeDeviceType ?? 'generic');

  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  // The chip pattern currently searched (null once the user edits the query).
  const [chip, setChip] = useState<string | null>(null);
  const [resultIndex, setResultIndex] = useState(-1);
  const [resultCount, setResultCount] = useState(0);
  const [regexError, setRegexError] = useState(false);
  // A pending "focus the input" request (Find pressed again / Find selection).
  const [focusReq, setFocusReq] = useState<{ prefill?: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const adapter = sessionId ? getSearchAdapter(sessionId) : undefined;

  // Chips ignore the Aa toggle: "error" must also find "ERROR" / "Error".
  const caseFor = (term: string) => (chip !== null && term === chip ? false : caseSensitive);

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
    const cs = opts?.caseSensitive ?? caseFor(term);
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

  // F3 / Shift+F3 / ⌘G arrive as commands (the key may be pressed with focus
  // back in the terminal). Read through a ref so the subscription below is
  // made once yet always steps with the current query and session.
  const stepRef = useRef<(dir: 'next' | 'prev') => void>(() => {});
  stepRef.current = (dir) => {
    if (showSearch && query) safeFind(dir, query);
  };
  useEffect(
    () =>
      onSearchCommand((cmd) => {
        if (cmd.type === 'focus') setFocusReq({ prefill: cmd.prefill });
        else stepRef.current(cmd.type);
      }),
    [],
  );

  // Subscribe to result count updates
  useEffect(() => {
    if (!showSearch || !adapter) return;
    return adapter.onResultsChange(({ resultIndex: ri, resultCount: rc }) => {
      setResultIndex(ri);
      setResultCount(rc);
    });
  }, [showSearch, sessionId, adapter]);

  // Focus the input when the bar OPENS — not whenever the adapter changes:
  // with split view, clicking another pane switches the searched session, and
  // refocusing here pulled the typing meant for that pane into the search box.
  useEffect(() => {
    if (!showSearch) return;
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [showSearch]);

  // Switching the searched session leaves the old pane's match highlights
  // behind — clear them when the adapter changes (and on unmount).
  useEffect(() => () => adapter?.clearDecorations(), [adapter]);

  // Clear state and decorations on close
  useEffect(() => {
    if (!showSearch) {
      adapter?.clearDecorations();
      setQuery('');
      setChip(null);
      setResultIndex(-1);
      setResultCount(0);
      setRegexError(false);
      setUseRegex(false);
      setCaseSensitive(false);
    }
  }, [showSearch, adapter]);

  // Serve a focus request once the bar is showing — after the results
  // subscription above, so a prefilled search's match count is not missed.
  useEffect(() => {
    if (!focusReq || !showSearch) return;
    setFocusReq(null);
    const prefill = focusReq.prefill;
    if (prefill) {
      setChip(null);
      setQuery(prefill);
      if (useRegex) {
        // Selected text is literal; the options effect re-runs the search
        // once regex mode is off (a direct find here would search twice).
        setUseRegex(false);
      } else {
        safeFind('next', prefill, { regex: false, caseSensitive });
      }
    }
    inputRef.current?.focus();
    inputRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq, showSearch]);

  // Re-run search when regex/case toggles change. Deliberately NOT keyed on
  // `query`: keystrokes search via handleChange, and running here too searched
  // twice per keystroke — landing on the 2nd match and drifting down the buffer.
  useEffect(() => {
    if (!query || !adapter) return;
    // Clear first — the addon caches highlights by term, so an options-only
    // change would otherwise keep decorations computed with the OLD options.
    adapter.clearDecorations();
    safeFind('next', query, { regex: useRegex, caseSensitive: caseFor(query) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useRegex, caseSensitive]);

  // Switching tabs while the overlay is open must not leave stale highlights
  // on the terminal we left; carry the search over to the new one instead.
  useEffect(() => {
    if (!adapter) return;
    if (query) safeFind('next', query);
    return () => {
      adapter.clearDecorations();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  const handleChange = (val: string) => {
    setQuery(val);
    // Typing makes it the user's own query again — the Aa toggle applies.
    setChip(null);
    safeFind('next', val, { caseSensitive });
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
    setChip(pattern);
    setQuery(pattern);
    if (!useRegex) {
      // The options effect re-runs the search once the toggle lands — a direct
      // find here too would search twice and skip to the 2nd match.
      setUseRegex(true);
    } else {
      safeFind('next', pattern, { regex: true, caseSensitive: false });
    }
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
    <div className={`glass absolute z-40 w-[440px] max-w-[calc(100%-2rem)] rounded-lg shadow-elevation-3 animate-scale-in ${className}`}>
      {/* Search row */}
      <div className="flex items-center gap-1.5 px-3 py-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in terminal…"
          className="flex-1 min-w-0 h-7 bg-transparent text-sm placeholder-[var(--text-muted)] focus:outline-none"
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
          title={`Previous match (Shift+Enter or ${shortcutLabel('findPrev')})`}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
        >
          <ChevronUp size={14} />
        </button>
        <button
          onClick={() => safeFind('next', query)}
          disabled={!query}
          title={`Next match (Enter or ${shortcutLabel('findNext')})`}
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
          title="Close (Esc)"
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <X size={14} />
        </button>
      </div>

      {/* Section chips — matched to the session's vendor */}
      <div className="px-3 pb-2 pt-1.5 flex flex-wrap gap-1 border-t border-[var(--border)]">
        <span className="text-[10px] text-[var(--text-muted)] self-center mr-0.5">Jump to:</span>
        {chips.map(({ label, pattern }) => (
          <button
            key={label}
            onClick={() => handleChip(pattern)}
            title={`Find ${pattern} (ignores case)`}
            className={`px-2 py-0.5 text-[10px] rounded border transition-colors whitespace-nowrap ${
              chip === pattern && query === pattern && useRegex
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
