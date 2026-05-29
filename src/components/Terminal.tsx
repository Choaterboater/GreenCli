import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon } from 'xterm-addon-search';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/tauri';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { useTheme } from '../hooks/useTheme';
import { ArubaHighlighter, AnsiProcessor } from '../syntax';
import { registerSearchAdapter, unregisterSearchAdapter, createSearchAdapter } from '../utils/terminalSearch';
import 'xterm/css/xterm.css';

interface TerminalProps {
  sessionId: string;
  deviceType: 'aruba-cx' | 'aruba-ap' | 'aruba-controller' | 'generic';
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
  const ansiProcessorRef = useRef<AnsiProcessor>(new AnsiProcessor());
  const bufferRef = useRef<string>('');
  const [webglAddon, setWebglAddon] = useState<any>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const { terminalTheme, isDark } = useTheme();
  const settings = useSettingsStore();
  const updateSessionConnection = useSessionStore((s) => s.updateSessionConnection);

  // Load WebGL addon dynamically
  useEffect(() => {
    let cancelled = false;
    import('xterm-addon-webgl').then(({ WebglAddon }) => {
      if (!cancelled) {
        setWebglAddon(() => WebglAddon);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Update highlighter when device type changes
  useEffect(() => {
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

    // Try WebGL renderer
    if (webglAddon) {
      try {
        const glAddon = new webglAddon();
        term.loadAddon(glAddon);
      } catch {
        // WebGL not supported, fallback to canvas
      }
    }

    fitAddon.fit();

    // Handle input
    term.onData((data) => {
      onSend?.(data);
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
    setTimeout(handleResize, 100);

    return () => {
      window.removeEventListener('resize', handleResize);
      unregisterSearchAdapter(sessionId);
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [sessionId, webglAddon]);

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
          const decoder = new TextDecoder('utf-8');
          const text = decoder.decode(bytes);

          bufferRef.current += text;
          if (bufferRef.current.length > 5000) {
            bufferRef.current = bufferRef.current.slice(-3000);
          }

          // Auto-detect device type from prompt patterns
          const detected = highlighterRef.current.detectDeviceType(bufferRef.current);
          if (detected !== deviceType && detected !== 'generic') {
            highlighterRef.current = ArubaHighlighter.forDeviceType(detected);
          }

          const term = terminalRef.current;

          if (settings.syntaxHighlighting) {
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
        unlistenRef.current = unlisten;
      } catch (err) {
        console.error('Failed to setup terminal data listener:', err);
      }
    };

    setupListener();

    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
      if (unlistenRef.current) unlistenRef.current();
    };
  }, [sessionId, deviceType, settings.syntaxHighlighting]);

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
      style={{ background: isDark ? '#0d1117' : '#ffffff' }}
    />
  );
}
