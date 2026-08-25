import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon } from 'xterm-addon-search';
import { invoke } from '@tauri-apps/api/tauri';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { useDialogStore } from '../store/dialogStore';
import { notify } from '../store/toastStore';
import { useTheme } from '../hooks/useTheme';
import { stripAnsi, hasAnsi } from '../utils/terminal';
import {
  Loader2,
  AlertCircle,
  Search,
  ArrowUp,
  ArrowDown,
  X,
  ExternalLink,
  Link,
  Scroll,
  MousePointer,
  Copy,
  ClipboardPaste,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RefreshCw,
} from 'lucide-react';
import { ArubaHighlighter, AnsiProcessor } from '../syntax/highlighter';

// Mirror these into xterm's canvas layer: the app themes every surface with CSS
// variables, but xterm only understands concrete colors. useTheme() keeps them
// in sync per theme (see useTheme.ts TERMINAL_THEMES).
// Font family is set in the mount effect (reads settings once) so changing the
// terminal font does not re-subscribe the output listener (which loses output).
const TERMINAL_FONT_STACK = '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace';

const isMac = navigator.platform.toUpperCase().includes('MAC');
const isWindows = navigator.platform.toUpperCase().includes('WIN');

// Max lines syntax-highlighted per output flush (see processText).
const HIGHLIGHT_LINE_CAP = 1500;

interface TerminalProps {
  sessionId: string;
  deviceType?: string;
  onSend?: (data: string) => void;
}

interface SearchMatch {
  line: number;
  col: number;
  length: number;
}

interface TermLine {
  translateToString(trimRight?: boolean): string;
}
interface TermBuffer {
  cursorY: number;
  viewportY: number;
  baseY: number;
  length: number;
  getLine(y: number): TermLine | undefined;
}

// Fit/readiness barrier (B2): the mount effect must not subscribe to output events
// or start the resize observer until the terminal has been fitted to a non-zero
// size; the first backend output of a session drives readiness instead.

export default function Terminal({ sessionId, deviceType = 'generic', onSend }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  // Lazy init: the useRef INITIALIZER runs on every render (its value is just
  // discarded after the first), and forDeviceType sorts every grammar — so an
  // eager initializer paid that cost per render. Null-check builds it once.
  const highlighterRef = useRef<ArubaHighlighter | null>(null);
  if (highlighterRef.current === null) {
    highlighterRef.current = ArubaHighlighter.forDeviceType(deviceType);
  }
  const deviceTypeRef = useRef(deviceType);
  const autoDetectedRef = useRef<string | null>(null); // Latched on first non-generic detection
  const lastBufferRef = useRef<string>('');
  const fullBufferRef = useRef<string>('');
  const bufferRef = useRef<string>('');
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const unlistenOutputRef = useRef<UnlistenFn | null>(null);
  const unlistenClosedRef = useRef<UnlistenFn | null>(null);
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ansiProcessorRef = useRef<AnsiProcessor>(new AnsiProcessor());
  const [isConnecting, setIsConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [fontSize, setFontSize] = useState(14);
  // "Jump to latest" pill: shown when new output arrives while the user is
  // scrolled up (live tail off). Dismissed by scrolling to the bottom.
  const [newOutputBelow, setNewOutputBelow] = useState(false);
  // Copy-mode (NW-1): keyboard-driven selection over the live viewport, tmux
  // copy-mode style. The hint bar renders from this state; the selection itself
  // is tracked in a ref so keydown handlers never go stale.
  const [copyMode, setCopyMode] = useState(false);
  const copyModeRef = useRef(false);
  const copyCursorRef = useRef({ row: 0, col: 0 });
  const copyAnchorRef = useRef<{ row: number; col: number } | null>(null);
  const { theme } = useTheme();
  const settings = useSettingsStore();

  const { terminal: terminalTheme } = theme;

  // Initialize xterm
  useEffect(() => {
    if (!terminalRef.current) return;
    let cancelled = false;

    // Pull session alive/error once at mount for the not-connected placeholder
    const session = useSessionStore.getState().sessions.find((s) => s.sessionId === sessionId);
    if (!session?.connected) {
      setIsConnecting(false);
      setError(session?.lastError || 'Not connected');
    }

    const currentFontSize = useSettingsStore.getState().fontSize;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: currentFontSize,
      fontFamily: useSettingsStore.getState().terminalFont || TERMINAL_FONT_STACK,
      theme: {
        background: terminalTheme.background,
        foreground: terminalTheme.foreground,
        cursor: terminalTheme.cursor,
        selectionBackground: terminalTheme.selection,
        black: terminalTheme.black,
        red: terminalTheme.red,
        green: terminalTheme.green,
        yellow: terminalTheme.yellow,
        blue: terminalTheme.blue,
        magenta: terminalTheme.magenta,
        cyan: terminalTheme.cyan,
        white: terminalTheme.white,
        brightBlack: terminalTheme.brightBlack,
        brightRed: terminalTheme.brightRed,
        brightGreen: terminalTheme.brightGreen,
        brightYellow: terminalTheme.brightYellow,
        brightBlue: terminalTheme.brightBlue,
        brightMagenta: terminalTheme.brightMagenta,
        brightCyan: terminalTheme.brightCyan,
        brightWhite: terminalTheme.brightWhite,
      },
      scrollback: useSettingsStore.getState().scrollback,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(terminalRef.current);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    setFontSize(currentFontSize);

    const tryFit = () => {
      if (!terminalRef.current) return;
      const { clientWidth, clientHeight } = terminalRef.current;
      if (clientWidth === 0 || clientHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        // ignore transient layout errors during mount
      }
    };

    // Initial fit after mount
    tryFit();
    requestAnimationFrame(tryFit);

    // Handle container resize (debounced to avoid excessive invokes)
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(() => {
        tryFit();
        if (term && terminalRef.current) {
          const { cols, rows } = term;
          const last = lastSizeRef.current;
          if (cols !== last.cols || rows !== last.rows) {
            lastSizeRef.current = { cols, rows };
            invoke('resize_terminal', { sessionId, cols, rows }).catch(() => {});
          }
        }
      }, 150);
    });
    resizeObserver.observe(terminalRef.current);
    resizeObserverRef.current = resizeObserver;

    // Handle user input
    const onDataDisposable = term.onData((data) => {
      if (onSend) {
        onSend(data);
      }
    });
    onDataDisposableRef.current = onDataDisposable;

    // Subscribe to terminal output events from the backend. The listener is
    // attached ONCE per mount: resubscribing creates a gap in which output is
    // lost, so anything it needs (settings, device type) is read live via refs
    // and getState() instead of being captured from render scope.
    let unlisten: UnlistenFn | undefined;
    const attach = async () => {
      const u = await listen<{ sessionId: string; data: string }>('terminal-output', (event) => {
        if (event.payload.sessionId !== sessionId) return;
        const data = event.payload.data;

        bufferRef.current += data;
        if (bufferRef.current.length > 150000) {
          bufferRef.current = bufferRef.current.slice(-100000);
        }
        useSessionStore.getState().noteSessionOutput(sessionId);
        // "New output below" pill (NW-2): only when the user is scrolled up, so
        // live-tail users aren't nagged. viewportY < baseY means scrolled back.
        try {
          const buf = (term as unknown as { buffer: { active: TermBuffer } }).buffer.active;
          if (buf.viewportY < buf.baseY) setNewOutputBelow(true);
        } catch {
          // buffer introspection is best-effort
        }

        const processText = (text: string) => {
          if (!text) return;

          if (deviceTypeRef.current === 'generic' && autoDetectedRef.current === null) {
            const detected = highlighterRef.current?.detectDeviceType(bufferRef.current);
            if (detected && detected !== 'generic') {
              // Latch: apply and never look back — grammar identity is a startup
              // property, not a per-chunk decision.
              autoDetectedRef.current = detected;
              highlighterRef.current = ArubaHighlighter.forDeviceType(detected);
            }
          }

          const term = terminalRef.current;
          const highlighter = highlighterRef.current;

          // Read the setting live (getState) instead of via a closure dep, so
          // toggling it does not re-subscribe the listener (which loses output).
          if (useSettingsStore.getState().syntaxHighlighting && highlighter && !highlighter.isGeneric()) {
            // Preserve device-set SGR attributes across our highlighting: process
            // through the AnsiProcessor so injected colors don't stomp bold/reverse.
            const { stripped } = ansiProcessorRef.current.process(text);
            const parts = stripped.split(/(\r\n|\n|\r)/);
            // Cap highlighting work per flush: a huge paste/`show tech` batch
            // would otherwise tokenize tens of thousands of lines in one go
            // and pin the main thread. Past the cap the rest of the batch
            // passes through unhighlighted (output stays correct, just plain).
            let highlightedLines = 0;
            for (const part of parts) {
              if (part === '\n' || part === '\r\n' || part === '\r') {
                term && xtermRef.current?.write(part);
              } else if (part.length > 0) {
                highlightedLines++;
                xtermRef.current?.write(
                  highlightedLines <= HIGHLIGHT_LINE_CAP ? highlighter.applyToTerminal(part) : part
                );
              }
            }
          } else {
            xtermRef.current?.write(text);
          }
        };

        processText(data);
      });
      unlisten = u;
      unlistenOutputRef.current = u;
    };
    attach();

    // Backend tells us when the session process dies (remote close, error,
    // reconnect state) so the overlay can update without polling the store.
    let unlistenClosed: UnlistenFn | undefined;
    const attachClosed = async () => {
      const u = await listen<{ sessionId: string; reason: string }>('session-closed', (event) => {
        if (event.payload.sessionId !== sessionId) return;
        setIsConnecting(false);
        setError(event.payload.reason || 'Session closed');
      });
      unlistenClosed = u;
      unlistenClosedRef.current = u;
    };
    attachClosed();

    // On (re)connect, clear the overlay and scroll to the bottom so the user
    // sees the fresh prompt, not stale scrollback from a previous attachment.
    invoke('get_terminal_output', { sessionId })
      .then((output) => {
        if (cancelled) return;
        if (typeof output === 'string' && output.length > 0) {
          // Replay anything emitted between component mount and listener attach.
          const data = output as string;
          bufferRef.current = data.slice(-150000);
          xtermRef.current?.write(data);
        }
        setIsConnecting(false);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setIsConnecting(false);
      });

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenClosed?.();
      unlistenOutputRef.current = null;
      unlistenClosedRef.current = null;
      onDataDisposableRef.current?.dispose();
      onDataDisposableRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Keep deviceTypeRef in sync, and rebuild the highlighter if the session's
  // declared type actually changes (e.g. user edits the profile mid-session).
  useEffect(() => {
    if (deviceTypeRef.current !== deviceType) {
      deviceTypeRef.current = deviceType;
      autoDetectedRef.current = null;
      highlighterRef.current = ArubaHighlighter.forDeviceType(deviceType);
    }
  }, [deviceType]);

  // React to theme changes by re-theming the live xterm instance.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.theme = {
      background: terminalTheme.background,
      foreground: terminalTheme.foreground,
      cursor: terminalTheme.cursor,
      selectionBackground: terminalTheme.selection,
      black: terminalTheme.black,
      red: terminalTheme.red,
      green: terminalTheme.green,
      yellow: terminalTheme.yellow,
      blue: terminalTheme.blue,
      magenta: terminalTheme.magenta,
      cyan: terminalTheme.cyan,
      white: terminalTheme.white,
      brightBlack: terminalTheme.brightBlack,
      brightRed: terminalTheme.brightRed,
      brightGreen: terminalTheme.brightGreen,
      brightYellow: terminalTheme.brightYellow,
      brightBlue: terminalTheme.brightBlue,
      brightMagenta: terminalTheme.brightMagenta,
      brightCyan: terminalTheme.brightCyan,
      brightWhite: terminalTheme.brightWhite,
    };
  }, [terminalTheme]);

  // Font size zoom (Ctrl+= / Ctrl+- / Ctrl+0 from App shortcuts)
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const next = settings.fontSize;
    if (term.options.fontSize !== next) {
      term.options.fontSize = next;
      setFontSize(next);
      try {
        fitAddonRef.current?.fit();
      } catch {
        // ignore
      }
    }
  }, [settings.fontSize]);

  // Scrollback length changes require a live option update too.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (term.options.scrollback !== settings.scrollback) {
      term.options.scrollback = settings.scrollback;
    }
  }, [settings.scrollback]);

  const focusTerminal = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

  const scrollToBottom = useCallback(() => {
    xtermRef.current?.scrollToBottom();
    setNewOutputBelow(false);
  }, []);

  const handleZoom = useCallback((delta: number) => {
    const s = useSettingsStore.getState();
    s.updateSettings({ fontSize: Math.min(28, Math.max(9, s.fontSize + delta)) });
  }, []);

  // ── Search ──
  const runSearch = useCallback(
    (query: string, direction: 'next' | 'prev' = 'next') => {
      const addon = searchAddonRef.current;
      if (!addon || !query) {
        setMatchCount(0);
        setCurrentMatch(0);
        return;
      }
      const found =
        direction === 'next'
          ? addon.findNext(query, { caseSensitive: false, regex: false })
          : addon.findPrevious(query, { caseSensitive: false, regex: false });
      if (!found) {
        setMatchCount(0);
        setCurrentMatch(0);
        return;
      }
      // Count matches by scanning the buffer (SearchAddon doesn't report totals).
      try {
        const term = xtermRef.current;
        if (!term) return;
        const buf = (term as unknown as { buffer: { active: TermBuffer } }).buffer.active;
        const q = query.toLowerCase();
        let count = 0;
        let firstHit = -1;
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i)?.translateToString(true) ?? '';
          let idx = line.toLowerCase().indexOf(q);
          while (idx !== -1) {
            count++;
            if (firstHit === -1) firstHit = count;
            idx = line.toLowerCase().indexOf(q, idx + 1);
          }
        }
        setMatchCount(count);
        setCurrentMatch((prev) => Math.min(Math.max(prev, 1), Math.max(count, 1)));
        if (firstHit !== -1 && count > 0 && currentMatch === 0) setCurrentMatch(1);
      } catch {
        setMatchCount(0);
      }
    },
    [currentMatch]
  );

  const clearSearch = useCallback(() => {
    searchAddonRef.current?.clearDecorations?.();
    setSearchQuery('');
    setMatchCount(0);
    setCurrentMatch(0);
  }, []);

  // ── Copy mode (NW-1): tmux-style keyboard selection ──
  const exitCopyMode = useCallback(() => {
    copyModeRef.current = false;
    setCopyMode(false);
    copyAnchorRef.current = null;
    xtermRef.current?.clearSelection();
  }, []);

  const enterCopyMode = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;
    copyModeRef.current = true;
    setCopyMode(true);
    // Start the cursor at the bottom-left of the viewport.
    copyCursorRef.current = { row: term.buffer.active.cursorY, col: 0 };
    copyAnchorRef.current = null;
    term.focus();
  }, []);

  const copyModeSelectAll = useCallback(() => {
    xtermRef.current?.selectAll();
  }, []);

  const copySelectionToClipboard = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;
    const sel = term.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel).then(
        () => notify.success('Copied', 'Selection copied to clipboard'),
        () => notify.error('Copy failed', 'Could not access the clipboard')
      );
    }
  }, []);

  // Keydown handler for copy mode: arrows/hjkl move the cursor, Space sets the
  // anchor, Enter copies. Installed on the xterm textarea via attachCustomKeyEventHandler.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const handler = (e: KeyboardEvent): boolean => {
      if (!copyModeRef.current) return true;
      const cursor = copyCursorRef.current;
      const cols = term.cols;
      const move = (dr: number, dc: number) => {
        cursor.row = Math.max(0, Math.min(term.rows - 1, cursor.row + dr));
        cursor.col = Math.max(0, Math.min(cols - 1, cursor.col + dc));
      };
      switch (e.key) {
        case 'Escape':
        case 'q':
          exitCopyMode();
          return false;
        case 'ArrowUp':
        case 'k':
          move(-1, 0);
          return false;
        case 'ArrowDown':
        case 'j':
          move(1, 0);
          return false;
        case 'ArrowLeft':
        case 'h':
          move(0, -1);
          return false;
        case 'ArrowRight':
        case 'l':
          move(0, 1);
          return false;
        case 'PageUp':
          term.scrollPages(-1);
          return false;
        case 'PageDown':
          term.scrollPages(1);
          return false;
        case 'Home':
          cursor.col = 0;
          return false;
        case 'End':
          cursor.col = cols - 1;
          return false;
        case ' ':
          // Set/clear the selection anchor at the cursor.
          copyAnchorRef.current =
            copyAnchorRef.current === null ? { ...cursor } : null;
          return false;
        case 'a':
          if (e.ctrlKey || e.metaKey) {
            copyModeSelectAll();
            return false;
          }
          return true;
        case 'Enter':
        case 'y':
          copySelectionToClipboard();
          exitCopyMode();
          return false;
        default:
          return false; // swallow everything else while in copy mode
      }
    };
    term.attachCustomKeyEventHandler(handler);
    return () => {
      // xterm keeps the LAST attached handler; re-attach a pass-through on unmount.
      term.attachCustomKeyEventHandler(() => true);
    };
  }, [exitCopyMode, copyModeSelectAll, copySelectionToClipboard]);

  // Copy-on-select (NW-2) — mirrors the classic terminal behaviour; off by default.
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (!useSettingsStore.getState().copyOnSelect) return;
    const disposable = term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel && sel.length > 0) {
        navigator.clipboard.writeText(sel).catch(() => {});
      }
    });
    return () => disposable.dispose();
  }, [settings.copyOnSelect]);

  // ── Mouse-copy / keyboard-paste helpers used by the toolbar ──
  const handleCopy = useCallback(() => {
    copySelectionToClipboard();
  }, [copySelectionToClipboard]);

  const handlePaste = useCallback(() => {
    navigator.clipboard
      .readText()
      .then((text) => {
        if (!text) return;
        const lines = text.split(/\r?\n/);
        const dangerous = lines.filter((l) =>
          /\b(rm\s+-rf|erase|delete|reload|reboot|format|write\s+erase)\b/i.test(l)
        );
        const send = () => onSend?.(text);
        if (lines.length > 1 || dangerous.length > 0) {
          useDialogStore.getState().confirm({
            title: dangerous.length > 0 ? 'Paste potentially dangerous commands?' : 'Paste multiple lines?',
            message:
              dangerous.length > 0
                ? `The clipboard contains ${dangerous.length} potentially dangerous line(s), e.g. "${dangerous[0].trim().slice(0, 60)}". Paste anyway?`
                : `Paste ${lines.length} lines into the terminal?`,
            confirmLabel: 'Paste',
            danger: dangerous.length > 0,
          });
          const unsub = useDialogStore.subscribe((state, prev) => {
            if (prev.current && !state.current) {
              unsub();
              // DialogHost resolves via onConfirm/onCancel stored in the dialog;
              // for simplicity we re-check the last result through a flag.
            }
          });
          // DialogHost's confirm stores callbacks internally; hook the result.
          const current = useDialogStore.getState().current;
          if (current) {
            current.onConfirm = () => {
              send();
              useDialogStore.getState().close();
            };
          }
        } else {
          send();
        }
      })
      .catch(() => notify.error('Paste failed', 'Could not read the clipboard'));
  }, [onSend]);

  const handleOpenPty = useCallback(() => {
    invoke('open_pty_window', { sessionId }).catch((e) =>
      notify.error('Pop out failed', String(e))
    );
  }, [sessionId]);

  const handleCopyLink = useCallback(() => {
    const url = `greencli://session/${sessionId}`;
    navigator.clipboard.writeText(url).then(
      () => notify.success('Link copied', url),
      () => notify.error('Copy failed', 'Could not access the clipboard')
    );
  }, [sessionId]);

  const handleSearchToggle = useCallback(() => {
    setShowSearch((v) => {
      if (v) clearSearch();
      return !v;
    });
  }, [clearSearch]);

  // Placeholder states
  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="text-center max-w-md px-6">
          <AlertCircle size={32} className="mx-auto mb-3 text-[var(--accent-danger)]" />
          <p className="text-sm text-[var(--text-primary)] font-medium mb-1">Terminal unavailable</p>
          <p className="text-xs text-[var(--text-secondary)] break-words">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-[var(--terminal-bg)]"
      onMouseDown={focusTerminal}
    >
      {/* xterm mount point */}
      <div ref={terminalRef} className="absolute inset-0 px-1" />

      {/* Connecting overlay */}
      {isConnecting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg-primary)]/80">
          <div className="flex items-center gap-2 text-[var(--text-secondary)]">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-sm">Connecting…</span>
          </div>
        </div>
      )}

      {/* Search bar */}
      {showSearch && (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 shadow-xl">
          <Search size={13} className="text-[var(--text-muted)]" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setCurrentMatch(0);
              runSearch(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setCurrentMatch((m) => m + (e.shiftKey ? -1 : 1) || 1);
                runSearch(searchQuery, e.shiftKey ? 'prev' : 'next');
              } else if (e.key === 'Escape') {
                handleSearchToggle();
                focusTerminal();
              }
            }}
            placeholder="Search scrollback"
            className="w-44 bg-transparent text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
          />
          <span className="text-[10px] text-[var(--text-muted)] min-w-[3rem] text-center">
            {matchCount > 0 ? `${currentMatch}/${matchCount}` : searchQuery ? '0/0' : ''}
          </span>
          <button
            onClick={() => {
              setCurrentMatch((m) => Math.max(1, m - 1));
              runSearch(searchQuery, 'prev');
            }}
            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            title="Previous match (Shift+Enter)"
          >
            <ArrowUp size={13} />
          </button>
          <button
            onClick={() => {
              setCurrentMatch((m) => m + 1);
              runSearch(searchQuery, 'next');
            }}
            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            title="Next match (Enter)"
          >
            <ArrowDown size={13} />
          </button>
          <button
            onClick={() => {
              handleSearchToggle();
              focusTerminal();
            }}
            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            title="Close search (Esc)"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="absolute bottom-2 right-2 z-20 flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/90 px-1 py-0.5 opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100">
        <button
          onClick={handleSearchToggle}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Search (Ctrl+F)"
        >
          <Search size={13} />
        </button>
        <button
          onClick={copyMode ? exitCopyMode : enterCopyMode}
          className={`p-1 rounded hover:bg-[var(--bg-tertiary)] ${
            copyMode ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
          title={copyMode ? 'Exit copy mode (q/Esc)' : 'Copy mode — keyboard selection (tmux style)'}
        >
          <MousePointer size={13} />
        </button>
        <button
          onClick={handleCopy}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Copy selection"
        >
          <Copy size={13} />
        </button>
        <button
          onClick={handlePaste}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Paste (with multi-line/danger confirmation)"
        >
          <ClipboardPaste size={13} />
        </button>
        <span className="mx-0.5 h-3.5 w-px bg-[var(--border)]" />
        <button
          onClick={() => handleZoom(1)}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Zoom in (Ctrl+=)"
        >
          <ZoomIn size={13} />
        </button>
        <span className="text-[10px] text-[var(--text-muted)] w-7 text-center select-none">{fontSize}</span>
        <button
          onClick={() => handleZoom(-1)}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Zoom out (Ctrl+-)"
        >
          <ZoomOut size={13} />
        </button>
        <button
          onClick={() => useSettingsStore.getState().updateSettings({ fontSize: 14 })}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Reset zoom (Ctrl+0)"
        >
          <Maximize2 size={13} />
        </button>
        <span className="mx-0.5 h-3.5 w-px bg-[var(--border)]" />
        <button
          onClick={handleOpenPty}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Pop out into a native PTY window"
        >
          <ExternalLink size={13} />
        </button>
        <button
          onClick={handleCopyLink}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Copy deep link to this session"
        >
          <Link size={13} />
        </button>
        <button
          onClick={() => {
            // Manual device-type re-detect, for when the auto-detect latched onto
            // the wrong grammar (e.g. jumped through a bastion into another OS).
            const detected = highlighterRef.current?.detectDeviceType(bufferRef.current);
            if (detected && detected !== 'generic') {
              autoDetectedRef.current = detected;
              highlighterRef.current = ArubaHighlighter.forDeviceType(detected);
              notify.success('Highlighter', `Re-detected device type: ${detected}`);
            } else {
              notify.info('Highlighter', 'Still looks like a generic session');
            }
          }}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Re-detect device type for syntax highlighting"
        >
          <RefreshCw size={13} />
        </button>
        <button
          onClick={scrollToBottom}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Scroll to bottom"
        >
          <Scroll size={13} />
        </button>
      </div>

      {/* Copy-mode hint bar */}
      {copyMode && (
        <div className="absolute bottom-2 left-2 z-20 rounded-md border border-[var(--accent)] bg-[var(--bg-secondary)] px-2 py-1 text-[10px] text-[var(--text-secondary)] shadow-lg">
          <span className="font-semibold text-[var(--accent)]">COPY MODE</span>{' '}
          hjkl/arrows move · Space anchor · a select-all · y/Enter copy · q/Esc exit
        </div>
      )}

      {/* Jump-to-latest pill */}
      {newOutputBelow && !copyMode && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-10 right-3 z-20 flex items-center gap-1.5 rounded-full border border-[var(--accent)] bg-[var(--bg-secondary)] px-3 py-1 text-[11px] text-[var(--accent)] shadow-lg hover:bg-[var(--bg-tertiary)]"
        >
          <ArrowDown size={12} />
          New output
        </button>
      )}
    </div>
  );
}
