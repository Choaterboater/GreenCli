import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import type { ILink } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon } from 'xterm-addon-search';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/tauri';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { useTriggersStore } from '../store/triggersStore';
import { notify } from '../store/toastStore';
import { askConfirm } from '../store/dialogStore';
import { useTheme } from '../hooks/useTheme';
import { DeviceType } from '../types';
import { ArubaHighlighter, AnsiProcessor } from '../syntax';
import { registerSearchAdapter, unregisterSearchAdapter, createSearchAdapter } from '../utils/terminalSearch';
import { registerTerminalActionAdapter, unregisterTerminalActionAdapter } from '../utils/terminalActions';
import { countPasteLines, useTerminalToolsStore } from '../store/terminalToolsStore';
import 'xterm/css/xterm.css';

interface TerminalProps {
  sessionId: string;
  deviceType: DeviceType;
  onData?: (data: string) => void;
  onSend?: (data: string) => void;
  /** Pop-out windows: replay the session's captured output tail so the new
   *  window isn't blank. Fetched AFTER the data listener attaches (live chunks
   *  queue behind the replay) so output during window startup isn't lost. */
  seedFromBuffer?: boolean;
}

const SEMANTIC_LINK_PATTERNS: Array<{ kind: string; regex: RegExp; capture?: number }> = [
  {
    kind: 'IP',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  {
    kind: 'MAC',
    regex: /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi,
  },
  {
    kind: 'Path',
    regex: /(^|[\s"'(])((?:~\/|\.\.?\/|\/)[^\s"'<>]+)/g,
    capture: 2,
  },
  {
    kind: 'Interface',
    regex: /\b(?:ge|xe|et|em|fxp|irb|lo|reth|vlan|lag|ae|mgmt|eth|ens|eno|bond|port-channel|ethernet|fastethernet|gigabitethernet|tengigabitethernet|1\/\d+)(?:[-\w./:]*\d)?\b/gi,
  },
];

function sessionLabel(sessionId: string): string {
  const session = useSessionStore.getState().sessions.find((s) => s.sessionId === sessionId);
  return session?.config.name || session?.config.host || session?.config.serialPort || 'Session';
}

function semanticLinksForLine(term: XTerm, bufferLineNumber: number): ILink[] | undefined {
  if (!useSettingsStore.getState().smartTerminalLinks) return undefined;
  const line = term.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true);
  if (!line) return undefined;

  const links: ILink[] = [];
  const occupied: Array<[number, number]> = [];
  const overlaps = (start: number, end: number) =>
    occupied.some(([usedStart, usedEnd]) => start < usedEnd && end > usedStart);

  for (const { kind, regex, capture } of SEMANTIC_LINK_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line))) {
      const text = match[capture ?? 0];
      if (!text) continue;
      const startIndex = match.index + (capture ? match[0].indexOf(text) : 0);
      const endIndex = startIndex + text.length;
      if (overlaps(startIndex, endIndex)) continue;
      occupied.push([startIndex, endIndex]);
      links.push({
        text,
        range: {
          start: { x: startIndex + 1, y: bufferLineNumber },
          // IBufferRange.end is 1-based INCLUSIVE — the 0-based exclusive
          // endIndex is already the 1-based index of the last character.
          end: { x: endIndex, y: bufferLineNumber },
        },
        decorations: { pointerCursor: true, underline: true },
        activate: () => {
          navigator.clipboard
            .writeText(text)
            .then(() => notify.info(`Copied ${kind}`, text))
            .catch(() => notify.warning('Copy failed', text));
        },
      });
    }
  }

  return links.length ? links : undefined;
}

export default function Terminal({ sessionId, deviceType, onSend, seedFromBuffer }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const highlighterRef = useRef<ArubaHighlighter>(
    ArubaHighlighter.forDeviceType(deviceType)
  );
  // Mirror the deviceType prop into a ref so the data listener can read it
  // without being torn down and re-subscribed (which drops in-flight output).
  const deviceTypeRef = useRef(deviceType);
  const ansiProcessorRef = useRef<AnsiProcessor>(new AnsiProcessor());
  const bufferRef = useRef<string>('');
  // Persistent streaming decoder so multibyte UTF-8 split across chunks is not
  // corrupted (a fresh per-event decoder mangles split code points).
  const decoderRef = useRef<TextDecoder>(new TextDecoder('utf-8', { fatal: false }));
  // One long-lived AudioContext, reused for every bell (don't leak one per BEL).
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Debounce per-trigger alerts (id -> last-fired ms).
  const triggerFiredRef = useRef<Record<string, number>>({});
  const onSendRef = useRef(onSend);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outputSinceLastInputRef = useRef(true);
  const lastBackgroundActivityNotifyRef = useRef(0);
  // Tail of the previous decoded chunk, prepended to the next so an output trigger
  // whose match straddles a chunk boundary is still detected.
  const triggerCarryRef = useRef<string>('');
  // Trailing incomplete escape sequence held back from the previous flush batch
  // and prepended to the next, so the raw-vs-highlight check doesn't mistake a
  // split sequence (e.g. '\x1b[3' + '8;5;196m') for highlightable text.
  const ansiCarryRef = useRef<string>('');
  // Keyboard text selection (Shift+Arrow / Home / End): anchor + moving focus as
  // absolute cell indices into the buffer (row * cols + col). Null when no
  // keyboard selection is in progress.
  const selAnchorRef = useRef<number | null>(null);
  const selFocusRef = useRef<number | null>(null);

  // Short audible blip, reusing the shared AudioContext.
  const beep = () => {
    try {
      if (!audioCtxRef.current) {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new Ctx();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    } catch {
      /* audio unavailable */
    }
  };


  const { terminalTheme, isDark } = useTheme();
  const settings = useSettingsStore();
  const updateSessionConnection = useSessionStore((s) => s.updateSessionConnection);

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  // Update highlighter when device type changes
  useEffect(() => {
    deviceTypeRef.current = deviceType;
    highlighterRef.current = ArubaHighlighter.forDeviceType(deviceType);
  }, [deviceType]);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const term = new XTerm({
      theme: terminalTheme,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      allowProposedApi: true,
      allowTransparency: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      screenReaderMode: false,
      convertEol: false,
      overviewRulerWidth: 15,
      wordSeparator: ' ()[]{}\'"`',
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const linksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(linksAddon);
    const semanticLinkProvider = term.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) =>
        callback(semanticLinksForLine(term, bufferLineNumber)),
    });

    searchAddonRef.current = searchAddon;
    registerSearchAdapter(sessionId, createSearchAdapter(searchAddon));

    term.open(containerRef.current);

    // NOTE: the WebGL renderer (xterm-addon-webgl) is intentionally NOT loaded.
    // On WKWebView it hard-crashes the GPU/content process under heavy terminal
    // load, or when a terminal is disposed mid-render (e.g. switching away from a
    // busy claude/kimi TUI to open another shell) — a hard crash the onContextLoss
    // fallback can't catch. xterm's default renderer is stable and, combined with
    // the output coalescing here + in the backend forwarder, fast enough.

    // Propagate EVERY cols/rows change to the backend PTY, no matter what
    // triggered the fit() — font-size zoom (pinch / Ctrl+wheel / shortcuts)
    // refits via the settings effect below, which never goes through
    // handleResize. Without this the device CLI wraps at the stale column
    // count and TUIs render garbled after zooming.
    term.onResize(({ cols, rows }) => {
      invoke('resize_terminal', { sessionId, cols, rows }).catch(() => {});
    });

    fitAddon.fit();

    const recordPaste = (text: string) => {
      if (!useSettingsStore.getState().pasteHistoryEnabled) return;
      useTerminalToolsStore.getState().addPaste({
        sessionId,
        sessionName: sessionLabel(sessionId),
        text,
        lineCount: countPasteLines(text),
      });
    };

    registerTerminalActionAdapter(sessionId, {
      paste: (text) => {
        if (!text) return;
        recordPaste(text);
        term.focus();
        term.paste(text);
      },
      copySelection: () => {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
        }
        return selection;
      },
      focus: () => term.focus(),
    });

    const clearSilenceTimer = () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    };

    const armSilenceTimer = () => {
      const currentSettings = useSettingsStore.getState();
      if (!currentSettings.terminalSilenceNotifications) return;
      clearSilenceTimer();
      outputSinceLastInputRef.current = false;
      silenceTimerRef.current = setTimeout(() => {
        if (!outputSinceLastInputRef.current) {
          notify.info(
            'Terminal is quiet',
            `${sessionLabel(sessionId)} has had no output for ${currentSettings.terminalSilenceThresholdSeconds}s after input.`
          );
        }
        silenceTimerRef.current = null;
      }, currentSettings.terminalSilenceThresholdSeconds * 1000);
    };

    // Paste guard (iTerm2-style): blasting a multi-line clipboard at a live
    // device is how configs land on the wrong box. Intercept the DOM paste on
    // xterm's textarea and confirm first; term.paste() then takes the normal
    // path (LF→CR conversion + bracketed paste for TUIs that requested it).
    const pasteGuard = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text) return;
      const currentSettings = useSettingsStore.getState();
      const lineCount = countPasteLines(text);
      if (!currentSettings.pasteGuardEnabled || lineCount < currentSettings.pasteGuardLineThreshold) {
        recordPaste(text);
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      askConfirm({
        title: `Paste ${lineCount} lines into the terminal?`,
        message:
          'Multi-line pastes run each line as a command on the connected device.',
        confirmLabel: 'Paste',
      }).then((ok) => {
        if (ok) {
          recordPaste(text);
          terminalRef.current?.paste(text);
        }
      });
    };
    term.textarea?.addEventListener('paste', pasteGuard, true);

    // Handle input
    term.onData((data) => {
      if (data.includes('\r') || data.includes('\n')) armSilenceTimer();
      onSendRef.current?.(data);
    });

    // Audible bell — gated on the live setting (xterm has no bell option, so we
    // play a short WebAudio blip on the BEL control char when enabled).
    term.onBell(() => {
      if (useSettingsStore.getState().bell) beep();
    });

    // ── Keyboard text selection ──────────────────────────────────────────
    // xterm only selects with the mouse out of the box. Wire Shift+Arrow /
    // Home / End to extend a selection (and Ctrl/Cmd+C to copy it) so the
    // keyboard behaves like a normal editor. Scoped to the *normal* screen
    // buffer so full-screen TUIs (claude/kimi/vim/htop) in the alternate
    // buffer still receive their own keys untouched.
    const NAV = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (term.buffer.active.type === 'alternate') return true;

      // Copy: Cmd+C (macOS) / Ctrl+C (Win/Linux) copies the selection when one
      // exists; with no selection it falls through so Ctrl+C still sends SIGINT.
      if (
        (event.key === 'c' || event.key === 'C') &&
        (event.metaKey || (event.ctrlKey && !event.altKey)) &&
        term.hasSelection()
      ) {
        const sel = term.getSelection();
        if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
        return false;
      }

      // Shift + navigation extends the keyboard selection.
      if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && NAV.has(event.key)) {
        const buf = term.buffer.active;
        const cols = term.cols;
        const total = buf.length * cols; // exclusive upper bound (one past last cell)
        if (selAnchorRef.current == null || selFocusRef.current == null) {
          const cur = (buf.baseY + buf.cursorY) * cols + buf.cursorX;
          selAnchorRef.current = cur;
          selFocusRef.current = cur;
        }
        let f = selFocusRef.current;
        switch (event.key) {
          case 'ArrowLeft': f = Math.max(0, f - 1); break;
          case 'ArrowRight': f = Math.min(total, f + 1); break;
          case 'ArrowUp': f = Math.max(0, f - cols); break;
          case 'ArrowDown': f = Math.min(total, f + cols); break;
          case 'Home': f = Math.floor(f / cols) * cols; break;
          case 'End': f = Math.floor(f / cols) * cols + cols; break;
        }
        selFocusRef.current = f;
        const start = Math.min(selAnchorRef.current, f);
        const end = Math.max(selAnchorRef.current, f);
        if (end - start <= 0) {
          term.clearSelection();
        } else {
          term.select(start % cols, Math.floor(start / cols), end - start);
        }
        // Keep the moving end of the selection on screen.
        const focusRow = Math.min(buf.length - 1, Math.floor(f / cols));
        if (focusRow < buf.baseY) term.scrollToLine(focusRow);
        else if (focusRow > buf.baseY + term.rows - 1) term.scrollToLine(focusRow - term.rows + 1);
        return false;
      }

      // Escape clears an active keyboard selection.
      if (event.key === 'Escape' && selAnchorRef.current != null) {
        term.clearSelection();
        selAnchorRef.current = null;
        selFocusRef.current = null;
        return false;
      }

      // Plain typing / unshifted navigation ends a keyboard selection: drop the
      // anchor (so the next Shift+Arrow restarts at the cursor) and clear the
      // highlight, like a normal editor. Pure modifiers don't reset it.
      if (
        selAnchorRef.current != null &&
        !event.ctrlKey && !event.metaKey && !event.altKey &&
        !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)
      ) {
        selAnchorRef.current = null;
        selFocusRef.current = null;
        term.clearSelection();
      }
      return true;
    });

    // A mouse press starts xterm's own (native) selection — forget our keyboard
    // anchor so the next Shift+Arrow begins from the fresh cursor position.
    const resetKbSelection = () => {
      selAnchorRef.current = null;
      selFocusRef.current = null;
    };
    containerRef.current.addEventListener('mousedown', resetKbSelection);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle resize
    const handleResize = () => {
      // Skip when the terminal is hidden (a background tab) — fitting a 0-size
      // container would corrupt cols/rows. The ResizeObserver re-fires (0→size)
      // when it becomes visible again.
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      // Column count may change — absolute cell indices from a keyboard selection
      // would no longer line up, so drop the anchor (next Shift+Arrow restarts).
      selAnchorRef.current = null;
      selFocusRef.current = null;
      fitAddon.fit();
      const { cols, rows } = term;
      // Notify backend of resize. term.onResize above already fires when fit()
      // *changes* the dimensions; this unconditional invoke additionally syncs
      // the PTY when fit() lands on the size xterm already had (e.g. the
      // initial fit). Repeating the same dims is harmless.
      invoke('resize_terminal', { sessionId, cols, rows }).catch(() => {});
    };

    window.addEventListener('resize', handleResize);
    // Refit when the container itself resizes (panels opening, split view, etc.)
    const ro = new ResizeObserver(() => handleResize());
    ro.observe(containerRef.current);
    const initialFit = setTimeout(handleResize, 100);

    // Pinch-to-zoom. WKWebView (Tauri on macOS) reports trackpad pinches via
    // proprietary GestureEvents (gesturestart/gesturechange) — NOT ctrl+wheel,
    // which is a Chromium convention. Handle both: gestures for the trackpad,
    // ctrl+wheel for external mice / other platforms. preventDefault also stops
    // WebKit's page-level pinch zoom. The fontSize useEffect below propagates
    // the change + refits every terminal.
    const zoomEl = containerRef.current;
    const clampFont = (n: number) => Math.max(8, Math.min(24, n));
    let pinchStartFont = 0;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      pinchStartFont = useSettingsStore.getState().fontSize;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const scale = (e as unknown as { scale?: number }).scale;
      if (!scale) return;
      const s = useSettingsStore.getState();
      const next = clampFont(Math.round(pinchStartFont * scale));
      if (next !== s.fontSize) s.setFontSize(next);
    };
    const onGestureEnd = (e: Event) => e.preventDefault();
    let lastZoomAt = 0;
    const handleWheelZoom = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const now = performance.now();
      if (e.deltaY === 0 || now - lastZoomAt < 50) return;
      lastZoomAt = now;
      const s = useSettingsStore.getState();
      const next = clampFont(s.fontSize + (e.deltaY > 0 ? -1 : 1));
      if (next !== s.fontSize) s.setFontSize(next);
    };
    zoomEl.addEventListener('gesturestart', onGestureStart);
    zoomEl.addEventListener('gesturechange', onGestureChange);
    zoomEl.addEventListener('gestureend', onGestureEnd);
    zoomEl.addEventListener('wheel', handleWheelZoom, { passive: false });

    return () => {
      clearTimeout(initialFit); // don't fit()/resize a disposed xterm after a fast unmount
      window.removeEventListener('resize', handleResize);
      zoomEl.removeEventListener('gesturestart', onGestureStart);
      zoomEl.removeEventListener('gesturechange', onGestureChange);
      zoomEl.removeEventListener('gestureend', onGestureEnd);
      zoomEl.removeEventListener('wheel', handleWheelZoom);
      zoomEl.removeEventListener('mousedown', resetKbSelection);
      term.textarea?.removeEventListener('paste', pasteGuard, true);
      semanticLinkProvider.dispose();
      unregisterTerminalActionAdapter(sessionId);
      clearSilenceTimer();
      ro.disconnect();
      unregisterSearchAdapter(sessionId);
      term.dispose();
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [sessionId]);

  // Listen for terminal data from Tauri backend
  useEffect(() => {
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    const setupListener = async () => {
      try {
        // Coalesce incoming PTY chunks and process them in ~8ms batches (or sooner
        // on a big burst). Heavy interactive TUIs (claude/kimi/copilot) emit many
        // small events; running decode + trigger regex + device-detect + highlight
        // per 4KB event pegs the main thread and can crash the WebKit renderer.
        // Batching runs that work once per window instead.
        const pending: Uint8Array[] = [];
        let pendingSize = 0;
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        // Pop-out windows gate live chunks behind the scrollback-tail replay.
        let holdFlush = seedFromBuffer === true;

        const processText = (text: string) => {
          if (!terminalRef.current) return;
          // Re-attach an escape sequence split across flush batches: hold back a
          // trailing incomplete ESC/CSI/OSC prefix and prepend it to the next
          // batch. Without this, a batch starting mid-sequence (e.g. '8;5;196m')
          // has no ESC byte, takes the highlight path, and the injected SGR
          // codes abort xterm's half-parsed sequence — the user sees raw junk.
          text = ansiCarryRef.current + text;
          ansiCarryRef.current = '';
          const incompleteEscape = text.match(/\x1b(?:[\[\]][0-9;:?]*)?$/);
          if (incompleteEscape) {
            ansiCarryRef.current = incompleteEscape[0];
            text = text.slice(0, -incompleteEscape[0].length);
            if (!text) return;
          }
          if (text.trim()) {
            outputSinceLastInputRef.current = true;
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
          }
          bufferRef.current += text;
          if (bufferRef.current.length > 5000) {
            bufferRef.current = bufferRef.current.slice(-3000);
          }

          // Output triggers: toast (+ optional beep) when a keyword/regex appears.
          const triggers = useTriggersStore.getState().triggers;
          if (triggers.length) {
            const now = Date.now();
            // Search the new chunk plus a small carry from the previous one, so a
            // pattern split across PTY chunks is still matched (the 2.5s cooldown
            // below suppresses duplicate fires from the overlap).
            const haystack = triggerCarryRef.current + text;
            for (const tr of triggers) {
              let matchText = '';
              try {
                if (tr.isRegex) {
                  // 'm' so ^/$ anchor per line, matching user expectation.
                  const m = haystack.match(new RegExp(tr.pattern, 'im'));
                  if (m) matchText = m[0];
                } else if (haystack.toLowerCase().includes(tr.pattern.toLowerCase())) {
                  matchText = tr.pattern;
                }
              } catch {
                /* bad regex — ignore */
              }
              if (matchText && now - (triggerFiredRef.current[tr.id] || 0) > 2500) {
                triggerFiredRef.current[tr.id] = now;
                notify.warning('Output trigger', `Matched "${matchText.slice(0, 60)}"`);
                if (tr.bell) beep();
              }
            }
            triggerCarryRef.current = haystack.slice(-200);
          }

          // Only auto-detect the grammar when the user left the device type as
          // 'generic'. An explicit choice is authoritative and must not be
          // flipped mid-session by transient output. Read from a ref so the
          // listener never needs to be torn down + re-subscribed on prop change.
          if (deviceTypeRef.current === 'generic') {
            const detected = highlighterRef.current.detectDeviceType(bufferRef.current);
            if (detected !== 'generic') {
              highlighterRef.current = ArubaHighlighter.forDeviceType(detected);
            }
          }

          const term = terminalRef.current;

          // Read the setting live (getState) instead of via a closure dep, so
          // toggling it does not re-subscribe the listener (which loses output).
          if (useSettingsStore.getState().syntaxHighlighting && !highlighterRef.current.isGeneric()) {
            // Detect control chars that would corrupt highlighting:
            // backspace (\x08), terminal control sequences, etc.
            // Allow: \t (0x09), \n (0x0a), \r (0x0d)
            const hasDisruptiveChars = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/.test(text);

            // Detect non-color ANSI sequences (cursor movement, erase line, etc.)
            // Strip color codes first: \x1b[...m — if ESC remains, it's a control sequence
            const withoutColorAnsi = text.replace(/\x1b\[[0-9;]*m/g, '');
            const hasNonColorEscape = withoutColorAnsi.includes('\x1b');

            if (hasDisruptiveChars || hasNonColorEscape) {
              // Write raw — preserves backspace, cursor movement, interactive echo
              term.write(text);
            } else {
              // Safe to highlight: strip device color ANSI, apply our syntax colors
              const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
              // Split preserving line endings
              const parts = stripped.split(/(\r?\n)/);
              for (const part of parts) {
                if (part === '\n' || part === '\r\n' || part === '\r') {
                  term.write(part);
                } else if (part.length > 0) {
                  term.write(highlighterRef.current.applyToTerminal(part));
                }
              }
            }
          } else {
            term.write(text);
          }
        };

        const flush = () => {
          flushTimer = null;
          // While the pop-out seed replay is in flight, queued live chunks wait
          // behind it so the scrollback stays in order.
          if (holdFlush) return;
          if (!terminalRef.current || pending.length === 0) {
            pending.length = 0;
            pendingSize = 0;
            return;
          }
          let total = 0;
          for (const c of pending) total += c.length;
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of pending) {
            merged.set(c, off);
            off += c.length;
          }
          pending.length = 0;
          pendingSize = 0;
          // Streaming decode keeps partial multibyte sequences buffered across batches.
          const text = decoderRef.current.decode(merged, { stream: true });
          if (text) processText(text);
        };

        const unlisten = await listen<{ sessionId: string; data: number[] }>(
          'terminal_data',
          (event) => {
            if (cancelled) return;
            if (event.payload.sessionId !== sessionId) return;
            // Activity dot on background tabs: flag output landing on a session
            // the user isn't looking at (cleared when its tab is activated).
            // Popped-out sessions are skipped — they live in their own window,
            // and a dot here would be unclearable (their tab is never active).
            // Sessions showing in a split pane are skipped too — the user is
            // literally watching them, even though they aren't the active tab.
            const ss = useSessionStore.getState();
            const visibleInPane = ss.splitView && ss.splitPanes.includes(sessionId);
            if (
              ss.activeSessionId !== sessionId &&
              !visibleInPane &&
              !ss.unseenOutput.includes(sessionId) &&
              !ss.poppedSessions.includes(sessionId)
            ) {
              ss.markUnseenOutput(sessionId);
              const now = Date.now();
              if (
                useSettingsStore.getState().terminalActivityNotifications &&
                now - lastBackgroundActivityNotifyRef.current > 15_000
              ) {
                lastBackgroundActivityNotifyRef.current = now;
                notify.info('Background activity', `${sessionLabel(sessionId)} produced new output.`);
              }
            }
            pending.push(new Uint8Array(event.payload.data));
            pendingSize += event.payload.data.length;
            // Flush immediately on a large burst, else batch ~8ms of chunks.
            if (pendingSize > 256 * 1024) {
              if (flushTimer != null) clearTimeout(flushTimer);
              flush();
            } else if (flushTimer == null) {
              flushTimer = setTimeout(flush, 8);
            }
          }
        );

        // If cleanup ran while `listen` was in flight (StrictMode double-mount,
        // fast tab close), it saw unlistenFn === null — drop the registration
        // here or the listener leaks forever.
        if (cancelled) {
          unlisten();
          return;
        }
        unlistenFn = () => {
          if (flushTimer != null) clearTimeout(flushTimer);
          unlisten();
        };

        // Pop-out seeding: replay the captured tail AFTER the listener is
        // attached so chunks emitted during window startup aren't lost — they
        // queue behind the replay (holdFlush) and write in order. A chunk
        // landing in the snapshot→write gap can render twice (it's in the tail
        // AND the queue); rare, cosmetic, and strictly better than dropping it.
        if (seedFromBuffer) {
          try {
            const tail = await invoke<string>('get_terminal_output', { sessionId });
            if (!cancelled && tail && terminalRef.current) {
              terminalRef.current.write(tail);
            }
          } catch {
            /* no captured tail — start blank */
          }
          if (cancelled) return; // cleanup already ran unlistenFn during the await
          holdFlush = false;
          if (pending.length > 0) flush();
        }
      } catch (err) {
        console.error('Failed to setup terminal data listener:', err);
      }
    };

    setupListener();

    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
      // Reset the streaming decoder (the terminal is already disposed by the init
      // effect's cleanup, so its held tail bytes can't be written — just clear the
      // decoder state so a remount/new session starts clean).
      try {
        decoderRef.current.decode();
      } catch {
        /* ignore */
      }
      // Drop any held-back partial escape — it belongs to the old stream.
      ansiCarryRef.current = '';
    };
  }, [sessionId, seedFromBuffer]);

  // Listen for connection status changes (connect/disconnect/reconnect) from
  // the backend and reflect them in the session store so tabs and the status
  // bar show live state instead of a permanent "Connected".
  useEffect(() => {
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    listen<{ sessionId: string; status: string; message?: string }>(
      'connection_status',
      (event) => {
        if (cancelled) return;
        if (event.payload.sessionId !== sessionId) return;
        const connected = event.payload.status === 'connected';
        const connectionStatus =
          event.payload.status === 'reconnecting'
            ? 'reconnecting'
            : connected
              ? 'connected'
              : 'disconnected';
        updateSessionConnection(sessionId, connected, connectionStatus);
        if (event.payload.status === 'connected' || event.payload.status === 'reconnecting') {
          // Fresh stream after a (re)connect — discard any partial multibyte bytes
          // the decoder held from before the drop so they can't corrupt the first
          // bytes of the new connection, and any held-back partial escape with them.
          decoderRef.current = new TextDecoder('utf-8', { fatal: false });
          ansiCarryRef.current = '';
        }
        if (event.payload.message && terminalRef.current && !connected) {
          // Surface drops/reconnect notices inline in the terminal.
          terminalRef.current.write(`\r\n\x1b[33m[${event.payload.message}]\x1b[0m\r\n`);
        }
      }
    )
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          unlistenFn = unlisten;
        }
      })
      .catch((err) => console.error('Failed to setup connection_status listener:', err));

    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, [sessionId, updateSessionConnection]);

  // Update terminal options when settings change
  useEffect(() => {
    if (!terminalRef.current) return;
    const term = terminalRef.current;

    term.options.fontSize = settings.fontSize;
    term.options.fontFamily = settings.fontFamily;
    term.options.cursorStyle = settings.cursorStyle;
    term.options.cursorBlink = settings.cursorBlink;
    term.options.scrollback = settings.scrollback;
    term.options.theme = terminalTheme;

    fitAddonRef.current?.fit();
  }, [
    settings.fontSize,
    settings.fontFamily,
    settings.cursorStyle,
    settings.cursorBlink,
    settings.scrollback,
    terminalTheme,
  ]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ background: isDark ? 'var(--bg-primary)' : '#ffffff' }}
    />
  );
}
