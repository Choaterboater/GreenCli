import { useEffect, useRef, useState } from 'react';
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
import { copyText, readClipboardText } from '../utils/clipboard';
import { registerTerminalActionAdapter, unregisterTerminalActionAdapter } from '../utils/terminalActions';
import { countPasteLines, useTerminalToolsStore } from '../store/terminalToolsStore';
import { appWindow } from '@tauri-apps/api/window';
import 'xterm/css/xterm.css';

// Pop-out windows render one session in a fresh store — the background-activity
// logic below only makes sense in the main window with its tab strip.
const isPopOutWindow = appWindow.label.startsWith('popout-');

const isMac = navigator.platform.toUpperCase().includes('MAC');
const isWindows = navigator.platform.toUpperCase().includes('WIN');

interface CtxMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

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
          copyText(text).then((ok) =>
            ok ? notify.info(`Copied ${kind}`, text) : notify.warning('Copy failed', text)
          );
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
  // Latched auto-detected vendor for a 'generic' session. Once the output
  // fingerprints a device we build that highlighter ONCE and stop re-detecting
  // (and re-sorting every grammar) on each flush — which also stops the active
  // grammar thrashing as fingerprints scroll out of the rolling bufferRef
  // window. Reset by the deviceType effect so a new/explicit choice re-detects.
  const autoDetectedRef = useRef<string | null>(null);
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
  // Compiled-regex cache for output triggers, keyed by pattern string, so a valid
  // user regex is compiled once instead of recompiled on every ~8ms flush.
  const triggerRxRef = useRef<Map<string, RegExp>>(new Map());
  // Trailing incomplete escape sequence held back from the previous flush batch
  // and prepended to the next, so the raw-vs-highlight check doesn't mistake a
  // split sequence (e.g. '\x1b[3' + '8;5;196m') for highlightable text.
  const ansiCarryRef = useRef<string>('');
  // Keyboard text selection (Shift+Arrow / Home / End): anchor + moving focus as
  // absolute cell indices into the buffer (row * cols + col). Null when no
  // keyboard selection is in progress.
  const selAnchorRef = useRef<number | null>(null);
  const selFocusRef = useRef<number | null>(null);
  // Right-click context menu (Copy / Paste / Select All / Clear); null = closed.
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  // Menu actions bound to the live xterm instance by the init effect below.
  const ctxActionsRef = useRef<{
    copy: () => void;
    paste: () => void;
    selectAll: () => void;
    clear: () => void;
  } | null>(null);

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


  const { terminalTheme } = useTheme();
  // Subscribe only to the terminal-relevant fields (read by the init + settings
  // effects below) instead of the whole settings store, so unrelated settings
  // changes (bell, syntax highlighting, AI model, device profiles, …) don't
  // re-render every mounted terminal.
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const cursorStyle = useSettingsStore((s) => s.cursorStyle);
  const cursorBlink = useSettingsStore((s) => s.cursorBlink);
  const scrollback = useSettingsStore((s) => s.scrollback);
  const rightClickBehavior = useSettingsStore((s) => s.rightClickBehavior);
  const updateSessionConnection = useSessionStore((s) => s.updateSessionConnection);

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  // Update highlighter when device type changes
  useEffect(() => {
    deviceTypeRef.current = deviceType;
    highlighterRef.current = ArubaHighlighter.forDeviceType(deviceType);
    // A fresh explicit choice (or a switch back to 'generic') re-arms auto-detect.
    autoDetectedRef.current = null;
  }, [deviceType]);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const term = new XTerm({
      theme: terminalTheme,
      fontSize,
      fontFamily,
      cursorStyle,
      cursorBlink,
      scrollback,
      allowProposedApi: true,
      allowTransparency: false,
      macOptionIsMeta: true,
      // Only in 'menu' mode: word-select-then-menu is handy (right-click a word
      // → Copy), but in paste/copyPaste modes the implicit selection would turn
      // every right-click paste into a word copy instead.
      rightClickSelectsWord: useSettingsStore.getState().rightClickBehavior === 'menu',
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

    // Copy the current selection to the OS clipboard, surfacing failure (a
    // silent .catch here is how "copy is broken" bug reports happen).
    const copySelection = (): string => {
      const selection = term.getSelection();
      if (selection) {
        copyText(selection).then((ok) => {
          if (!ok) notify.warning('Copy failed', 'Clipboard is unavailable.');
        });
      }
      return selection;
    };

    // Paste with the same multi-line confirm the DOM paste path gets, so
    // keyboard chords / context menu / right-click paste can't blast a config
    // at a device unguarded.
    const guardedPaste = (text: string) => {
      if (!text) return;
      const currentSettings = useSettingsStore.getState();
      const lineCount = countPasteLines(text);
      if (currentSettings.pasteGuardEnabled && lineCount >= currentSettings.pasteGuardLineThreshold) {
        askConfirm({
          title: `Paste ${lineCount} lines into the terminal?`,
          message: 'Multi-line pastes run each line as a command on the connected device.',
          confirmLabel: 'Paste',
        }).then((ok) => {
          if (ok) {
            recordPaste(text);
            terminalRef.current?.focus();
            terminalRef.current?.paste(text);
          }
        });
      } else {
        recordPaste(text);
        term.focus();
        term.paste(text);
      }
    };

    const pasteFromClipboard = () => {
      readClipboardText().then((text) => {
        if (text === null) {
          notify.warning('Paste failed', 'Clipboard is unavailable.');
          return;
        }
        guardedPaste(text);
      });
    };

    registerTerminalActionAdapter(sessionId, {
      paste: (text) => {
        if (!text) return;
        recordPaste(text);
        term.focus();
        term.paste(text);
      },
      copySelection,
      focus: () => term.focus(),
      clear: () => term.clear(),
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

      // ── Copy/paste chords ──────────────────────────────────────────────
      // Handled BEFORE the alternate-buffer bailout so copy/paste also works
      // inside full-screen TUIs (vim, htop, claude) — like every normal
      // terminal. Cmd+C/V never reach the PTY anyway, and the Ctrl variants
      // below only intercept when unambiguous (selection exists / Shift held).

      // Copy: Cmd+C (macOS) / Ctrl+C with a selection / Ctrl+Shift+C /
      // Ctrl+Insert. With no selection Ctrl+C falls through to SIGINT.
      if (
        term.hasSelection() &&
        (((event.key === 'c' || event.key === 'C') &&
          // On macOS copy is Cmd+C only — Ctrl+C always stays SIGINT there.
          (event.metaKey || (!isMac && event.ctrlKey && !event.altKey))) ||
          (event.key === 'Insert' && event.ctrlKey && !event.shiftKey && !event.altKey))
      ) {
        copySelection();
        // Clear the selection after copying — getSelection() already captured
        // it synchronously, so the async clipboard write is unaffected — and
        // drop the keyboard anchor. hasSelection() is now false, so the NEXT
        // Ctrl+C falls through and xterm emits \x03 (SIGINT); a lingering mouse
        // selection no longer swallows every abort.
        term.clearSelection();
        selAnchorRef.current = null;
        selFocusRef.current = null;
        return false;
      }

      // Paste: Cmd+V (macOS), Ctrl+Shift+V, Shift+Insert everywhere; plain
      // Ctrl+V only on Windows (Windows Terminal convention) — on Linux/macOS
      // Ctrl+V stays the shell's literal-next (^V). preventDefault stops the
      // webview's own textarea paste from firing a second, unguarded paste.
      if (
        ((event.key === 'v' || event.key === 'V') &&
          ((event.metaKey && isMac) ||
            (event.ctrlKey && event.shiftKey && !event.altKey) ||
            (event.ctrlKey && !event.shiftKey && !event.altKey && isWindows))) ||
        (event.key === 'Insert' && event.shiftKey && !event.ctrlKey && !event.altKey)
      ) {
        event.preventDefault();
        pasteFromClipboard();
        return false;
      }

      if (term.buffer.active.type === 'alternate') return true;

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
          case 'End': {
            // When extending forward, f is an EXCLUSIVE bound sitting on the
            // next row's first cell; computing the row from f directly made
            // every repeated Shift+End walk the selection one line further.
            // Anchor to the last actually-selected cell instead.
            const refCell = f > selAnchorRef.current ? f - 1 : f;
            f = Math.floor(refCell / cols) * cols + cols;
            break;
          }
        }
        selFocusRef.current = f;
        const start = Math.min(selAnchorRef.current, f);
        const end = Math.max(selAnchorRef.current, f);
        if (end - start <= 0) {
          term.clearSelection();
        } else {
          term.select(start % cols, Math.floor(start / cols), end - start);
        }
        // Keep the moving end of the selection on screen. viewportY is the
        // actual scroll position; baseY is the bottom-anchored page and would
        // cause wrong jumps whenever the user has scrolled up into scrollback.
        // Follow the last SELECTED cell when extending forward (f is exclusive
        // there) — following f itself overscrolled one row on Shift+End at the
        // bottom of the screen.
        const followCell = f > selAnchorRef.current ? f - 1 : f;
        const focusRow = Math.min(buf.length - 1, Math.floor(followCell / cols));
        if (focusRow < buf.viewportY) term.scrollToLine(focusRow);
        else if (focusRow > buf.viewportY + term.rows - 1) term.scrollToLine(focusRow - term.rows + 1);
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

    // ── Right-click ──────────────────────────────────────────────────────
    // The webview's native menu is suppressed app-wide (main.tsx), so the
    // terminal provides its own, like a real terminal app. Behavior is a
    // setting: 'menu' shows Copy/Paste/Select All/Clear, 'paste' pastes
    // immediately (PuTTY), 'copyPaste' copies the selection if there is one
    // and pastes otherwise (Windows Terminal).
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const behavior = useSettingsStore.getState().rightClickBehavior;
      if (behavior === 'paste') {
        pasteFromClipboard();
        return;
      }
      if (behavior === 'copyPaste') {
        if (term.hasSelection()) {
          copySelection();
          term.clearSelection();
        } else {
          pasteFromClipboard();
        }
        return;
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection: term.hasSelection() });
    };
    containerRef.current.addEventListener('contextmenu', handleContextMenu);

    // Copy-on-select (PuTTY-style), gated on the live setting: copy when a
    // mouse selection gesture ends with text selected. Silent on failure —
    // toasting every drag would be noise.
    const handleCopyOnSelect = () => {
      if (!useSettingsStore.getState().copyOnSelect) return;
      if (term.hasSelection()) void copyText(term.getSelection());
    };
    containerRef.current.addEventListener('mouseup', handleCopyOnSelect);

    ctxActionsRef.current = {
      copy: () => {
        copySelection();
        term.focus();
      },
      paste: () => pasteFromClipboard(),
      selectAll: () => {
        term.selectAll();
        term.focus();
      },
      clear: () => {
        term.clear();
        term.focus();
      },
    };

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

    // Async font loading: the initial fit() measures cell size with the
    // FALLBACK font — when the configured terminal font finishes loading the
    // glyph metrics change and the grid no longer fills the container ("the
    // screen doesn't stretch right") until some unrelated resize. Refit when
    // fonts land — twice, because xterm re-measures cell size during the first
    // resize and the corrected metrics need a second pass to settle.
    const refitTwice = () => {
      handleResize();
      requestAnimationFrame(() => handleResize());
    };
    const onFontsLoaded = () => refitTwice();
    if (document.fonts) {
      document.fonts.ready.then(onFontsLoaded).catch(() => {});
      document.fonts.addEventListener?.('loadingdone', onFontsLoaded);
    }

    // Same problem when the window moves to a display with different scaling:
    // devicePixelRatio changes glyph rasterization/cell size but fires no
    // resize event. matchMedia on the current resolution fires once per DPR
    // change; re-arm against the new value each time.
    let dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onDprChange = () => {
      dprQuery.removeEventListener('change', onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener('change', onDprChange);
      refitTwice();
    };
    dprQuery.addEventListener('change', onDprChange);

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
      document.fonts?.removeEventListener?.('loadingdone', onFontsLoaded);
      dprQuery.removeEventListener('change', onDprChange);
      zoomEl.removeEventListener('gesturestart', onGestureStart);
      zoomEl.removeEventListener('gesturechange', onGestureChange);
      zoomEl.removeEventListener('gestureend', onGestureEnd);
      zoomEl.removeEventListener('wheel', handleWheelZoom);
      zoomEl.removeEventListener('mousedown', resetKbSelection);
      zoomEl.removeEventListener('contextmenu', handleContextMenu);
      zoomEl.removeEventListener('mouseup', handleCopyOnSelect);
      ctxActionsRef.current = null;
      setCtxMenu(null);
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
          // Hold back a trailing incomplete: bare ESC; CSI with params
          // ([0-9:;<=>?]) and intermediates (0x20-0x2F, e.g. DECSCUSR's space);
          // an unterminated OSC string (no BEL/ESC yet — titles, OSC 52); or
          // ESC + intermediates (charset designation like ESC ( B). The old
          // pattern only knew CSI param bytes, so an OSC payload or charset
          // sequence split across batches leaked into the highlight path and
          // its injected SGR codes aborted xterm's half-parsed sequence.
          // Size cap: a rogue never-terminated OSC must not buffer forever.
          const incompleteEscape = text.match(
            /\x1b(?:\[[0-9:;<=>?]*[ -/]*|\][^\x07\x1b]*|[ -/]+)?$/
          );
          if (incompleteEscape && incompleteEscape[0].length < 8192) {
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
            // Match line-by-line over the batch. A burst flush hands us up to
            // ~256KB (see the 256*1024 threshold below); running a user regex over
            // the whole batch risks catastrophic backtracking (ReDoS) that pins
            // the main thread, and re-lowercasing / recompiling per trigger is
            // wasted work. The 'im' flag is line-anchored and terminal output is
            // line-oriented, so per-line testing keeps full-batch coverage and
            // anchor semantics while bounding each regex to a single line. The
            // lines are lowercased once here rather than once per keyword trigger.
            const lines = haystack.split('\n');
            const lowerLines = lines.map((l) => l.toLowerCase());
            for (const tr of triggers) {
              let matchText = '';
              if (tr.isRegex) {
                // Compile once and cache by pattern — recompiling on every ~8ms
                // flush is the bulk of the per-trigger waste.
                let rx = triggerRxRef.current.get(tr.pattern);
                if (!rx) {
                  try {
                    // 'm' so ^/$ anchor per line, matching user expectation.
                    rx = new RegExp(tr.pattern, 'im');
                    triggerRxRef.current.set(tr.pattern, rx);
                  } catch {
                    rx = undefined; // bad regex — ignore
                  }
                }
                if (rx) {
                  for (const line of lines) {
                    const m = line.match(rx);
                    if (m) { matchText = m[0]; break; }
                  }
                }
              } else {
                const needle = tr.pattern.toLowerCase();
                for (const lowerLine of lowerLines) {
                  if (lowerLine.includes(needle)) { matchText = tr.pattern; break; }
                }
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
          if (deviceTypeRef.current === 'generic' && autoDetectedRef.current === null) {
            const detected = highlighterRef.current.detectDeviceType(bufferRef.current);
            if (detected !== 'generic') {
              // Latch the vendor: build its highlighter once and stop re-detecting
              // (and re-sorting every grammar) on subsequent flushes, and stop the
              // active grammar thrashing as fingerprints scroll out of bufferRef.
              autoDetectedRef.current = detected;
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
            // Strip color codes first: \x1b[...m — if ESC remains, it's a control
            // sequence. ':' included for colon-form truecolor (38:2:R:G:Bm) —
            // without it those SGRs read as "non-color escape" and silently
            // switched highlighting off for the whole batch.
            const withoutColorAnsi = text.replace(/\x1b\[[0-9;:]*m/g, '');
            const hasNonColorEscape = withoutColorAnsi.includes('\x1b');

            if (hasDisruptiveChars || hasNonColorEscape) {
              // Write raw — preserves backspace, cursor movement, interactive echo
              term.write(text);
            } else {
              // Safe to highlight: strip device color ANSI, apply our syntax colors
              const stripped = text.replace(/\x1b\[[0-9;:]*m/g, '');
              // Split preserving line endings. Lone \r must be its own
              // delimiter — /(\r?\n)/ never captured a bare CR, so the
              // `part === '\r'` arm below was unreachable and a CR-overwrite
              // run ("50%\r60%") was fed to the highlighter as one line,
              // losing prompt/command position tracking after each CR.
              const parts = stripped.split(/(\r\n|\n|\r)/);
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
            // Pop-out WINDOWS skip all of this: their fresh store has no active
            // session, which read as "background output" and toasted the user
            // about the very session they were watching.
            const ss = useSessionStore.getState();
            const visibleInPane = ss.splitView && ss.splitPanes.includes(sessionId);
            if (
              !isPopOutWindow &&
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
            // While the pop-out seed replay holds flushing, bound the queue so
            // a fast-producing session can't grow it without limit for the
            // duration of the seed fetch. Dropping the OLDEST chunks loses the
            // least: the seed tail being fetched covers that same output.
            if (holdFlush) {
              while (pendingSize > 4 * 1024 * 1024 && pending.length > 1) {
                pendingSize -= pending[0].length;
                pending.shift();
              }
            }
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
          // The auto-detect window and trigger carry are pre-drop text too: left
          // alone they could fingerprint a vendor or fire an output trigger off
          // content straddling the disconnect.
          decoderRef.current = new TextDecoder('utf-8', { fatal: false });
          ansiCarryRef.current = '';
          bufferRef.current = '';
          triggerCarryRef.current = '';
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

    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    term.options.scrollback = scrollback;
    term.options.theme = terminalTheme;
    term.options.rightClickSelectsWord = rightClickBehavior === 'menu';

    // Only fit() when actually visible. A hidden (display:none) background tab, or
    // the main-window copy of a popped-out session, has a zero-size box — but
    // FitAddon reads the h-full/w-full parent's computed height/width as "100%"
    // (parseInt -> 100) and keeps the last cached cell size, landing on a bogus
    // ~10x5 geometry that fires resize_terminal and SIGWINCHes that session's PTY.
    // Mirror handleResize's guard; the ResizeObserver refits (0 -> size) when the
    // terminal becomes visible again.
    const el = containerRef.current;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      fitAddonRef.current?.fit();
    }
  }, [
    fontSize,
    fontFamily,
    cursorStyle,
    cursorBlink,
    scrollback,
    terminalTheme,
    rightClickBehavior,
  ]);

  const closeCtxMenu = () => setCtxMenu(null);
  const runCtxAction = (action: 'copy' | 'paste' | 'selectAll' | 'clear') => {
    setCtxMenu(null);
    ctxActionsRef.current?.[action]();
  };
  const menuItemClass =
    'w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:pointer-events-none flex items-center justify-between gap-4';
  const menuHintClass = 'text-[10px] text-[var(--text-secondary)]';

  return (
    <>
      <div
        ref={containerRef}
        className="w-full h-full"
        // Match the xterm theme's own background — hardcoding dark/light left
        // mismatched fringes around the cell grid on fixed schemes (Dracula,
        // Nord, Solarized, …).
        style={{ background: terminalTheme.background }}
      />
      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={closeCtxMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeCtxMenu();
            }}
          />
          <div
            className="fixed z-50 min-w-[180px] py-1 rounded-md border border-[var(--border-strong)] bg-[var(--bg-secondary)] shadow-xl"
            style={{
              left: Math.min(ctxMenu.x, Math.max(0, window.innerWidth - 190)),
              top: Math.min(ctxMenu.y, Math.max(0, window.innerHeight - 150)),
            }}
          >
            <button
              className={menuItemClass}
              disabled={!ctxMenu.hasSelection}
              onClick={() => runCtxAction('copy')}
            >
              <span>Copy</span>
              <span className={menuHintClass}>{isMac ? '⌘C' : 'Ctrl+Shift+C'}</span>
            </button>
            <button className={menuItemClass} onClick={() => runCtxAction('paste')}>
              <span>Paste</span>
              <span className={menuHintClass}>
                {isMac ? '⌘V' : isWindows ? 'Ctrl+V' : 'Ctrl+Shift+V'}
              </span>
            </button>
            <div className="my-1 border-t border-[var(--border-strong)]" />
            <button className={menuItemClass} onClick={() => runCtxAction('selectAll')}>
              <span>Select All</span>
            </button>
            <button className={menuItemClass} onClick={() => runCtxAction('clear')}>
              <span>Clear Buffer</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}
