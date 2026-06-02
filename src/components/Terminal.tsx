import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon } from 'xterm-addon-search';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/tauri';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { useTriggersStore } from '../store/triggersStore';
import { notify } from '../store/toastStore';
import { useTheme } from '../hooks/useTheme';
import { DeviceType } from '../types';
import { ArubaHighlighter, AnsiProcessor } from '../syntax';
import { registerSearchAdapter, unregisterSearchAdapter, createSearchAdapter } from '../utils/terminalSearch';
import 'xterm/css/xterm.css';

interface TerminalProps {
  sessionId: string;
  deviceType: DeviceType;
  onData?: (data: string) => void;
  onSend?: (data: string) => void;
}

export default function Terminal({ sessionId, deviceType, onSend }: TerminalProps) {
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
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const linksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(linksAddon);

    searchAddonRef.current = searchAddon;
    registerSearchAdapter(sessionId, createSearchAdapter(searchAddon));

    term.open(containerRef.current);

    // Load the WebGL renderer asynchronously (canvas fallback on failure).
    // Doing it here — rather than in a separate effect keyed on the loaded
    // addon — avoids disposing/recreating the whole terminal mid-session.
    let disposed = false;
    import('xterm-addon-webgl')
      .then(({ WebglAddon }) => {
        if (disposed || !terminalRef.current) return;
        try {
          const webgl = new WebglAddon();
          // If the GPU context is lost (sleep/resume, driver reset), dispose the
          // addon so xterm transparently falls back to the canvas/DOM renderer
          // instead of going permanently blank.
          webgl.onContextLoss(() => {
            webgl.dispose();
          });
          term.loadAddon(webgl);
        } catch {
          /* WebGL unsupported — stay on canvas */
        }
      })
      .catch(() => {});

    fitAddon.fit();

    // Handle input
    term.onData((data) => {
      onSend?.(data);
    });

    // Audible bell — gated on the live setting (xterm has no bell option, so we
    // play a short WebAudio blip on the BEL control char when enabled).
    term.onBell(() => {
      if (useSettingsStore.getState().bell) beep();
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      const { cols, rows } = term;
      // Notify backend of resize
      invoke('resize_terminal', { sessionId, cols, rows }).catch(() => {});
    };

    window.addEventListener('resize', handleResize);
    // Refit when the container itself resizes (panels opening, split view, etc.)
    const ro = new ResizeObserver(() => handleResize());
    ro.observe(containerRef.current);
    setTimeout(handleResize, 100);

    return () => {
      disposed = true;
      window.removeEventListener('resize', handleResize);
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
        const unlisten = await listen<{
          sessionId: string;
          data: number[];
        }>('terminal_data', (event) => {
          if (cancelled) return;
          if (event.payload.sessionId !== sessionId) return;
          if (!terminalRef.current) return;

          const bytes = new Uint8Array(event.payload.data);
          // Streaming decode keeps partial multibyte sequences buffered until
          // the next chunk completes them.
          const text = decoderRef.current.decode(bytes, { stream: true });
          if (!text) return;

          bufferRef.current += text;
          if (bufferRef.current.length > 5000) {
            bufferRef.current = bufferRef.current.slice(-3000);
          }

          // Output triggers: toast (+ optional beep) when a keyword/regex appears.
          const triggers = useTriggersStore.getState().triggers;
          if (triggers.length) {
            const now = Date.now();
            for (const tr of triggers) {
              let matchText = '';
              try {
                if (tr.isRegex) {
                  const m = text.match(new RegExp(tr.pattern, 'i'));
                  if (m) matchText = m[0];
                } else if (text.toLowerCase().includes(tr.pattern.toLowerCase())) {
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
          if (useSettingsStore.getState().syntaxHighlighting) {
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
        });

        unlistenFn = unlisten;
      } catch (err) {
        console.error('Failed to setup terminal data listener:', err);
      }
    };

    setupListener();

    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
      // Flush any bytes the streaming decoder is still holding (a multibyte
      // char that was only partially received before teardown).
      try {
        const tail = decoderRef.current.decode();
        if (tail && terminalRef.current) terminalRef.current.write(tail);
      } catch {
        /* ignore */
      }
    };
  }, [sessionId]);

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
        updateSessionConnection(sessionId, connected);
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
