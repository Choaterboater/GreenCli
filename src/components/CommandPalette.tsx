import { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { WebviewWindow } from '@tauri-apps/api/window';
import { fuzzyScore } from '../utils';
import { notify } from '../store/toastStore';
import { useTheme } from '../hooks/useTheme';
import {
  Search,
  Plug,
  TerminalSquare,
  Globe,
  Sparkles,
  FileCode,
  Settings as SettingsIcon,
  PanelLeft,
  Radio,
  Columns2,
  Sun,
  Moon,
  ShieldCheck,
  HardDrive,
  HelpCircle,
  History,
  X,
  CornerDownLeft,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  CopyPlus,
  GitPullRequestArrow,
} from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { getTerminalActionAdapter } from '../utils/terminalActions';
import { openTerminalSearch } from '../utils/terminalSearch';
import { closeSessions } from '../utils/closeSessions';
import { shortcutLabel } from '../utils/shortcuts';
import { useSettingsStore } from '../store/settingsStore';
import { useRecentStore, timeAgo, RecentConnection } from '../store/recentStore';
import { ConnectionConfig } from '../types';
import { tabLabel } from '../utils/tabs';

interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: React.ReactNode;
  run: () => void;
}

interface CommandPaletteProps {
  onConnect: (config: ConnectionConfig) => void;
  /** Open another session to the same host as this tab. */
  onDuplicateTab: (sessionId: string) => void;
  onLocalShell: () => void;
  onConnectRecent: (recent: RecentConnection) => void;
}

export default function CommandPalette({ onConnect, onDuplicateTab, onLocalShell, onConnectRecent }: CommandPaletteProps) {
  // Narrow selectors — a whole-store subscription re-rendered the palette on
  // every session/UI change. Action callbacks read the store imperatively
  // (getState) so the memoized action list stays stable.
  const showCommandPalette = useSessionStore((s) => s.showCommandPalette);
  const setShowCommandPalette = useSessionStore((s) => s.setShowCommandPalette);
  const folders = useSessionStore((s) => s.folders);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const poppedSessions = useSessionStore((s) => s.poppedSessions);
  const vaultUnlocked = useSessionStore((s) => s.vaultUnlocked);
  const { theme } = useTheme(); // resolved dark/light, also when following the OS
  const setTheme = useSettingsStore((s) => s.setTheme);
  const recents = useRecentStore((s) => s.recents);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setShowCommandPalette(false);
    setQuery('');
    setSelected(0);
  };

  const actions: PaletteAction[] = useMemo(() => {
    const a: PaletteAction[] = [
      { id: 'quick-connect', label: 'Quick Connect', hint: shortcutLabel('quickConnect'), icon: <Plug size={14} />, run: () => useSessionStore.getState().setShowQuickConnect(true) },
      { id: 'local-shell', label: 'New Local Shell', keywords: 'terminal cli claude kimi', icon: <TerminalSquare size={14} />, run: onLocalShell },
      { id: 'toggle-editor', label: 'Toggle Config Editor', hint: shortcutLabel('editor'), icon: <FileCode size={14} />, run: () => useSessionStore.getState().toggleConfigEditor() },
      { id: 'toggle-api', label: 'Toggle API Explorer', hint: shortcutLabel('api'), icon: <Globe size={14} />, run: () => useSessionStore.getState().toggleApiExplorer() },
      { id: 'toggle-ai', label: 'Toggle AI Assistant', hint: shortcutLabel('ai'), icon: <Sparkles size={14} />, run: () => useSessionStore.getState().toggleAiAssistant() },
      { id: 'toggle-broadcast', label: 'Toggle Multi-send', keywords: 'send all multiple sessions broadcast subset', icon: <Radio size={14} />, run: () => useSessionStore.getState().toggleBroadcast() },
      { id: 'bulk-runner', label: 'Bulk Command Runner', keywords: 'run all devices batch collect csv', icon: <Radio size={14} />, run: () => useSessionStore.getState().setShowBulkRunner(true) },
      {
        id: 'import-hosts',
        label: 'Import Hosts…',
        keywords: 'import csv securecrt central mist ssh config migrate sessions inventory bulk add',
        icon: <Download size={14} />,
        run: () => useSessionStore.getState().openImportHosts(),
      },
      { id: 'change-jobs', label: 'Change Jobs', keywords: 'push config change many devices canary rollback commit confirmed checkpoint bulk deploy variables csv', icon: <GitPullRequestArrow size={14} />, run: () => useSessionStore.getState().setShowChangeJobs(true) },
      { id: 'sftp', label: 'SFTP File Transfer', keywords: 'sftp upload download file transfer scp', icon: <HardDrive size={14} />, run: () => useSessionStore.getState().setShowSftp(true) },
      {
        id: 'mcp-servers',
        label: 'MCP Servers',
        keywords: 'mcp tools model context protocol ai',
        icon: <Sparkles size={14} />,
        run: () => {
          useSessionStore.getState().setSettingsFocus('mcp');
          useSessionStore.getState().setShowSettings(true);
        },
      },
      {
        id: 'config-archive',
        label: 'Config Archive',
        keywords: 'golden baseline history diff snapshot',
        icon: <History size={14} />,
        run: () => {
          useSessionStore.getState().setShowConfigEditor(true);
          useSessionStore.getState().setShowArchive(true);
        },
      },
      {
        id: 'clear-terminal',
        label: 'Clear Active Terminal',
        keywords: 'clear screen wipe reset',
        icon: <TerminalSquare size={14} className="text-[var(--accent)]" />,
        run: () => {
          if (!activeSessionId) return;
          const adapter = getTerminalActionAdapter(activeSessionId);
          if (adapter) {
            adapter.clear();
          } else {
            // Terminal not mounted yet (still connecting / popped out) — say so
            // instead of closing the palette as if it worked.
            notify.warning('Nothing to clear', 'The active terminal is not ready.');
          }
        },
      },
      {
        id: 'close-all-tabs',
        label: 'Close All Sessions',
        keywords: 'close all tabs disconnect everything',
        icon: <X size={14} className="text-[var(--accent-danger)]" />,
        run: () => {
          // Popped-out sessions keep running in their own windows. One
          // question covers every still-connected session (confirmCloseConnected).
          void closeSessions(
            sessions.filter((s) => !poppedSessions.includes(s.sessionId)).map((s) => s.sessionId),
          );
        },
      },
      {
        id: 'toggle-split',
        label: 'Toggle Split View',
        keywords: 'pane side by side two terminals',
        icon: <Columns2 size={14} />,
        run: () => {
          useSessionStore.getState().toggleSplitView();
          setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
        },
      },
      { id: 'toggle-sidebar', label: 'Toggle Sidebar', hint: shortcutLabel('sidebar'), icon: <PanelLeft size={14} />, run: () => useSessionStore.getState().toggleSidebar() },
      // Zoom the terminal + config-editor font — same persisted setting as the
      // Ctrl+= / Ctrl+- / Ctrl+0 bindings (W2-11).
      {
        id: 'zoom-in',
        label: 'Increase font size (terminal + editor)',
        hint: shortcutLabel('zoomIn'),
        keywords: 'zoom bigger larger font size',
        icon: <ZoomIn size={14} />,
        run: () =>
          useSettingsStore.getState().setFontSize(Math.min(24, useSettingsStore.getState().fontSize + 1)),
      },
      {
        id: 'zoom-out',
        label: 'Decrease font size (terminal + editor)',
        hint: shortcutLabel('zoomOut'),
        keywords: 'zoom smaller font size',
        icon: <ZoomOut size={14} />,
        run: () => useSettingsStore.getState().setFontSize(Math.max(8, useSettingsStore.getState().fontSize - 1)),
      },
      {
        id: 'zoom-reset',
        label: 'Reset font size (terminal + editor)',
        hint: shortcutLabel('zoomReset'),
        keywords: 'zoom reset default font size',
        icon: <RotateCcw size={14} />,
        run: () => useSettingsStore.getState().setFontSize(14),
      },
      { id: 'search', label: 'Find in Terminal', hint: shortcutLabel('find'), keywords: 'search', icon: <Search size={14} />, run: () => openTerminalSearch() },
      { id: 'settings', label: 'Open Settings', hint: shortcutLabel('settings'), icon: <SettingsIcon size={14} />, run: () => useSessionStore.getState().setShowSettings(true) },
      { id: 'help', label: 'Help & Documentation', hint: shortcutLabel('help'), keywords: 'help docs guide setup how to configure', icon: <HelpCircle size={14} />, run: () => useSessionStore.getState().setShowHelp(true) },
      {
        id: 'vault',
        label: vaultUnlocked ? 'Lock credential vault' : 'Unlock credential vault',
        keywords: 'vault password credential secure',
        icon: <ShieldCheck size={14} />,
        run: () => {
          if (vaultUnlocked) {
            invoke('vault_lock').then(() => useSessionStore.getState().setVaultUnlocked(false)).catch(() => {});
          } else {
            useSessionStore.getState().setShowVaultUnlock(true);
          }
        },
      },
      {
        id: 'theme',
        label: `Switch to ${theme === 'dark' ? 'Light' : 'Dark'} theme`,
        keywords: 'theme dark light appearance',
        icon: theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />,
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
    ];

    // Recent connections → reconnect actions (below the built-in commands)
    for (const r of recents.slice(0, 5)) {
      a.push({
        id: `recent-${r.id}`,
        label: `Recent: ${r.name}`,
        hint: timeAgo(r.lastConnectedAt),
        keywords: `recent connection ${r.host ?? ''} ${r.username ?? ''} ${r.protocol}`,
        icon: <History size={14} className="text-[var(--accent)]" />,
        run: () => onConnectRecent(r),
      });
    }

    // Saved sessions → connect actions
    for (const folder of folders) {
      for (const item of folder.items) {
        a.push({
          id: `connect-${item.id}`,
          label: `Connect: ${item.name || item.host || 'session'}`,
          hint: item.protocol.toUpperCase(),
          keywords: `${item.host ?? ''} ${item.protocol} ${folder.name}`,
          icon: <Plug size={14} className="text-[var(--accent-success)]" />,
          run: () => onConnect(item),
        });
      }
    }

    // Open tabs → switch actions. Popped-out sessions live in their own OS
    // window — activating them here would blank the terminal area, so focus
    // their window instead (same guard as the tab strip).
    for (const s of sessions) {
      if (s.sessionId === activeSessionId) continue;
      const isPopped = poppedSessions.includes(s.sessionId);
      a.push({
        id: `goto-${s.sessionId}`,
        label: `${isPopped ? 'Focus window' : 'Go to tab'}: ${tabLabel(s)}`,
        keywords: `tab switch ${s.config.host ?? ''} ${s.promptHost ?? ''}`,
        icon: <TerminalSquare size={14} className="text-[var(--accent-info)]" />,
        run: () => {
          if (isPopped) {
            WebviewWindow.getByLabel(`popout-${s.sessionId}`)?.setFocus();
          } else {
            useSessionStore.getState().setActiveSession(s.sessionId);
          }
        },
      });
    }

    if (activeSessionId) {
      a.push({
        id: 'duplicate-tab',
        label: 'Duplicate Current Tab',
        keywords: 'new session same host another shell clone copy',
        icon: <CopyPlus size={14} className="text-[var(--accent)]" />,
        run: () => onDuplicateTab(activeSessionId),
      });
    }

    // Close current tab (not for popped-out sessions — closing from here would
    // disconnect the backend while their pop-out window stays open)
    if (activeSessionId && !poppedSessions.includes(activeSessionId)) {
      a.push({
        id: 'close-tab',
        label: 'Close Current Tab',
        hint: shortcutLabel('closeTab'),
        icon: <X size={14} className="text-[var(--accent-danger)]" />,
        run: () => {
          void closeSessions([activeSessionId]);
        },
      });
    }

    return a;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, sessions, activeSessionId, poppedSessions, theme, vaultUnlocked, recents, onConnect, onDuplicateTab, onLocalShell, onConnectRecent]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return actions;
    // Fuzzy, ranked (handles multi-word + abbreviations, not just substrings).
    return actions
      .map((a) => ({ a, score: fuzzyScore(q, `${a.label} ${a.keywords ?? ''} ${a.hint ?? ''}`) }))
      .filter((x) => x.score >= 0)
      .sort((x, y) => y.score - x.score)
      .map((x) => x.a);
  }, [actions, query]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setSelected(0), [query]);

  // Keep the selected row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!showCommandPalette) return null;

  const runAt = (i: number) => {
    const action = filtered[i];
    if (!action) return;
    close();
    // defer so state updates from close() don't clobber the action
    setTimeout(() => action.run(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(selected);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Don't let the keydown bubble to window-level Escape listeners (e.g.
      // HelpPanel's) — one press should close only the palette.
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] bg-[var(--scrim)] backdrop-blur-sm" onClick={close}>
      <div
        className="w-[560px] max-w-[90vw] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--bg-tertiary)]">
          <Search size={15} className="text-[var(--text-secondary)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command or search sessions…"
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
          />
          <kbd className="text-[10px] text-[var(--text-muted)] border border-[var(--border)] rounded px-1">esc</kbd>
        </div>

        <div ref={listRef} role="listbox" aria-label="Commands" className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">No matching commands</p>
          )}
          {filtered.map((a, i) => (
            <button
              key={a.id}
              data-idx={i}
              role="option"
              aria-selected={i === selected}
              onMouseEnter={() => setSelected(i)}
              onClick={() => runAt(i)}
              className={`flex items-center gap-3 w-full px-4 py-2 text-left transition-colors ${
                i === selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-tertiary)]'
              }`}
            >
              <span className="text-[var(--text-secondary)] flex-shrink-0">{a.icon}</span>
              <span className="flex-1 text-sm text-[var(--text-primary)] truncate">{a.label}</span>
              {a.hint && (
                <kbd className="text-[10px] text-[var(--text-muted)] border border-[var(--border)] rounded px-1 flex-shrink-0">
                  {a.hint}
                </kbd>
              )}
              {i === selected && <CornerDownLeft size={12} className="text-[var(--text-muted)] flex-shrink-0" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
